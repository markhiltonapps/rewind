"""FastAPI application for the rewind-proxy service.

Exposes three authenticated routes that enforce invite-gating, usage-cap
checks, call Gemini, and record metered usage — plus a health-check
endpoint for Cloud Run.

Dependency injection via FastAPI's dependency_overrides lets tests swap
in a FakeDB without touching real Supabase.
"""

from __future__ import annotations

from fastapi import FastAPI, Depends, Header, UploadFile, File, Form
from pydantic import BaseModel

from app import audio_chunk, gemini
from app.auth import AuthedUser, verify_jwt
from app.db import SupabaseDB
from app.gates import assert_invited, assert_under_cap
from app.meter import record_usage

app = FastAPI(title="rewind-proxy")


# ---------------------------------------------------------------------------
# DB dependency
# ---------------------------------------------------------------------------

def get_db() -> SupabaseDB:
    """Yield a fresh SupabaseDB.  Tests override this via dependency_overrides."""
    return SupabaseDB()


# ---------------------------------------------------------------------------
# Health check (no auth — required by Cloud Run)
# ---------------------------------------------------------------------------

@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/v1/diag")
async def diag():
    """Report the transcription-splitting configuration.

    Exists because the failure it guards against is silent: without
    ffmpeg, transcribe() quietly falls back to a single Gemini call and
    long meetings start timing out again with no obvious cause. This
    makes "is chunking actually active?" answerable without a redeploy.

    Unauthenticated on purpose -- it exposes no secrets and no user
    data, and needs to work when auth is what's broken. Note /healthz
    is intercepted by Google's front end on run.app hosts, so this
    doubles as a reachability check.
    """
    return {
        "ok": True,
        "ffmpeg": audio_chunk.ffmpeg_available(),
        "chunk_seconds": audio_chunk.CHUNK_SECONDS,
        "min_split_seconds": audio_chunk.MIN_SPLIT_SECONDS,
        "max_concurrency": audio_chunk.MAX_CONCURRENCY,
    }


# ---------------------------------------------------------------------------
# Shared auth + gate pipeline (called at the top of every route)
# ---------------------------------------------------------------------------

async def _authenticate_and_gate(authorization: str | None, db) -> AuthedUser:
    """Run the full verify → invite-gate → cap-gate pipeline."""
    user = await verify_jwt(authorization)
    await assert_invited(user.email, db)
    await assert_under_cap(user.user_id, db)
    return user


# ---------------------------------------------------------------------------
# POST /v1/transcribe — multipart form
# ---------------------------------------------------------------------------

@app.post("/v1/transcribe")
async def transcribe_route(
    audio: UploadFile = File(...),
    meeting_id: str = Form(...),
    duration_seconds: float = Form(...),
    authorization: str | None = Header(default=None),
    db=Depends(get_db),
):
    user = await _authenticate_and_gate(authorization, db)
    audio_bytes = await audio.read()
    mime = audio.content_type or "audio/wav"
    transcript = await gemini.transcribe(audio_bytes, mime)
    # raw_units = audio duration in seconds (audio-second billing unit)
    raw_units = duration_seconds
    await record_usage(db, user, "transcribe", raw_units)
    return {"transcript": transcript}


# ---------------------------------------------------------------------------
# POST /v1/summarize — JSON body
# ---------------------------------------------------------------------------

class SummarizeRequest(BaseModel):
    meeting_id: str
    text: str
    model: str = "gemini-2.5-flash"
    # Per-meeting or folder-default instructions, appended to the base
    # prompt. Optional so older app builds -- which never send it --
    # keep working unchanged.
    custom_prompt: str | None = None


@app.post("/v1/summarize")
async def summarize_route(
    body: SummarizeRequest,
    authorization: str | None = Header(default=None),
    db=Depends(get_db),
):
    user = await _authenticate_and_gate(authorization, db)
    summary = await gemini.summarize(
        body.text, model=body.model, custom_prompt=body.custom_prompt
    )
    # raw_units ≈ token count estimate: len(text) / 4 chars-per-token (rough average)
    raw_units = len(body.text) / 4
    await record_usage(db, user, "summarize", raw_units)
    return {"summary": summary}


# ---------------------------------------------------------------------------
# POST /v1/embed — JSON body
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    meeting_id: str
    texts: list[str]


@app.post("/v1/embed")
async def embed_route(
    body: EmbedRequest,
    authorization: str | None = Header(default=None),
    db=Depends(get_db),
):
    user = await _authenticate_and_gate(authorization, db)
    embeddings = await gemini.embed(body.texts)
    # raw_units ≈ total token count: sum of char lengths / 4 chars-per-token
    raw_units = sum(len(t) for t in body.texts) / 4
    await record_usage(db, user, "embed", raw_units)
    return {"embeddings": embeddings}
