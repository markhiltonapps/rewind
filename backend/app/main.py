from fastapi import FastAPI, File, HTTPException, BackgroundTasks, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator
import uuid
import uvicorn
from typing import Optional, List
import logging
import os
from dotenv import load_dotenv
from db import DatabaseManager
import io
import json
from threading import Lock
from transcript_processor import TranscriptProcessor
import time
import asyncio
import aiosqlite
from datetime import datetime, timezone


def serialize_sqlite_timestamp(ts_str):
    """Phase 3 Task 5 fix: convert SQLite's bare `datetime('now')` format
    ("YYYY-MM-DD HH:MM:SS", UTC by SQLite convention but with no
    timezone marker) to ISO 8601 with explicit "+00:00" offset.

    Without the marker, JS `new Date(...)` in V8/Chromium parses the
    string as LOCAL time — for a Houston user (UTC-5) a meeting saved
    at 7:24 PM (stored as May 4 00:24 UTC) re-parses as May 4 00:24
    local, landing in tomorrow's local-day window and mis-bucketing
    in the sidebar.

    Returns None on null input. Pass-through if the input already has
    a timezone marker (T+T or trailing Z / +HH:MM) — defensive against
    backend code paths that already produce ISO-formatted timestamps.
    """
    if not ts_str:
        return None
    s = str(ts_str)
    if 'T' in s or s.endswith('Z') or '+' in s[10:] or s[10:].count('-') > 0:
        # Already looks ISO-ish — leave alone.
        return s
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.isoformat()  # "2026-05-04T00:24:13+00:00"
    except ValueError:
        # Unknown format — pass through rather than 500.
        logger.warning(f"serialize_sqlite_timestamp: unrecognized format {s!r}")
        return s

# Load environment variables
# Phase 8 Task 2: in addition to the default .env-in-cwd lookup (dev),
# also load a .env from the user-data dir when present. This lets a
# frozen sidecar pick up an override file the user drops alongside
# the AppData DB without rebuilding the MSI.
load_dotenv()
try:
    from paths import dotenv_path, is_frozen  # noqa: E402
    if is_frozen():
        _appdata_env = dotenv_path()
        if _appdata_env.is_file():
            load_dotenv(_appdata_env, override=False)
except Exception:
    # Bootstrap: paths.py missing or env layout unexpected. Don't
    # crash startup over a missing override file.
    pass

# Configure logger with line numbers and function names
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Create console handler with formatting
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)

# Create formatter with line numbers and function names
formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - [%(filename)s:%(lineno)d - %(funcName)s()] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
console_handler.setFormatter(formatter)

# Add handler to logger if not already added
if not logger.handlers:
    logger.addHandler(console_handler)

# Phase 8 Task 6: file-based logging for frozen sidecar builds.
# The MSI release has no console, so stderr writes are dropped on the
# floor. Without this, ANY tester-reported error is undebuggable
# because we have nothing to look at. Writes to
# %APPDATA%\com.neatoventures.rewind\logs\backend.log with rotation
# (5 files × 5MB = 25MB cap). Skipped in dev where the console is
# the natural log sink.
try:
    from paths import is_frozen, ensure_user_data_dir  # noqa: E402
    from logging.handlers import RotatingFileHandler  # noqa: E402

    if is_frozen():
        _log_dir = ensure_user_data_dir() / "logs"
        _log_dir.mkdir(parents=True, exist_ok=True)
        _file_handler = RotatingFileHandler(
            _log_dir / "backend.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=4,
            encoding="utf-8",
        )
        _file_handler.setLevel(logging.INFO)
        _file_handler.setFormatter(formatter)
        # Attach to BOTH our logger AND the root logger so output
        # from uvicorn, aiosqlite, google-genai etc. also lands in
        # the file. Otherwise the file would be eerily quiet.
        logger.addHandler(_file_handler)
        logging.getLogger().addHandler(_file_handler)
        logger.info("File logging initialized at %s", _log_dir)
except Exception as _log_setup_err:
    # Never let logging setup crash startup.
    print(f"[startup] file-log setup failed: {_log_setup_err}")

app = FastAPI(
    title="Meeting Summarizer API",
    description="API for processing and summarizing meeting transcripts",
    version="1.0.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # Allow all origins for testing
    allow_credentials=True,
    allow_methods=["*"],     # Allow all methods
    allow_headers=["*"],     # Allow all headers
    max_age=3600,            # Cache preflight requests for 1 hour
)

# Global database manager instance for meeting management endpoints
db = DatabaseManager()

# Phase 7 Task 1: bring up the RAG embedding tables (transcript_embeddings
# + transcript_embeddings_vec). Idempotent — safe on every boot.
import embeddings as _embeddings  # noqa: E402
import costs as _costs  # noqa: E402
try:
    _embeddings.init_schema(db.db_path)
except Exception as _e:  # pragma: no cover - defensive
    logger.warning(f"[embeddings] schema init failed: {_e}")


async def _get_gemini_api_key() -> Optional[str]:
    """Fetch the Gemini key, in priority order:

      1. ``GEMINI_API_KEY`` env var (dev override)
      2. ``settings.geminiApiKey`` in the DB (user-entered override)
      3. ``keys.BUNDLED_GEMINI_KEY`` (bundled with the MSI)
      4. None

    Phase 8 Task 2: the bundled fallback lets end users on the
    packaged MSI use Gemini features without ever seeing a key prompt
    — Mark pays for those calls. Power users can still override by
    typing their own key into Settings.
    """
    env_key = os.environ.get("GEMINI_API_KEY")
    if env_key:
        return env_key
    try:
        async with aiosqlite.connect(db.db_path) as conn:
            async with conn.execute(
                "SELECT geminiApiKey FROM settings WHERE id = '1'"
            ) as cur:
                row = await cur.fetchone()
                if row and row[0]:
                    return row[0]
    except Exception:
        pass
    try:
        from keys import BUNDLED_GEMINI_KEY  # noqa: E402
        if BUNDLED_GEMINI_KEY:
            return BUNDLED_GEMINI_KEY
    except Exception:
        pass
    return None


def _spawn_embed_meeting(meeting_id: str) -> None:
    """Fire-and-forget embed job. Called from /save-transcript and
    after summary completion. Failures are logged but never bubble
    up to the user-facing request."""
    async def _go():
        try:
            key = await _get_gemini_api_key()
            if not key:
                logger.info(
                    "[embeddings] %s: no GEMINI_API_KEY, skipping",
                    meeting_id,
                )
                return
            await _embeddings.embed_meeting(db.db_path, meeting_id, key)
        except Exception as e:
            logger.warning(
                "[embeddings] embed_meeting %s failed: %s", meeting_id, e
            )

    try:
        asyncio.get_event_loop().create_task(_go())
    except RuntimeError:
        # No running loop (shouldn't happen inside FastAPI handlers
        # but defensive); fall back to a fresh background runner.
        asyncio.run(_go())

# New Pydantic models for meeting management
class Transcript(BaseModel):
    id: str
    text: str
    timestamp: str

class TagSummary(BaseModel):
    """Phase 3 Task 7: tag attached to a meeting (no usage_count —
    that's only relevant for the bare /tags endpoint)."""
    id: str
    name: str


class MeetingResponse(BaseModel):
    id: str
    title: str
    # Phase 3 Task 5: surfaced for sidebar date-bucket grouping
    # (Today / Yesterday / This Week / Earlier). Was already selected
    # in get_all_meetings; just wasn't being returned.
    created_at: str
    # Phase 3 Task 7: organization. folder_id is null when the
    # meeting is uncategorized. tags can be empty.
    folder_id: Optional[str] = None
    tags: List[TagSummary] = []

class MeetingDetailsResponse(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    # Phase 3 Task 7: same organization fields as the list response.
    folder_id: Optional[str] = None
    tags: List[TagSummary] = []
    transcripts: List[Transcript]

class MeetingTitleUpdate(BaseModel):
    meeting_id: str
    title: str
    # Phase 3 Task 6: reject empty/whitespace-only titles after trim
    # and cap at 200 chars so a runaway client paste doesn't bloat the
    # row. Returns the trimmed value so the DB stores the canonical
    # form (no leading/trailing whitespace).
    @field_validator('title')
    @classmethod
    def title_not_blank(cls, v: str) -> str:
        if v is None:
            raise ValueError('title is required')
        trimmed = v.strip()
        if not trimmed:
            raise ValueError('title cannot be blank')
        if len(trimmed) > 200:
            raise ValueError('title cannot exceed 200 characters')
        return trimmed

class DeleteMeetingRequest(BaseModel):
    meeting_id: str


# ---------- Phase 3 Task 7: folders + tags request models ----------

def _trim_required(field_name: str, max_len: int):
    """Common validator builder: strip whitespace, reject empty, cap
    length. Returns a classmethod suitable for `@field_validator`.
    """
    def validate(cls, v):
        if v is None:
            raise ValueError(f'{field_name} is required')
        trimmed = v.strip()
        if not trimmed:
            raise ValueError(f'{field_name} cannot be blank')
        if len(trimmed) > max_len:
            raise ValueError(f'{field_name} cannot exceed {max_len} characters')
        return trimmed
    return classmethod(validate)


class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None
    _v_name = field_validator('name')(_trim_required('name', 100))


class FolderUpdate(BaseModel):
    """Phase 3 Task 9: PATCH semantics. Both fields are optional and
    independently set/cleared. Use ``model_fields_set`` on the endpoint
    side to distinguish "not provided" (skip) from "set to null"
    (clear). default_prompt_id=None explicitly clears the folder
    default; omitting it leaves the existing value untouched."""
    name: Optional[str] = None
    default_prompt_id: Optional[int] = None

    @field_validator('name')
    @classmethod
    def _trim_name(cls, v):
        # name=None means "no rename"; only validate when a string was
        # provided.
        if v is None:
            return v
        trimmed = v.strip()
        if not trimmed:
            raise ValueError('name cannot be blank')
        if len(trimmed) > 100:
            raise ValueError('name cannot exceed 100 characters')
        return trimmed


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: Optional[str] = None
    created_at: str
    # Phase 3 Task 9: per-folder default summary prompt. id is the FK
    # into saved_prompts.id; name + category are denormalised from the
    # joined row so the sidebar / Settings can render the prompt
    # without an extra fetch. All three are NULL when no default is
    # set or when the referenced prompt has been deleted (the FK's
    # ON DELETE SET NULL clears the id).
    default_prompt_id: Optional[int] = None
    default_prompt_name: Optional[str] = None
    default_prompt_category: Optional[str] = None


class TagCreate(BaseModel):
    name: str
    _v_name = field_validator('name')(_trim_required('name', 50))


class TagResponse(BaseModel):
    id: str
    name: str
    created_at: str
    usage_count: int = 0


class MeetingFolderUpdate(BaseModel):
    """Body for PATCH /meetings/{id}/folder. folder_id=None
    uncategorizes the meeting."""
    folder_id: Optional[str] = None


class MeetingTagAdd(BaseModel):
    """Body for POST /meetings/{id}/tags. Either tag_id (attach an
    existing tag) or name (create-and-attach in one call). Provide
    one or the other; if both are provided, tag_id wins."""
    tag_id: Optional[str] = None
    name: Optional[str] = None

    @model_validator(mode='after')
    def either_id_or_name(self):
        if not self.tag_id and not (self.name and self.name.strip()):
            raise ValueError('Provide either tag_id or a non-empty name')
        if self.name is not None:
            self.name = self.name.strip()
            if self.name and len(self.name) > 50:
                raise ValueError('name cannot exceed 50 characters')
        return self

class SaveTranscriptRequest(BaseModel):
    meeting_title: str
    transcripts: List[Transcript]
    # Phase 2b: optional metadata about how this recording was triggered.
    # Manual recordings omit these and the backend defaults to "manual".
    detection_source: Optional[str] = None
    detection_confidence: Optional[str] = None
    # Phase 2b round 5: optional caller-supplied meeting id. Rust generates
    # this at StartRecording so the frontend can navigate to the right URL
    # before the POST round-trips. If absent, the handler falls back to a
    # server-generated timestamp id.
    meeting_id: Optional[str] = None

class SaveModelConfigRequest(BaseModel):
    provider: str
    model: str
    whisperModel: str
    apiKey: Optional[str] = None

class TranscriptRequest(BaseModel):
    """Request model for transcript text, updated with meeting_id"""
    text: str
    model: str
    model_name: str
    meeting_id: str
    chunk_size: Optional[int] = 5000
    overlap: Optional[int] = 1000

class SummaryProcessor:
    """Handles the processing of summaries in a thread-safe way"""
    def __init__(self):
        try:
            self.db = DatabaseManager()

            logger.info("Initializing SummaryProcessor components")
            self.transcript_processor = TranscriptProcessor()
            logger.info("SummaryProcessor initialized successfully (core components)")
        except Exception as e:
            logger.error(f"Failed to initialize SummaryProcessor: {str(e)}", exc_info=True)
            raise

    async def process_transcript(
        self,
        text: str,
        model: str,
        model_name: str,
        chunk_size: int = 5000,
        overlap: int = 1000,
        custom_prompt: Optional[str] = None,
        meeting_id: Optional[str] = None,
    ) -> tuple:
        """Process a transcript text"""
        try:
            if not text:
                raise ValueError("Empty transcript text provided")

            # Validate chunk_size and overlap
            if chunk_size <= 0:
                raise ValueError("chunk_size must be positive")
            if overlap < 0:
                raise ValueError("overlap must be non-negative")
            if overlap >= chunk_size:
                overlap = chunk_size - 1  # Ensure overlap is less than chunk_size

            # Ensure step size is positive
            step_size = chunk_size - overlap
            if step_size <= 0:
                chunk_size = overlap + 1  # Adjust chunk_size to ensure positive step

            logger.info(f"Processing transcript of length {len(text)} with chunk_size={chunk_size}, overlap={overlap}")
            num_chunks, all_json_data = await self.transcript_processor.process_transcript(
                text=text,
                model=model,
                model_name=model_name,
                chunk_size=chunk_size,
                overlap=overlap,
                custom_prompt=custom_prompt,
                meeting_id=meeting_id,
            )
            logger.info(f"Successfully processed transcript into {num_chunks} chunks")

            return num_chunks, all_json_data
        except Exception as e:
            logger.error(f"Error processing transcript: {str(e)}", exc_info=True)
            raise

    def cleanup(self):
        """Cleanup resources"""
        try:
            logger.info("Cleaning up resources")
            if hasattr(self, 'transcript_processor'):
                self.transcript_processor.cleanup()
            logger.info("Cleanup completed successfully")
        except Exception as e:
            logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

# Initialize processor
processor = SummaryProcessor()

# New meeting management endpoints
@app.get("/get-meetings", response_model=List[MeetingResponse])
async def get_meetings():
    """Get all meetings with their basic information"""
    try:
        meetings = await db.get_all_meetings()
        return [
            {
                "id": meeting["id"],
                "title": meeting["title"],
                # Phase 3 Task 5 fix: normalize SQLite's bare timestamp
                # to ISO 8601 with explicit UTC marker so the frontend's
                # date-bucket grouping doesn't mis-parse it as local.
                "created_at": serialize_sqlite_timestamp(meeting["created_at"]),
                # Phase 3 Task 7: organization fields. folder_id may be
                # null (uncategorized); tags may be empty.
                "folder_id": meeting.get("folder_id"),
                "tags": meeting.get("tags", []),
            }
            for meeting in meetings
        ]
    except Exception as e:
        logger.error(f"Error getting meetings: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-meeting/{meeting_id}", response_model=MeetingDetailsResponse)
async def get_meeting(meeting_id: str):
    """Get a specific meeting by ID with all its details"""
    try:
        meeting = await db.get_meeting(meeting_id)
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return meeting
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/save-meeting-title")
async def save_meeting_title(data: MeetingTitleUpdate):
    """Save a meeting title.

    Phase 3 Task 6: returns 404 when the meeting_id doesn't exist
    (previously returned 200 even for unknown ids — silent no-op was
    a footgun). The pydantic validator on `title` rejects empty /
    blank / >200-char input with 422 before this handler runs.
    """
    try:
        updated = await db.update_meeting_title(data.meeting_id, data.title)
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=f"Meeting with id {data.meeting_id} not found",
            )
        return {
            "status": "saved",
            "meeting_id": data.meeting_id,
            "title": data.title,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving meeting title: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/delete-meeting")
async def delete_meeting(data: DeleteMeetingRequest):
    """Delete a meeting and all its associated data"""
    try:
        success = await db.delete_meeting(data.meeting_id)
        if success:
            # Phase 7 Task 1: also drop embedding chunks. The
            # transcript_embeddings table has no FK to meetings (so
            # the embeddings module can ship without modifying db.py
            # migrations), so we clean up explicitly here. Errors
            # don't roll back the delete — orphaned chunks are
            # harmless beyond storage cost.
            try:
                await _embeddings.delete_meeting_embeddings(
                    db.db_path, data.meeting_id
                )
            except Exception as e:
                logger.warning(
                    f"[embeddings] cleanup after delete-meeting "
                    f"{data.meeting_id} failed: {e}"
                )
            return {"message": "Meeting deleted successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to delete meeting")
    except Exception as e:
        logger.error(f"Error deleting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# Phase 3 Task 7: folders + tags
# ============================================================

def _serialize_folder(f: dict) -> dict:
    """Phase 3 Task 9: shared shape for /folders responses."""
    return {
        "id": f["id"],
        "name": f["name"],
        "parent_id": f["parent_id"],
        "created_at": serialize_sqlite_timestamp(f["created_at"]),
        "default_prompt_id": f.get("default_prompt_id"),
        "default_prompt_name": f.get("default_prompt_name"),
        "default_prompt_category": f.get("default_prompt_category"),
    }


@app.get("/folders", response_model=List[FolderResponse])
async def list_folders():
    try:
        folders = await db.list_folders()
        return [_serialize_folder(f) for f in folders]
    except Exception as e:
        logger.error(f"Error listing folders: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/folder-defaults")
async def list_folder_defaults():
    """Phase 3 Task 9: convenience endpoint for the Settings page's
    Folder Defaults table. Returns one row per folder with the
    folder's id + name and its currently-assigned default prompt's id
    + name + category (or None). Saves the UI from paginating /folders
    + /saved-prompts and joining client-side."""
    try:
        folders = await db.list_folders()
        return [
            {
                "folder_id": f["id"],
                "folder_name": f["name"],
                "default_prompt_id": f.get("default_prompt_id"),
                "default_prompt_name": f.get("default_prompt_name"),
                "default_prompt_category": f.get("default_prompt_category"),
            }
            for f in folders
        ]
    except Exception as e:
        logger.error(f"Error listing folder defaults: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/folders", response_model=FolderResponse)
async def create_folder(body: FolderCreate):
    folder_id = uuid.uuid4().hex
    try:
        await db.create_folder(folder_id, body.name, body.parent_id)
        # Re-fetch to return the canonical row (created_at populated).
        folders = await db.list_folders()
        for f in folders:
            if f["id"] == folder_id:
                return _serialize_folder(f)
        # Shouldn't happen — the row we just inserted should be there.
        raise HTTPException(status_code=500, detail="Folder created but not found on read-back")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(folder_id: str, body: FolderUpdate):
    """Phase 3 Task 9: partial update. Either field may be present
    independently. default_prompt_id=None explicitly clears the
    folder's default; omit the field to leave it untouched."""
    try:
        provided = body.model_fields_set
        if not provided:
            raise HTTPException(status_code=400, detail="No fields to update")

        # Confirm the folder exists up front so we can return a clean
        # 404 even when only default_prompt_id is being set.
        folders = await db.list_folders()
        existing = next((f for f in folders if f["id"] == folder_id), None)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")

        if "name" in provided and body.name is not None:
            await db.rename_folder(folder_id, body.name)

        if "default_prompt_id" in provided:
            await db.set_folder_default_prompt(folder_id, body.default_prompt_id)

        # Re-read so denormalised join fields reflect the new value.
        folders = await db.list_folders()
        for f in folders:
            if f["id"] == folder_id:
                return _serialize_folder(f)
        raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found after update")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    try:
        ok = await db.delete_folder(folder_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")
        return {"status": "deleted", "folder_id": folder_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tags", response_model=List[TagResponse])
async def list_tags():
    try:
        tags = await db.list_tags()
        return [
            {
                "id": t["id"],
                "name": t["name"],
                "created_at": serialize_sqlite_timestamp(t["created_at"]),
                "usage_count": t["usage_count"],
            }
            for t in tags
        ]
    except Exception as e:
        logger.error(f"Error listing tags: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tags", response_model=TagResponse)
async def create_tag(body: TagCreate):
    """Create a tag, or return the existing one if a tag with the
    same case-insensitive name already exists. Idempotent — clients
    can POST the same name repeatedly without 409s."""
    try:
        existing = await db.find_tag_by_name(body.name)
        if existing:
            tags = await db.list_tags()
            for t in tags:
                if t["id"] == existing["id"]:
                    return {
                        "id": t["id"],
                        "name": t["name"],
                        "created_at": serialize_sqlite_timestamp(t["created_at"]),
                        "usage_count": t["usage_count"],
                    }
        tag_id = uuid.uuid4().hex
        await db.create_tag(tag_id, body.name)
        tags = await db.list_tags()
        for t in tags:
            if t["id"] == tag_id:
                return {
                    "id": t["id"],
                    "name": t["name"],
                    "created_at": serialize_sqlite_timestamp(t["created_at"]),
                    "usage_count": t["usage_count"],
                }
        raise HTTPException(status_code=500, detail="Tag created but not found on read-back")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/tags/{tag_id}")
async def delete_tag(tag_id: str):
    try:
        ok = await db.delete_tag(tag_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
        return {"status": "deleted", "tag_id": tag_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/meetings/{meeting_id}/folder")
async def set_meeting_folder(meeting_id: str, body: MeetingFolderUpdate):
    """Assign a meeting to a folder, or pass folder_id=null in the
    body to uncategorize."""
    try:
        # Validate the target folder exists if non-null. ON DELETE SET NULL
        # would normally protect us from dangling refs, but UPDATE doesn't
        # cascade — so check up front.
        if body.folder_id is not None:
            folders = await db.list_folders()
            if not any(f["id"] == body.folder_id for f in folders):
                raise HTTPException(status_code=404, detail=f"Folder {body.folder_id} not found")
        ok = await db.set_meeting_folder(meeting_id, body.folder_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Meeting {meeting_id} not found")
        return {
            "status": "saved",
            "meeting_id": meeting_id,
            "folder_id": body.folder_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting meeting folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/meetings/{meeting_id}/tags")
async def add_meeting_tag(meeting_id: str, body: MeetingTagAdd):
    """Attach a tag to a meeting. If `name` is provided (and `tag_id`
    isn't), create-or-find the tag by name (case-insensitive) and
    attach it. Returns the attached tag and the meeting's full tag
    list."""
    try:
        # Ensure the meeting exists. Otherwise the FK check on the
        # junction table would fail silently in our INSERT OR IGNORE
        # path.
        existing_meeting = await db.get_meeting(meeting_id)
        if not existing_meeting:
            raise HTTPException(status_code=404, detail=f"Meeting {meeting_id} not found")

        tag_id = body.tag_id
        if not tag_id:
            # Create-or-find by name.
            existing = await db.find_tag_by_name(body.name)
            if existing:
                tag_id = existing["id"]
            else:
                tag_id = uuid.uuid4().hex
                await db.create_tag(tag_id, body.name)
        else:
            # Validate the tag exists.
            tags = await db.list_tags()
            if not any(t["id"] == tag_id for t in tags):
                raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")

        ok = await db.add_meeting_tag(meeting_id, tag_id)
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to attach tag")

        meeting_tags = await db.get_meeting_tags(meeting_id)
        attached = next((t for t in meeting_tags if t["id"] == tag_id), None)
        return {
            "status": "attached",
            "meeting_id": meeting_id,
            "tag": attached,
            "tags": meeting_tags,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding meeting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/meetings/{meeting_id}/tags/{tag_id}")
async def remove_meeting_tag(meeting_id: str, tag_id: str):
    """Detach a tag from a meeting. The tag itself stays — only the
    junction row is removed."""
    try:
        ok = await db.remove_meeting_tag(meeting_id, tag_id)
        if not ok:
            raise HTTPException(
                status_code=404,
                detail=f"Tag {tag_id} is not attached to meeting {meeting_id}",
            )
        meeting_tags = await db.get_meeting_tags(meeting_id)
        return {
            "status": "detached",
            "meeting_id": meeting_id,
            "tag_id": tag_id,
            "tags": meeting_tags,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing meeting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================
# Phase 6 Task 1: global search across meetings + transcripts
# ============================================================


class SearchResult(BaseModel):
    meeting_id: str
    title: str
    created_at: str
    snippet: str
    match_field: str  # 'title' | 'transcript'


@app.get("/search", response_model=List[SearchResult])
async def search_transcripts(q: str = "", limit: int = 50):
    """Phase 6 Task 1: case-insensitive substring search across
    meeting titles + transcript bodies.

    Implementation is intentionally simple — a SQLite ``LIKE`` scan
    rather than FTS5 — because v1 only needs to handle a single-user
    desktop dataset (typically <1000 meetings, <50k transcript rows
    in total). At that scale LIKE on an unindexed text column runs
    in well under 100ms; FTS5 + maintenance triggers would be
    over-engineering. The frontend contract here (the
    SearchResult shape) is the boundary, so swapping to FTS5 later
    is a backend-only change.

    Title matches outrank transcript-body matches in the result set
    (titles surface first, then transcripts) because the user's
    intent is usually "find that meeting I had about X" and a title
    match is the most reliable answer.

    Snippets for transcript-body matches are a ~120-char window
    centred on the first match in that meeting's transcript, with
    leading/trailing ellipses if truncated. Title matches just
    return the title as the snippet.
    """
    query = q.strip()
    if not query:
        return []
    if limit <= 0 or limit > 200:
        limit = 50

    # SQLite LIKE pattern: escape underscores/percents in the user
    # query so they're not interpreted as wildcards.
    escaped = (
        query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    pattern = f"%{escaped}%"

    seen_meeting_ids: set = set()
    results: List[dict] = []

    try:
        async with db._get_connection() as conn:
            # Pass 1: title matches. Order by recency so a recent
            # meeting with a matching title surfaces above older ones.
            cursor = await conn.execute(
                """
                SELECT id, title, created_at
                FROM meetings
                WHERE LOWER(title) LIKE LOWER(?) ESCAPE '\\'
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (pattern, limit),
            )
            for row in await cursor.fetchall():
                meeting_id, title, created_at = row[0], row[1], row[2]
                if meeting_id in seen_meeting_ids:
                    continue
                seen_meeting_ids.add(meeting_id)
                results.append(
                    {
                        "meeting_id": meeting_id,
                        "title": title or "Untitled meeting",
                        "created_at": serialize_sqlite_timestamp(created_at),
                        "snippet": title or "",
                        "match_field": "title",
                    }
                )
                if len(results) >= limit:
                    return results

            # Pass 2: transcript-body matches. One row per meeting
            # (MIN aggregate keeps the SQL straightforward; we
            # rebuild a snippet from the first match position
            # client-side below). Ordered by recency.
            remaining = limit - len(results)
            if remaining <= 0:
                return results
            cursor = await conn.execute(
                """
                SELECT m.id, m.title, m.created_at, t.transcript
                FROM meetings m
                JOIN transcripts t ON t.meeting_id = m.id
                WHERE LOWER(t.transcript) LIKE LOWER(?) ESCAPE '\\'
                GROUP BY m.id
                ORDER BY m.created_at DESC
                LIMIT ?
                """,
                (pattern, remaining),
            )
            q_lower = query.lower()
            for row in await cursor.fetchall():
                meeting_id, title, created_at, transcript = (
                    row[0], row[1], row[2], row[3] or "",
                )
                if meeting_id in seen_meeting_ids:
                    continue
                seen_meeting_ids.add(meeting_id)
                # Build a ~120-char window centred on the first match
                # in the transcript. Anchor on lowercase to match the
                # case-insensitive LIKE; slice from the original so
                # casing in the snippet is preserved.
                idx = transcript.lower().find(q_lower)
                if idx < 0:
                    snippet = transcript[:120]
                    truncated_left = False
                    truncated_right = len(transcript) > 120
                else:
                    half_window = 60
                    start = max(0, idx - half_window)
                    end = min(
                        len(transcript), idx + len(query) + half_window
                    )
                    snippet = transcript[start:end]
                    truncated_left = start > 0
                    truncated_right = end < len(transcript)
                snippet = snippet.replace("\n", " ").strip()
                if truncated_left:
                    snippet = "…" + snippet
                if truncated_right:
                    snippet = snippet + "…"
                results.append(
                    {
                        "meeting_id": meeting_id,
                        "title": title or "Untitled meeting",
                        "created_at": serialize_sqlite_timestamp(created_at),
                        "snippet": snippet,
                        "match_field": "transcript",
                    }
                )
        return results
    except Exception as e:
        logger.error(f"Error in /search: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def process_transcript_background(process_id: str, transcript: TranscriptRequest):
    """Background task to process transcript"""
    try:
        logger.info(f"Starting background processing for process_id: {process_id}")

        # Phase 4 Task 1B: pull the per-meeting custom summary prompt
        # if one was saved via /meetings/{id}/custom-prompt. The
        # processor appends it to the standard template before each
        # chunk's call so the user's instruction shapes content focus
        # without breaking the JSON schema.
        custom_prompt = None
        try:
            custom_prompt = await processor.db.get_meeting_custom_prompt(transcript.meeting_id)
        except Exception as e:
            logger.warning(
                f"Failed to read custom_summary_prompt for "
                f"{transcript.meeting_id}: {e}"
            )

        # Phase 3 Task 9: if no per-meeting prompt is set, fall back to
        # the folder's default saved prompt (when assigned). The fallback
        # only fires when ALL of: meeting has no custom prompt; meeting is
        # in a folder; folder has a default_prompt_id; the referenced
        # saved prompt still exists. If any condition is missing we
        # silently skip and the standard system prompt is used.
        # We also persist the resolved prompt back onto the meeting with
        # source='folder_default' so the gear modal can show the
        # provenance label and so subsequent regenerations are stable
        # without re-resolving (the user can still override via the gear
        # modal — that path writes source='manual' and wins forever).
        if not custom_prompt:
            try:
                folder_id = await processor.db.get_meeting_folder_id(
                    transcript.meeting_id
                )
                if folder_id:
                    fallback = await processor.db.get_folder_default_prompt(folder_id)
                    if fallback and fallback.get("prompt_text"):
                        custom_prompt = fallback["prompt_text"]
                        await processor.db.update_meeting_custom_prompt(
                            transcript.meeting_id,
                            custom_prompt,
                            source="folder_default",
                        )
                        logger.info(
                            f"[folder-default] Applied folder default prompt "
                            f"({fallback.get('prompt_name')!r}) to meeting "
                            f"{transcript.meeting_id}"
                        )
            except Exception as e:
                logger.warning(
                    f"Failed to apply folder default prompt for "
                    f"{transcript.meeting_id}: {e}"
                )
        if custom_prompt:
            logger.info(
                f"Applying custom summary prompt for {transcript.meeting_id} "
                f"({len(custom_prompt)} chars)"
            )

        num_chunks, all_json_data = await processor.process_transcript(
            text=transcript.text,
            model=transcript.model,
            model_name=transcript.model_name,
            chunk_size=transcript.chunk_size,
            overlap=transcript.overlap,
            custom_prompt=custom_prompt,
            meeting_id=transcript.meeting_id,
        )

        # Create final summary structure by aggregating chunk results
        final_summary = {
            "MeetingName": "",
            "SectionSummary": {"title": "Section Summary", "blocks": []},
            "CriticalDeadlines": {"title": "Critical Deadlines", "blocks": []},
            "KeyItemsDecisions": {"title": "Key Items & Decisions", "blocks": []},
            "ImmediateActionItems": {"title": "Immediate Action Items", "blocks": []},
            "NextSteps": {"title": "Next Steps", "blocks": []},
            "OtherImportantPoints": {"title": "Other Important Points", "blocks": []},
            "ClosingRemarks": {"title": "Closing Remarks", "blocks": []}
        }

        # Process each chunk's data
        for json_str in all_json_data:
            try:
                json_dict = json.loads(json_str)
                if "MeetingName" in json_dict and json_dict["MeetingName"]:
                    final_summary["MeetingName"] = json_dict["MeetingName"]
                for key in final_summary:
                    if key != "MeetingName" and key in json_dict and isinstance(json_dict[key], dict) and "blocks" in json_dict[key]:
                        if isinstance(json_dict[key]["blocks"], list):
                            final_summary[key]["blocks"].extend(json_dict[key]["blocks"])
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON chunk for {process_id}: {e}. Chunk: {json_str[:100]}...")
            except Exception as e:
                logger.error(f"Error processing chunk data for {process_id}: {e}. Chunk: {json_str[:100]}...")

        # Phase 3 Task 8: auto-rename the meeting from the LLM-generated
        # title — but only when the current title is still an
        # `Auto: <App> · <date>` placeholder. If the user has manually
        # renamed via /save-meeting-title (Phase 3 Task 6) before the
        # summary completed, preserve their name. Also skip the LLM's
        # explicit fallback "Untitled meeting" (returned for transcripts
        # too short/silent to title) so the placeholder stays visible
        # rather than being replaced with the literal phrase.
        suggested = (final_summary.get("MeetingName") or "").strip()
        if suggested and suggested.lower() != "untitled meeting":
            current_title = await processor.db.get_meeting_title(transcript.meeting_id)
            if current_title and current_title.startswith("Auto: "):
                await processor.db.update_meeting_name(transcript.meeting_id, suggested)
                logger.info(
                    f"Auto-renamed meeting {transcript.meeting_id}: "
                    f"{current_title!r} -> {suggested!r}"
                )
            elif current_title:
                logger.info(
                    f"Skipping auto-rename for {transcript.meeting_id}: "
                    f"current title {current_title!r} is not an Auto: placeholder"
                )

        # Save final result
        if all_json_data:
            await processor.db.update_process(process_id, status="completed", result=json.dumps(final_summary))
            logger.info(f"Background processing completed for process_id: {process_id}")
            # Phase 7 Task 1: re-embed so the new summary chunk is
            # available for RAG retrieval. embed_meeting is
            # idempotent — prior chunks get replaced.
            _spawn_embed_meeting(transcript.meeting_id)
        else:
            error_msg = "Summary generation failed: No summary could be generated. Please check your model/API key settings."
            await processor.db.update_process(process_id, status="failed", error=error_msg)
            logger.error(f"Background processing failed for process_id: {process_id} - {error_msg}")

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error in background processing for {process_id}: {error_msg}", exc_info=True)
        try:
            await processor.db.update_process(process_id, status="failed", error=error_msg)
        except Exception as db_e:
            logger.error(f"Failed to update DB status to failed for {process_id}: {db_e}", exc_info=True)

@app.post("/process-transcript")
async def process_transcript_api(
    request: Request,
    transcript: TranscriptRequest,
    background_tasks: BackgroundTasks
):
    """Process a transcript text with background processing"""
    from ai_mode import is_cloud
    if is_cloud():
        import cloud_forward
        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="missing login token")
        jwt = auth.split(" ", 1)[1]
        try:
            process_id = await processor.db.create_process(transcript.meeting_id)
            # Persist the transcript locally too. /get-summary reads via a
            # JOIN of transcript_chunks x summary_processes, so without this
            # the summary comes back "Meeting ID not found" even though the
            # proxy generated it fine. Mirrors the local branch below.
            await processor.db.save_transcript(
                transcript.meeting_id,
                transcript.text,
                transcript.model,
                transcript.model_name,
                transcript.chunk_size,
                transcript.overlap,
            )
        except Exception as e:
            logger.error(f"[cloud] create_process/save_transcript failed: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))

        async def _cloud_summarize_bg():
            try:
                summary_dict = await cloud_forward.summarize(
                    jwt,
                    transcript.text,
                    transcript.meeting_id,
                    transcript.model_name or None,
                )
                # The proxy returns a list of {title, blocks} sections, but the
                # frontend/local format is a dict keyed by section title (it does
                # Object.entries(summary) and reads summary[key].blocks). Adapt so
                # the summary actually renders. Pass the dict (not a JSON string)
                # so update_process json-encodes it exactly once.
                if isinstance(summary_dict, list):
                    import re as _re

                    def _humanize(t: str) -> str:
                        # "SectionSummary" -> "Section Summary" for display.
                        return _re.sub(r"(?<=[a-z])(?=[A-Z])", " ", t)

                    adapted = {}
                    for sec in summary_dict:
                        if not (isinstance(sec, dict) and sec.get("title")):
                            continue
                        title = sec["title"]
                        if title == "MeetingName":
                            # The frontend expects MeetingName as a plain string
                            # (it calls .toLowerCase() and uses it as the meeting
                            # title), NOT a {title, blocks} section. Passing the
                            # object crashes the summary handler.
                            blocks = sec.get("blocks") or []
                            name = ""
                            if blocks and isinstance(blocks[0], dict):
                                name = str(blocks[0].get("content", "")).strip()
                            adapted["MeetingName"] = name or "Untitled meeting"
                        else:
                            # Other sections stay {title, blocks}; only the
                            # displayed title is spaced out. Key stays machine.
                            adapted[title] = {**sec, "title": _humanize(title)}
                    summary_dict = adapted
                await processor.db.update_process(
                    process_id,
                    status="completed",
                    result=summary_dict,
                )
                logger.info(
                    "[cloud] /process-transcript completed for "
                    "process_id=%s meeting_id=%s",
                    process_id,
                    transcript.meeting_id,
                )
            except cloud_forward.CloudForwardError as e:
                logger.error("[cloud] summarize proxy error: %s", e)
                try:
                    await processor.db.update_process(
                        process_id, status="failed", error=str(e)
                    )
                except Exception:
                    pass
            except Exception as e:
                logger.error("[cloud] _cloud_summarize_bg failed: %s", e, exc_info=True)
                try:
                    await processor.db.update_process(
                        process_id, status="failed", error=str(e)
                    )
                except Exception:
                    pass

        background_tasks.add_task(_cloud_summarize_bg)
        return JSONResponse({
            "message": "Processing started",
            "process_id": process_id,
        })

    try:
        # Create new process linked to meeting_id
        process_id = await processor.db.create_process(transcript.meeting_id)

        # Save transcript data associated with meeting_id
        await processor.db.save_transcript(
            transcript.meeting_id,
            transcript.text,
            transcript.model,
            transcript.model_name,
            transcript.chunk_size,
            transcript.overlap
        )

        # Start background processing
        background_tasks.add_task(
            process_transcript_background,
            process_id,
            transcript
        )

        return JSONResponse({
            "message": "Processing started",
            "process_id": process_id
        })

    except Exception as e:
        logger.error(f"Error in process_transcript_api: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-summary/{meeting_id}")
async def get_summary(meeting_id: str):
    """Get the summary for a given meeting ID"""
    try:
        result = await processor.db.get_transcript_data(meeting_id)
        if not result:
            return JSONResponse(
                status_code=404,
                content={
                    "status": "error",
                    "meetingName": None,
                    "meeting_id": meeting_id,
                    "data": None,
                    "start": None,
                    "end": None,
                    "error": "Meeting ID not found"
                }
            )

        status = result.get("status", "unknown").lower()

        # Parse result data if available
        summary_data = None
        if result.get("result"):
            try:
                parsed_result = json.loads(result["result"])
                if isinstance(parsed_result, str):
                    summary_data = json.loads(parsed_result)
                else:
                    summary_data = parsed_result
                if not isinstance(summary_data, dict):
                    logger.error(f"Parsed summary data is not a dictionary for meeting {meeting_id}")
                    summary_data = None
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON data for meeting {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Invalid summary data format: {str(e)}"
            except Exception as e:
                logger.error(f"Unexpected error parsing summary data for {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Error processing summary data: {str(e)}"

        response = {
            "status": "processing" if status in ["processing", "pending", "started"] else status,
            "meetingName": summary_data.get("MeetingName") if isinstance(summary_data, dict) else None,
            "meeting_id": meeting_id,
            "start": result.get("start_time"),
            "end": result.get("end_time"),
            "data": summary_data if status == "completed" else None
        }

        if status == "failed":
            response["status"] = "error"
            response["error"] = result.get("error", "Unknown processing error")
            response["data"] = None
            response["meetingName"] = None
            return JSONResponse(status_code=400, content=response)

        elif status in ["processing", "pending", "started"]:
            response["data"] = None
            return JSONResponse(status_code=202, content=response)

        elif status == "completed":
            if not summary_data:
                response["status"] = "error"
                response["error"] = "Completed but summary data is missing or invalid"
                response["data"] = None
                response["meetingName"] = None
                return JSONResponse(status_code=500, content=response)
            return JSONResponse(status_code=200, content=response)

        else:
            response["status"] = "error"
            response["error"] = f"Unknown or unexpected status: {status}"
            response["data"] = None
            response["meetingName"] = None
            return JSONResponse(status_code=500, content=response)

    except Exception as e:
        logger.error(f"Error getting summary for {meeting_id}: {str(e)}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "meetingName": None,
                "meeting_id": meeting_id,
                "data": None,
                "start": None,
                "end": None,
                "error": f"Internal server error: {str(e)}"
            }
        )

@app.post("/save-transcript")
async def save_transcript(request: SaveTranscriptRequest):
    """Save transcript segments for a meeting.

    Phase 2b round 5:
      * Honors request.meeting_id if provided (Rust generates it at
        StartRecording so the frontend can navigate to the right URL).
        Falls back to a server-generated timestamp id otherwise.
      * Idempotent on id collision: same id → update existing row +
        replace its transcripts. This is what Rust retries (current or
        future) need.
      * Title is no longer a uniqueness constraint. Two recordings with
        the same auto-title ("Auto: Google Meet") are legitimate.
    """
    try:
        meeting_id = request.meeting_id or f"meeting-{int(time.time() * 1000)}"
        logger.info(
            f"Received save-transcript request: meeting_id={meeting_id}, "
            f"title={request.meeting_title!r}, "
            f"transcripts={len(request.transcripts)}, "
            f"source={request.detection_source}, "
            f"confidence={request.detection_confidence}"
        )

        # Upsert the meeting row (idempotent on id).
        await db.upsert_meeting(
            meeting_id,
            request.meeting_title,
            detection_source=request.detection_source or "manual",
            detection_confidence=request.detection_confidence or "manual",
        )

        # Replace transcripts for this meeting (idempotent on retry).
        # The request body is the source of truth for this meeting_id.
        await db.delete_meeting_transcripts(meeting_id)
        for transcript in request.transcripts:
            await db.save_meeting_transcript(
                meeting_id=meeting_id,
                transcript=transcript.text,
                timestamp=transcript.timestamp,
                summary="",
                action_items="",
                key_points=""
            )

        logger.info(f"Transcripts saved successfully for {meeting_id}")

        # Phase 7 Task 1: kick off (or refresh) the RAG embeddings for
        # this meeting. Fire-and-forget — embedding latency must not
        # block the save acknowledgement to the Rust caller. The
        # summary chunk gets added when /process-transcript fires the
        # same spawn after writing the summary.
        _spawn_embed_meeting(meeting_id)

        return {"status": "saved", "meeting_id": meeting_id}
    except Exception as e:
        logger.error(f"Error saving transcript: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================
# Phase 6 Task 4: YouTube video summarization
# ============================================================
#
# Two endpoints:
#   POST /youtube/summarize           — auto-fetch transcript via
#                                        youtube-transcript-api, fall
#                                        back to yt-dlp, save as a
#                                        meeting, kick off summary.
#   POST /youtube/summarize-manual    — user pastes the transcript
#                                        themselves (escape hatch
#                                        when both fetchers fail —
#                                        the user can copy the
#                                        transcript directly from
#                                        YouTube's UI).
#
# Saved meetings get detection_source='youtube' so they're
# identifiable later (e.g. the calendar view colors / filter).
# Summary kickoff reuses process_transcript_background so the
# YouTube transcript flows through the exact same Gemini summary
# pipeline as a regular meeting.

import re as _yt_re

_YOUTUBE_ID_PATTERNS = [
    _yt_re.compile(r"(?:youtube\.com/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})"),
    _yt_re.compile(r"(?:youtu\.be/)([A-Za-z0-9_-]{11})"),
    _yt_re.compile(r"(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})"),
    _yt_re.compile(r"(?:youtube\.com/embed/)([A-Za-z0-9_-]{11})"),
    _yt_re.compile(r"(?:youtube\.com/live/)([A-Za-z0-9_-]{11})"),
]


def _extract_youtube_video_id(url: str) -> Optional[str]:
    """Pull the 11-char video id out of any common YouTube URL form.
    Returns None if the URL doesn't look like a YouTube link."""
    if not url:
        return None
    s = url.strip()
    for pat in _YOUTUBE_ID_PATTERNS:
        m = pat.search(s)
        if m:
            return m.group(1)
    return None


def _format_youtube_transcript(snippets) -> str:
    """Group YouTube transcript snippets into ~30-second windows
    prefixed with '[MM:SS] Speaker 1: …' so they slot into the same
    rendering and parsing path the Rust audio pipeline produces.
    YouTube doesn't provide speaker diarisation, so everything is
    Speaker 1 — consistent with how single-voice meetings render."""
    if not snippets:
        return ""
    WINDOW_S = 30.0
    lines: list = []
    bucket_text: list = []
    bucket_start = snippets[0].start
    for s in snippets:
        if s.start - bucket_start >= WINDOW_S and bucket_text:
            lines.append(_emit_window(bucket_start, bucket_text))
            bucket_text = []
            bucket_start = s.start
        text = (s.text or "").strip()
        if text:
            bucket_text.append(text)
    if bucket_text:
        lines.append(_emit_window(bucket_start, bucket_text))
    return "\n".join(lines)


def _emit_window(start_s: float, parts: list) -> str:
    """Format one transcript window. Use HH:MM:SS for >1hr videos."""
    total = int(start_s)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        stamp = f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        stamp = f"{minutes:02d}:{secs:02d}"
    body = " ".join(parts).replace("\n", " ").strip()
    return f"[{stamp}] Speaker 1: {body}"


def _fetch_yt_metadata(url: str) -> dict:
    """Pull title + channel + duration via yt-dlp without downloading
    the video. Returns {title, channel, duration_seconds, video_id}.
    Raises on failure — the caller decides whether to surface the
    error or fall back."""
    import yt_dlp  # noqa: E402

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return {
        "title": info.get("title") or "Untitled YouTube video",
        "channel": info.get("channel") or info.get("uploader") or "",
        "duration_seconds": info.get("duration") or 0,
        "video_id": info.get("id") or "",
    }


def _fetch_yt_transcript_text(video_id: str) -> str:
    """Two-strategy transcript fetcher.

    Try youtube-transcript-api first — it's the lightweight default
    and works for the overwhelming majority of videos.

    Fall back to yt-dlp's subtitle extraction if the first fails. yt-dlp
    is more actively maintained against YouTube's API churn and tends
    to keep working through breakage windows. Both libraries pull the
    same auto-generated captions; the fallback exists purely for
    resilience.

    Raises ``RuntimeError`` with a user-readable message if both fail.
    """
    # Strategy 1: youtube-transcript-api
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # noqa: E402

        api = YouTubeTranscriptApi()
        fetched = api.fetch(video_id)
        snippets = list(fetched)
        if snippets:
            return _format_youtube_transcript(snippets)
    except Exception as e:
        logger.warning(
            f"youtube-transcript-api fetch failed for {video_id}: "
            f"{type(e).__name__}: {str(e)[:200]}"
        )

    # Strategy 2: yt-dlp subtitle extraction (slower, but more
    # tolerant of YouTube API rotations).
    try:
        import yt_dlp  # noqa: E402

        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en", "en-US", "en-GB"],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
        # yt-dlp surfaces subtitles as URLs; we still need to fetch
        # them. The simplest path is to use the auto-captions directly
        # via youtube-transcript-api once more with a different
        # config, but if THAT failed we're out of options here. yt-dlp
        # itself can fetch the JSON3 caption URL.
        subs = info.get("automatic_captions", {}) or {}
        for lang in ("en", "en-US", "en-GB"):
            tracks = subs.get(lang) or []
            for track in tracks:
                if track.get("ext") in ("json3", "srv3", "srv2", "srv1"):
                    import urllib.request as _ur
                    import json as _json

                    with _ur.urlopen(track["url"], timeout=15) as resp:
                        data = _json.loads(resp.read().decode("utf-8"))
                    # JSON3 shape: {events: [{tStartMs, dDurationMs, segs: [{utf8: ...}]}]}
                    parts: list = []
                    for ev in data.get("events", []) or []:
                        if "segs" not in ev:
                            continue
                        text = "".join(
                            seg.get("utf8", "") for seg in ev["segs"]
                        ).strip()
                        if not text:
                            continue
                        start_s = (ev.get("tStartMs") or 0) / 1000.0
                        dur_s = (ev.get("dDurationMs") or 0) / 1000.0

                        class _Stub:
                            pass

                        s = _Stub()
                        s.start = start_s
                        s.duration = dur_s
                        s.text = text
                        parts.append(s)
                    if parts:
                        return _format_youtube_transcript(parts)
    except Exception as e:
        logger.warning(
            f"yt-dlp transcript fetch failed for {video_id}: "
            f"{type(e).__name__}: {str(e)[:200]}"
        )

    raise RuntimeError(
        "Could not fetch a transcript for this video. The video may "
        "have captions disabled, or YouTube may have changed their "
        "API recently. Try the manual paste option below, or try "
        "again in a few hours."
    )


class YoutubeSummarizeRequest(BaseModel):
    url: str = Field(min_length=10, max_length=512)
    custom_prompt: Optional[str] = Field(default=None, max_length=4000)


class YoutubeSummarizeManualRequest(BaseModel):
    url: str = Field(min_length=10, max_length=512)
    title: str = Field(min_length=1, max_length=200)
    transcript: str = Field(min_length=10, max_length=400_000)
    custom_prompt: Optional[str] = Field(default=None, max_length=4000)


class YoutubeSummarizeResponse(BaseModel):
    meeting_id: str
    title: str
    process_id: str


async def _persist_yt_and_kickoff_async(
    *,
    background_tasks: BackgroundTasks,
    meeting_id: str,
    title: str,
    transcript_text: str,
    custom_prompt: Optional[str],
) -> dict:
    """Shared write path for both the auto-fetch and manual-paste
    endpoints. Persists the meeting + transcript, optionally writes a
    one-off custom prompt, then kicks off the standard summary
    background task — same pipeline as a recorded meeting. Returns
    {meeting_id, title, process_id} for the response."""
    await db.upsert_meeting(
        meeting_id, title,
        detection_source="youtube",
        detection_confidence="manual",
    )
    # Replace transcripts on idempotent retry.
    await db.delete_meeting_transcripts(meeting_id)
    await db.save_meeting_transcript(
        meeting_id=meeting_id,
        transcript=transcript_text,
        timestamp="00:00",
        summary="",
        action_items="",
        key_points="",
    )
    if custom_prompt and custom_prompt.strip():
        await db.update_meeting_custom_prompt(
            meeting_id, custom_prompt.strip(), source="manual"
        )

    # Kick off summary in the background using the existing pipeline.
    process_id = await processor.db.create_process(meeting_id)
    await processor.db.save_transcript(
        meeting_id, transcript_text,
        "gemini", "gemini-2.5-flash", 40000, 1000,
    )
    transcript_request = TranscriptRequest(
        text=transcript_text,
        model="gemini",
        model_name="gemini-2.5-flash",
        meeting_id=meeting_id,
        chunk_size=40000,
        overlap=1000,
    )
    background_tasks.add_task(
        process_transcript_background, process_id, transcript_request
    )
    return {
        "meeting_id": meeting_id,
        "title": title,
        "process_id": process_id,
    }


@app.post("/youtube/summarize", response_model=YoutubeSummarizeResponse)
async def youtube_summarize(
    payload: YoutubeSummarizeRequest, background_tasks: BackgroundTasks,
):
    """Auto-fetch the transcript for a YouTube video and queue a
    summary. The flow:

      1. Validate the URL is a YouTube link, extract the video id.
      2. Fetch metadata (title, channel) via yt-dlp.
      3. Fetch the transcript via youtube-transcript-api with yt-dlp
         fallback. Raise 422 if both fail (caller can fall back to
         /youtube/summarize-manual).
      4. Save as a meeting row with detection_source='youtube'.
      5. Kick off background summary generation (Gemini), same path
         as a recorded meeting.

    Returns the new meeting_id + title + process_id so the frontend
    can navigate to /meeting-details and poll for the summary.
    """
    video_id = _extract_youtube_video_id(payload.url)
    if not video_id:
        raise HTTPException(
            status_code=400,
            detail="Not a recognised YouTube URL.",
        )

    # Metadata first — cheap and gives us the title for the meeting
    # row even if the transcript fetch later fails.
    try:
        meta = _fetch_yt_metadata(payload.url)
    except Exception as e:
        logger.warning(f"yt-dlp metadata failed for {video_id}: {e}")
        meta = {
            "title": f"YouTube video {video_id}",
            "channel": "",
            "duration_seconds": 0,
            "video_id": video_id,
        }

    # Transcript with two-strategy fallback.
    try:
        transcript_text = _fetch_yt_transcript_text(video_id)
    except RuntimeError as e:
        # Surface a friendly error AND include a suggestion to use
        # the manual-paste endpoint. The frontend modal renders the
        # paste textarea on this status code.
        raise HTTPException(status_code=422, detail=str(e))

    if not transcript_text.strip():
        raise HTTPException(
            status_code=422,
            detail="The transcript was empty. The video may be silent "
                   "or have captions disabled. Try the manual paste "
                   "option below.",
        )

    # Friendly title prefix so the user sees this is a YouTube
    # summary in their meeting list.
    channel = meta.get("channel") or ""
    title = meta["title"]
    title_for_meeting = f"YouTube: {title}" + (f" ({channel})" if channel else "")
    return await _persist_yt_and_kickoff_async(
        background_tasks=background_tasks,
        meeting_id=f"meeting-{int(time.time() * 1000)}",
        title=title_for_meeting,
        transcript_text=transcript_text,
        custom_prompt=payload.custom_prompt,
    )


@app.post(
    "/youtube/summarize-manual", response_model=YoutubeSummarizeResponse,
)
async def youtube_summarize_manual(
    payload: YoutubeSummarizeManualRequest, background_tasks: BackgroundTasks,
):
    """Manual-paste fallback for when both auto-fetchers fail.
    The user copies the transcript text from YouTube's "Show
    transcript" panel and pastes it into the modal; we wrap each
    line as a Speaker 1 turn (no per-line timestamps since the
    paste loses them) and run it through the summary pipeline.
    """
    video_id = _extract_youtube_video_id(payload.url)
    if not video_id:
        raise HTTPException(
            status_code=400, detail="Not a recognised YouTube URL.",
        )

    # YouTube's transcript paste typically includes timestamps on
    # alternating lines: "[MM:SS]\nText here\n[MM:SS]\nMore text".
    # Or sometimes "MM:SS Text". Best-effort: detect either format
    # and turn into the canonical "[MM:SS] Speaker 1: text" lines.
    raw = payload.transcript.strip()
    canonical = _normalise_pasted_transcript(raw)
    if not canonical:
        raise HTTPException(
            status_code=422,
            detail="The pasted transcript was empty after cleaning.",
        )

    title_for_meeting = f"YouTube: {payload.title.strip()[:200]}"
    return await _persist_yt_and_kickoff_async(
        background_tasks=background_tasks,
        meeting_id=f"meeting-{int(time.time() * 1000)}",
        title=title_for_meeting,
        transcript_text=canonical,
        custom_prompt=payload.custom_prompt,
    )


_TS_PATTERN = _yt_re.compile(r"^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s*$")


def _normalise_pasted_transcript(raw: str) -> str:
    """Best-effort cleanup of a YouTube transcript paste into the
    canonical '[MM:SS] Speaker 1: text' shape.

    YouTube's "Show transcript" panel produces text in a few common
    forms:
      * '0:00\\nNever gonna give you up\\n0:03\\nNever gonna let you'
      * '[0:00] Never gonna give you up'
      * just plain text (no timestamps)

    We look line-by-line for timestamps; when we see one, the next
    non-empty line becomes its body. Lines without timestamps are
    appended to the previous body. Output: one canonical line per
    timestamped chunk."""
    lines = [ln.strip() for ln in raw.splitlines()]
    chunks: list = []
    pending_ts: Optional[str] = None
    pending_body: list = []

    def flush():
        if pending_ts is None and not pending_body:
            return
        ts = pending_ts or "00:00"
        body = " ".join(pending_body).strip()
        if body:
            chunks.append(f"[{ts}] Speaker 1: {body}")

    for ln in lines:
        if not ln:
            continue
        m = _TS_PATTERN.match(ln)
        if m:
            # New timestamp -> flush the previous chunk.
            flush()
            pending_ts = m.group(1)
            pending_body = []
        else:
            # Body line. Strip a leading "[MM:SS] " if present
            # (combined-format paste).
            mm = _yt_re.match(
                r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.*)$", ln
            )
            if mm:
                flush()
                pending_ts = mm.group(1)
                pending_body = [mm.group(2)]
            else:
                pending_body.append(ln)
    flush()
    if not chunks:
        # No timestamps found anywhere — emit one big chunk.
        body = " ".join(lines).strip()
        if body:
            return f"[00:00] Speaker 1: {body}"
        return ""
    return "\n".join(chunks)


@app.post("/transcribe-audio")
async def transcribe_audio(request: Request, file: UploadFile = File(...)):
    """Phase 4 Task 1C: transcribe a recorded WAV using Gemini 2.5 Flash.

    The Rust audio pipeline calls this once at end-of-recording with
    the full mixed mic+system audio as a WAV upload. Replaces the
    previous local whisper-cpp transcription on port 8178.

    Returns ``{"transcript": "<full text>"}`` on success. Empty bodies
    are valid (e.g. a recording that captured only silence).
    """
    from ai_mode import is_cloud
    if is_cloud():
        import cloud_forward
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio upload")
        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="missing login token")
        jwt = auth.split(" ", 1)[1]
        meeting_id = request.headers.get("x-meeting-id", "unknown")
        # Duration for metering. The uploaded audio may be compressed Opus
        # (the recorder compresses before upload to stay under the proxy's
        # 32MB request cap), which isn't a parseable WAV — so prefer the
        # recorder's x-audio-duration header, then fall back to a WAV parse.
        duration = 0.0
        hdr_dur = request.headers.get("x-audio-duration")
        if hdr_dur:
            try:
                duration = float(hdr_dur)
            except ValueError:
                duration = 0.0
        if duration <= 0.0:
            try:
                import struct
                if len(audio_bytes) >= 44 and audio_bytes[:4] == b"RIFF":
                    channels = struct.unpack_from("<H", audio_bytes, 22)[0]
                    rate = struct.unpack_from("<I", audio_bytes, 24)[0]
                    data_sz = struct.unpack_from("<I", audio_bytes, 40)[0]
                    if channels and rate:
                        duration = data_sz / float(rate * channels * 2)
            except Exception:
                duration = 0.0
        mime = file.content_type or "audio/wav"
        try:
            transcript = await cloud_forward.transcribe(jwt, audio_bytes, mime, meeting_id, duration)
        except cloud_forward.CloudForwardError as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"transcript": transcript}

    # Lazy-import inside the handler so module load doesn't depend on
    # google-genai when transcription is disabled in some future build.
    from google import genai
    from google.genai import types as genai_types

    # Phase 8 Task 2: centralized resolver — env, then DB, then the
    # bundled BUNDLED_GEMINI_KEY (lets the packaged MSI work without
    # the user ever pasting a key).
    api_key = await _resolve_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY not configured. Set the GEMINI_API_KEY "
                "environment variable in backend/.env to enable transcription."
            ),
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    logger.info(
        f"/transcribe-audio: received {len(audio_bytes)} bytes "
        f"(content_type={file.content_type!r}, filename={file.filename!r})"
    )

    client = genai.Client(api_key=api_key)

    # The Files API is the recommended path for non-trivial audio.
    # Inline base64 only works for very short clips (<20MB request
    # size limit including overhead). Files API has a 48-hour TTL
    # and we delete after each call to stay within quota.
    uploaded = await client.aio.files.upload(
        file=io.BytesIO(audio_bytes),
        config={"mime_type": "audio/wav"},
    )
    logger.info(f"/transcribe-audio: uploaded as {uploaded.name}")

    prompt = (
        "Transcribe this meeting audio accurately and verbatim. "
        "If multiple speakers are present, label them as Speaker 1, "
        "Speaker 2, etc. Start each speaker turn on a new line in "
        "this exact format: '[MM:SS] Speaker N: <text>'. The "
        "timestamp is the time at which that speaker turn begins, "
        "measured from the start of the recording (00:00). For "
        "recordings longer than an hour use [HH:MM:SS] instead. "
        "Do NOT summarize or paraphrase. If the audio contains "
        "music, silence, or non-speech, indicate that briefly in "
        "brackets like [music] or [silence] (no timestamp prefix "
        "needed for those). Output ONLY the transcript text — no "
        "preamble, no commentary."
    )

    # Phase 5 Task 1: wrap the Gemini call in @with_retry so transient
    # 503/UNAVAILABLE responses auto-retry up to 3 times before failing
    # the upload. The Files-API delete in `finally` still fires.
    from gemini_retry import with_retry as _with_retry  # noqa: E402

    @_with_retry
    async def _do_generate():
        return await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt, uploaded],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
            ),
        )

    try:
        response = await _do_generate()
        transcript_text = (response.text or "").strip()
        logger.info(
            f"/transcribe-audio: Gemini returned {len(transcript_text)} chars"
        )

        # Phase 8 Task 1: record cost. Duration from WAV header (44-byte
        # PCM header; falls back to bytes-per-sec estimate). Token
        # counts come from response.usage_metadata.
        try:
            import wave as _wave  # noqa: E402
            try:
                with _wave.open(io.BytesIO(audio_bytes), "rb") as _wf:
                    audio_seconds = _wf.getnframes() / float(
                        _wf.getframerate() or 1
                    )
            except Exception:
                # Non-PCM WAV (Gemini accepts these too) — estimate
                # from byte size at our recorder's known rate of
                # 16kHz mono 16-bit = 32000 bytes/sec.
                audio_seconds = max(0.0, (len(audio_bytes) - 44) / 32000.0)
            in_tok, out_tok = _costs.extract_usage_from_response(response)
            await _costs.record_usage(
                db.db_path,
                _costs.Usage(
                    endpoint="transcribe",
                    model="gemini-2.5-flash",
                    input_tokens=in_tok,
                    output_tokens=out_tok,
                    audio_seconds=audio_seconds,
                    meeting_id=None,
                    notes=file.filename or None,
                ),
            )
        except Exception as cost_err:
            logger.warning(
                "/transcribe-audio: cost logging failed (non-fatal): %s",
                cost_err,
            )

        return {"transcript": transcript_text}
    except Exception as e:
        logger.exception("Gemini transcription failed")
        # Phase 5 Task 1: friendly Gemini error mapping (same pattern
        # as the summary path). Surface a human-readable message
        # instead of the raw SDK class name.
        import google.genai.errors as _gemini_errors  # noqa: E402

        if isinstance(e, _gemini_errors.ServerError):
            status = (
                getattr(e, "code", None)
                or getattr(e, "status_code", None)
                or "5xx"
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Gemini transcription is temporarily unavailable "
                    f"(HTTP {status}). Please try again in a moment."
                ),
            )
        if isinstance(e, _gemini_errors.ClientError):
            raise HTTPException(
                status_code=502,
                detail=f"Gemini rejected the audio: {e}",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini transcription failed: {type(e).__name__}: {str(e)[:300]}",
        )
    finally:
        # Always clean up the uploaded file. Catch + log any cleanup
        # error so it doesn't mask the primary success/failure.
        try:
            await client.aio.files.delete(name=uploaded.name)
        except Exception as cleanup_err:
            logger.warning(
                f"/transcribe-audio: failed to delete uploaded file "
                f"{uploaded.name}: {cleanup_err}"
            )


@app.get("/llm/models")
async def list_llm_models():
    """Phase 4 Task 1A: enumerate available summarisation models.

    Replaces the frontend's old direct call to Ollama's
    `localhost:11434/api/tags`. Currently returns a single hardcoded
    Gemini option since that's the bundled provider; once Task 1B
    adds the user-managed Settings UI for other providers, this can
    enumerate per the configured keys.
    """
    return {
        "provider": "gemini",
        "default": "gemini-2.5-flash",
        "models": [
            {
                "name": "gemini-2.5-flash",
                "id": "gemini-2.5-flash",
                "label": "Gemini 2.5 Flash (default)",
            },
        ],
    }

@app.get("/get-model-config")
async def get_model_config():
    """Get the current model configuration"""
    model_config = await db.get_model_config()
    api_key = await db.get_api_key(model_config["provider"])
    if api_key != None:
        model_config["apiKey"] = api_key
    return model_config

@app.post("/save-model-config")
async def save_model_config(request: SaveModelConfigRequest):
    """Save the model configuration"""
    await db.save_model_config(request.provider, request.model, request.whisperModel)
    if request.apiKey != None:
        await db.save_api_key(request.apiKey, request.provider)
    return {"status": "success", "message": "Model configuration saved successfully"}  

class GetApiKeyRequest(BaseModel):
    provider: str

@app.post("/get-api-key")
async def get_api_key(request: GetApiKeyRequest):
    """Get the API key for a given provider"""
    return await db.get_api_key(request.provider)




# ===== Phase 2a: recording settings =====

class RecordingSettingsResponse(BaseModel):
    auto_record_enabled: bool
    has_seen_onboarding: bool
    # Phase 5 Task 2: in-pane welcome panel flag. Distinct from
    # has_seen_onboarding (which gates the auto-record consent modal
    # from Phase 2a) so the welcome panel and the consent modal can
    # be dismissed independently.
    has_seen_welcome_panel: bool = False
    # Phase 8 Task 9: when True, the frontend fires /process-transcript
    # automatically on the meeting-saved event so the user doesn't have
    # to click Generate Note. Defaults True for new installs.
    auto_summarize_enabled: bool = True

class RecordingSettingsUpdate(BaseModel):
    auto_record_enabled: Optional[bool] = None
    has_seen_onboarding: Optional[bool] = None
    has_seen_welcome_panel: Optional[bool] = None
    auto_summarize_enabled: Optional[bool] = None

@app.get("/settings/recording", response_model=RecordingSettingsResponse)
async def get_recording_settings():
    """Get auto-record + onboarding settings."""
    return await db.get_recording_settings()

@app.post("/settings/recording", response_model=RecordingSettingsResponse)
async def set_recording_settings(payload: RecordingSettingsUpdate):
    """Update auto-record and/or onboarding settings."""
    await db.set_recording_settings(
        auto_record_enabled=payload.auto_record_enabled,
        has_seen_onboarding=payload.has_seen_onboarding,
        has_seen_welcome_panel=payload.has_seen_welcome_panel,
        auto_summarize_enabled=payload.auto_summarize_enabled,
    )
    return await db.get_recording_settings()


# ===== Phase 5 Task 2: in-pane welcome panel =====

@app.patch("/settings/onboarding", response_model=RecordingSettingsResponse)
async def mark_welcome_panel_seen():
    """Phase 5 Task 2: mark the in-pane welcome panel as dismissed.

    Sets has_seen_welcome_panel=True. Idempotent. Distinct from the
    older has_seen_onboarding flag which gates the auto-record consent
    modal — see RecordingSettingsResponse for context.
    """
    await db.set_recording_settings(has_seen_welcome_panel=True)
    return await db.get_recording_settings()


# ===== Phase 4 Task 1B: app-level Settings page =====

# Hardcoded for v1 (single-tenant bundled key model). Returned in
# /settings.about so the Settings page can render provider info
# without a separate API surface.
_APP_VERSION = "0.4.0"
_TRANSCRIPTION_PROVIDER_LABEL = "Gemini 2.5 Flash"
_SUMMARY_PROVIDER_LABEL = "Gemini 2.5 Flash"


class SettingsAboutBlock(BaseModel):
    version: str
    transcription_provider: str
    summary_provider: str


class AppSettingsResponse(BaseModel):
    auto_record_enabled: bool
    auto_record_sources: List[str]
    default_folder_id: Optional[str] = None
    theme: str
    about: SettingsAboutBlock


class AppSettingsUpdate(BaseModel):
    """Phase 4 Task 1B: partial update — every field is Optional. The
    frontend sends only what changed, debounce-friendly.

    `default_folder_id`'s tri-state (set / clear / leave) is encoded
    via Pydantic's "field set" tracking: explicitly passing
    ``"default_folder_id": null`` clears the column; omitting the
    field leaves it untouched. We detect the difference in the
    handler with `model_fields_set`.
    """
    auto_record_enabled: Optional[bool] = None
    auto_record_sources: Optional[List[str]] = None
    default_folder_id: Optional[str] = None
    theme: Optional[str] = None


def _build_about() -> SettingsAboutBlock:
    return SettingsAboutBlock(
        version=_APP_VERSION,
        transcription_provider=_TRANSCRIPTION_PROVIDER_LABEL,
        summary_provider=_SUMMARY_PROVIDER_LABEL,
    )


@app.get("/settings", response_model=AppSettingsResponse)
async def get_app_settings():
    """Read the user-facing settings (Phase 4 Task 1B)."""
    payload = await db.get_app_settings()
    payload["about"] = _build_about()
    return payload


@app.patch("/settings", response_model=AppSettingsResponse)
async def update_app_settings(payload: AppSettingsUpdate):
    """Partial update for the Settings page. Returns the post-update
    settings so the frontend can rehydrate without a follow-up GET.

    Notes:
    - ``default_folder_id: null`` clears the column (Uncategorized).
    - ``auto_record_sources`` is fully replaced (not merged); send the
      complete list every time. Empty list = no auto-record sources.
    - ``theme`` accepts only ``light`` / ``dark`` / ``system``.
    """
    fields_set = payload.model_fields_set
    try:
        result = await db.update_app_settings(
            auto_record_enabled=payload.auto_record_enabled,
            auto_record_sources=payload.auto_record_sources,
            default_folder_id=payload.default_folder_id,
            clear_default_folder=(
                "default_folder_id" in fields_set
                and payload.default_folder_id is None
            ),
            theme=payload.theme,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    result["about"] = _build_about()
    return result


# ===== Phase 4 Task 1D: shared Gemini API-key resolver ============

async def _resolve_gemini_api_key() -> Optional[str]:
    """Env → DB → bundled. Phase 8 Task 2 added the bundled fallback
    for the packaged MSI. See _get_gemini_api_key for full notes.
    Kept as a separate alias because some callers (enhance, etc.)
    historically used this name; they share semantics."""
    return await _get_gemini_api_key()


# ===== Phase 4 Task 1B: per-meeting custom summary prompt =====

class MeetingCustomPromptUpdate(BaseModel):
    """Send `prompt: null` (or omit a non-null field) to clear the
    saved custom prompt. Send a non-empty string to set/replace it.
    Whitespace-only strings are normalised to None — the backend
    treats them the same as cleared."""
    prompt: Optional[str] = None


@app.get("/meetings/{meeting_id}/custom-prompt")
async def get_meeting_custom_prompt(meeting_id: str):
    """Read the per-meeting custom summary prompt (Phase 4 Task 1B).

    Phase 3 Task 9: also returns ``source`` ('manual', 'folder_default',
    or null) and folder-default metadata so the gear modal can render
    a 'From folder: X > Y' provenance label without a second lookup.
    """
    prompt = await db.get_meeting_custom_prompt(meeting_id)
    if prompt is None:
        # Distinguish "no prompt set" (200, null) from "no such
        # meeting" (404). Cheap existence check via the existing
        # title fetch.
        title = await db.get_meeting_title(meeting_id)
        if title is None:
            raise HTTPException(status_code=404, detail="Meeting not found")
    source = await db.get_meeting_summary_prompt_source(meeting_id)
    folder_id = await db.get_meeting_folder_id(meeting_id)
    folder_name = None
    folder_default_prompt_name = None
    folder_default_prompt_category = None
    if folder_id:
        folders = await db.list_folders()
        for f in folders:
            if f["id"] == folder_id:
                folder_name = f.get("name")
                folder_default_prompt_name = f.get("default_prompt_name")
                folder_default_prompt_category = f.get("default_prompt_category")
                break
    return {
        "meeting_id": meeting_id,
        "prompt": prompt,
        "source": source,
        "folder_id": folder_id,
        "folder_name": folder_name,
        "folder_default_prompt_name": folder_default_prompt_name,
        "folder_default_prompt_category": folder_default_prompt_category,
    }


@app.patch("/meetings/{meeting_id}/custom-prompt")
async def set_meeting_custom_prompt(
    meeting_id: str, payload: MeetingCustomPromptUpdate
):
    """Set or clear the per-meeting custom summary prompt."""
    cleaned: Optional[str] = None
    if payload.prompt is not None:
        stripped = payload.prompt.strip()
        cleaned = stripped if stripped else None
    updated = await db.update_meeting_custom_prompt(meeting_id, cleaned)
    if not updated:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"meeting_id": meeting_id, "prompt": cleaned}


# ===== Phase 4 Task 1D: saved prompt library =====

class SavedPrompt(BaseModel):
    id: int
    name: str
    category: str
    prompt_text: str
    is_starter: bool
    created_at: str
    use_count: int


class SavedPromptCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=40)
    prompt_text: str = Field(min_length=1, max_length=4000)

    @field_validator("name", "category", "prompt_text")
    @classmethod
    def _trim_non_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class EnhancePromptRequest(BaseModel):
    prompt_text: str = Field(min_length=1, max_length=4000)


class EnhancePromptResponse(BaseModel):
    enhanced: str


@app.get("/saved-prompts", response_model=List[SavedPrompt])
async def list_saved_prompts():
    """Return every saved prompt, ordered by category then name.

    The frontend groups by category client-side so the dropdown can
    render <optgroup> sections without an extra round-trip.
    """
    return await db.list_saved_prompts()


@app.post("/saved-prompts", response_model=SavedPrompt, status_code=201)
async def create_saved_prompt(payload: SavedPromptCreate):
    """Create a user-authored saved prompt. is_starter is always 0
    (the migration's seed is the only path that sets it)."""
    return await db.create_saved_prompt(
        name=payload.name,
        category=payload.category,
        prompt_text=payload.prompt_text,
    )


@app.delete("/saved-prompts/{prompt_id}", status_code=204)
async def delete_saved_prompt(prompt_id: int):
    """Delete any saved prompt by id. Starters are deletable on
    purpose — the seed only fires when the is_starter set is empty,
    so a deleted starter stays gone."""
    deleted = await db.delete_saved_prompt(prompt_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved prompt not found")
    return None


@app.post("/saved-prompts/{prompt_id}/use", status_code=204)
async def increment_saved_prompt_use(prompt_id: int):
    """Bump use_count for a saved prompt. The frontend calls this
    after a successful Save & Regenerate iff the textarea content
    matched the picked saved prompt verbatim. Best-effort: a 404
    here just means the prompt was deleted concurrently — not a
    user-facing error."""
    await db.increment_saved_prompt_use_count(prompt_id)
    return None


@app.post("/saved-prompts/enhance", response_model=EnhancePromptResponse)
async def enhance_saved_prompt(payload: EnhancePromptRequest):
    """Phase 4 Task 1D: Gemini rewrites the user's rough prompt into
    a clearer, tighter version that preserves intent. Used by the
    ✨ Enhance button in the CustomSummaryPromptModal.

    Returns 503 when no Gemini key is configured (same shape as
    /transcribe-audio); 502 on Gemini failure.
    """
    from google import genai
    from google.genai import types as genai_types

    api_key = await _resolve_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY not configured. Set the GEMINI_API_KEY "
                "environment variable in backend/.env to enable enhancing."
            ),
        )

    system_instruction = (
        "You are an expert at writing clear, actionable instructions for an "
        "AI meeting summarizer. The user has written a rough instruction for "
        "how they want their meeting summarized. Rewrite it to be clearer, "
        "more specific, and more actionable while strictly preserving their "
        "intent. Do NOT add requirements they did not imply. Keep the "
        "rewrite under 100 words. Output ONLY the rewritten instruction "
        "with no preamble, no markdown formatting, and no surrounding "
        "quotes."
    )

    client = genai.Client(api_key=api_key)

    # Phase 5 Task 1: wrap with @with_retry so transient Gemini 503s
    # auto-retry up to 3 times before failing the click.
    from gemini_retry import with_retry as _with_retry  # noqa: E402

    @_with_retry
    async def _do_enhance():
        return await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                system_instruction,
                f"Original instruction:\n{payload.prompt_text.strip()}",
            ],
            config=genai_types.GenerateContentConfig(temperature=0.3),
        )

    try:
        response = await _do_enhance()
    except Exception as exc:
        logger.exception("Gemini enhance call failed")
        # Phase 5 Task 1: friendly Gemini error mapping.
        import google.genai.errors as _gemini_errors  # noqa: E402

        if isinstance(exc, _gemini_errors.ServerError):
            status = (
                getattr(exc, "code", None)
                or getattr(exc, "status_code", None)
                or "5xx"
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Gemini is temporarily unavailable for prompt "
                    f"enhancement (HTTP {status}). Please try again in a "
                    "moment."
                ),
            )
        if isinstance(exc, _gemini_errors.ClientError):
            raise HTTPException(
                status_code=502,
                detail=f"Gemini rejected the enhancement request: {exc}",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini enhance failed: {type(exc).__name__}: {str(exc)[:300]}",
        )

    enhanced = (response.text or "").strip()
    # Phase 8 Task 1: cost log.
    try:
        in_tok, out_tok = _costs.extract_usage_from_response(response)
        await _costs.record_usage(
            db.db_path,
            _costs.Usage(
                endpoint="enhance_prompt",
                model="gemini-2.5-flash",
                input_tokens=in_tok,
                output_tokens=out_tok,
            ),
        )
    except Exception as cost_err:
        logger.warning("[enhance] cost logging failed (non-fatal): %s", cost_err)
    # Defensive: strip surrounding quotes if Gemini wrapped its output
    # despite the "no surrounding quotes" instruction.
    if (
        len(enhanced) >= 2
        and enhanced[0] in ("'", '"', "“")
        and enhanced[-1] in ("'", '"', "”")
    ):
        enhanced = enhanced[1:-1].strip()
    if not enhanced:
        # Treat empty-after-strip as a Gemini glitch rather than 200ing
        # back something the UI can't render usefully.
        raise HTTPException(
            status_code=502, detail="Gemini returned an empty enhancement"
        )
    return EnhancePromptResponse(enhanced=enhanced)


# ============================================================
# Phase 7 Task 1: RAG embedding endpoints
# ============================================================
#
# /embeddings/status   — counts + in-flight backfill state. Cheap.
#                        Frontend polls at 1Hz while the indexing
#                        banner is visible.
# /embeddings/backfill — kick off (or join) a backfill run. Single-
#                        flight inside the embeddings module; this
#                        endpoint returns immediately with the
#                        current status either way.
# /embeddings/embed/{meeting_id} — re-embed a single meeting on
#                        demand. Useful for debugging.

@app.get("/embeddings/status")
async def embeddings_status():
    """Cheap counts + in-flight state for the indexing banner."""
    try:
        return await _embeddings.status(db.db_path)
    except Exception as e:
        logger.error(f"[embeddings] status failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embeddings/backfill")
async def embeddings_backfill():
    """Embed every meeting that has no chunks yet. Returns
    immediately with the current status; the actual work runs in
    a background task. Concurrent calls are coalesced inside
    embeddings.backfill via an asyncio lock."""
    key = await _get_gemini_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY not configured — set it in Settings "
            "or via env var before running backfill.",
        )
    # Fire-and-forget; the status endpoint reflects progress.
    asyncio.get_event_loop().create_task(
        _embeddings.backfill(db.db_path, key)
    )
    return await _embeddings.status(db.db_path)


# ============================================================
# Phase 7 Task 2: /ask — RAG synthesis over meeting embeddings
# ============================================================
#
# POST /ask {question, top_k?} →
#   {
#     answer: str,
#     citations: [{
#       meeting_id, meeting_title, meeting_created_at,
#       snippet, kind, distance
#     }],
#     model: str,
#     elapsed_ms: int
#   }
#
# Pipeline: embed the question with task_type=RETRIEVAL_QUERY, do a
# vec0 similarity search for the top_k chunks, drop duplicate
# meetings down to a smaller citation set, package into a prompt for
# gemini-2.5-flash, return synthesized answer + citations.
#
# Cost note: top-K=10 chunks × ~500 tokens each + question + system
# prompt ≈ 6k input tokens; ~500 output → about $0.0005/question.

class AskRequest(BaseModel):
    question: str
    top_k: int = Field(default=10, ge=1, le=30)

    @field_validator("question")
    @classmethod
    def _trim_question(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("question must not be empty")
        if len(v) > 2000:
            raise ValueError("question too long (max 2000 chars)")
        return v


# The prompt strikes a balance between freedom (Gemini synthesizes
# rather than quoting verbatim) and groundedness (it must cite by
# meeting title and refuse to answer when the chunks don't cover the
# question). Tested against your meeting corpus before shipping.
_ASK_SYSTEM_PROMPT = (
    "You are an assistant for searching the user's recorded meetings. "
    "Below is a numbered list of CHUNKS retrieved by semantic similarity "
    "from their meeting transcripts and AI-generated summaries.\n\n"
    "Your job:\n"
    "1. Read the chunks and synthesize an answer to the user's question.\n"
    "2. Be concise — typically 1-4 sentences. Bullet lists are OK for "
    "enumerations.\n"
    "3. When citing, reference the meeting by its TITLE in markdown link "
    "form: [Meeting Title](#cite-N) where N is the chunk number. The "
    "frontend resolves these to clickable meeting links.\n"
    "4. If the chunks don't contain the answer, say so plainly. Do not "
    "speculate or invent meetings.\n"
    "5. If multiple meetings discuss the same point, cite the most "
    "relevant 1-3 — don't carpet-bomb citations.\n"
)


def _build_ask_context(citations: list[dict]) -> str:
    """Format the retrieved chunks as a numbered context block."""
    lines = []
    for i, c in enumerate(citations, start=1):
        # Include kind tag so the model knows whether it's reading
        # raw transcript or an AI summary — useful for "what was
        # decided" type queries where summary chunks are higher
        # signal.
        kind_tag = "[summary]" if c["kind"] == "summary" else "[transcript]"
        title = c["meeting_title"]
        date = (c.get("meeting_created_at") or "").split("T")[0]
        text = c["text"]
        lines.append(
            f"### CHUNK {i} — {title} ({date}) {kind_tag}\n{text}"
        )
    return "\n\n".join(lines)


@app.post("/ask")
async def ask(request: AskRequest):
    """Answer a question over the user's meeting corpus."""
    started = time.time()
    key = await _get_gemini_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY not configured",
        )
    try:
        # Phase 7 Task 2: retrieve top-k chunks.
        hits = await _embeddings.search(
            db.db_path, request.question, key, top_k=request.top_k
        )
    except Exception as e:
        logger.error(f"[ask] search failed: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"search failed: {e}")

    if not hits:
        elapsed_ms = int((time.time() - started) * 1000)
        return {
            "answer": (
                "I don't have any indexed meetings to search yet. "
                "Record a meeting (or wait for indexing to finish) and try again."
            ),
            "citations": [],
            "model": "gemini-2.5-flash",
            "elapsed_ms": elapsed_ms,
        }

    context_block = _build_ask_context(hits)
    user_prompt = (
        f"{_ASK_SYSTEM_PROMPT}\n\n"
        f"========== CHUNKS ==========\n{context_block}\n"
        f"========== END CHUNKS ==========\n\n"
        f"User question: {request.question}\n\n"
        f"Answer:"
    )

    try:
        from google import genai as _genai  # local import — mirrors other Gemini handlers
        client = _genai.Client(api_key=key)
        resp = await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=user_prompt,
        )
        answer = (resp.text or "").strip()
    except Exception as e:
        logger.error(f"[ask] generate_content failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=502, detail=f"answer synthesis failed: {e}"
        )

    # Phase 8 Task 1: record cost of the synthesis call. (Embedding
    # the query is logged inside embeddings.search.)
    try:
        in_tok, out_tok = _costs.extract_usage_from_response(resp)
        await _costs.record_usage(
            db.db_path,
            _costs.Usage(
                endpoint="ask",
                model="gemini-2.5-flash",
                input_tokens=in_tok,
                output_tokens=out_tok,
                notes=request.question[:200],
            ),
        )
    except Exception as cost_err:
        logger.warning("[ask] cost logging failed (non-fatal): %s", cost_err)

    elapsed_ms = int((time.time() - started) * 1000)
    logger.info(
        "[ask] q=%r hits=%d answer_chars=%d elapsed=%dms",
        request.question[:60],
        len(hits),
        len(answer),
        elapsed_ms,
    )
    return {
        "answer": answer,
        "citations": [
            {
                "n": i + 1,
                "meeting_id": h["meeting_id"],
                "meeting_title": h["meeting_title"],
                "meeting_created_at": h["meeting_created_at"],
                "snippet": h["snippet"],
                "kind": h["kind"],
                "distance": h["distance"],
            }
            for i, h in enumerate(hits)
        ],
        "model": "gemini-2.5-flash",
        "elapsed_ms": elapsed_ms,
    }


@app.post("/embeddings/embed/{meeting_id}")
async def embeddings_embed_one(meeting_id: str):
    """Re-embed a single meeting. Useful for ad-hoc debugging — the
    save-transcript + summary-completed paths already trigger this
    automatically."""
    key = await _get_gemini_api_key()
    if not key:
        raise HTTPException(
            status_code=400, detail="GEMINI_API_KEY not configured"
        )
    try:
        n = await _embeddings.embed_meeting(db.db_path, meeting_id, key)
        return {"meeting_id": meeting_id, "chunks": n}
    except Exception as e:
        logger.error(
            f"[embeddings] embed_one {meeting_id} failed: {e}", exc_info=True
        )
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# Phase 8 Task 1: /admin/costs — Gemini spend dashboard
# ============================================================
#
# These endpoints are intentionally unauthenticated for now because
# the app is single-user and runs on localhost. When the auth/license
# backend lands, gate these behind an admin role check.

@app.get("/admin/costs/summary")
async def admin_costs_summary():
    """All-time + month-to-date totals + per-endpoint breakdown."""
    try:
        return await _costs.summary(db.db_path)
    except Exception as e:
        logger.error("/admin/costs/summary failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/admin/costs/by-meeting")
async def admin_costs_by_meeting(limit: int = 25):
    """Top N most-expensive meetings."""
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be 1-200")
    try:
        return await _costs.by_meeting(db.db_path, limit=limit)
    except Exception as e:
        logger.error("/admin/costs/by-meeting failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/admin/costs/by-day")
async def admin_costs_by_day(days: int = 30):
    """Daily totals for the last N days (for sparkline)."""
    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be 1-365")
    try:
        return await _costs.by_day(db.db_path, days=days)
    except Exception as e:
        logger.error("/admin/costs/by-day failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on API shutdown"""
    logger.info("API shutting down, cleaning up resources")
    try:
        processor.cleanup()
        logger.info("Successfully cleaned up resources")
    except Exception as e:
        logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

if __name__ == "__main__":
    import multiprocessing
    import sys as _sys

    multiprocessing.freeze_support()

    # Phase 8 Task 4: PyInstaller-built windowed EXE has no console,
    # so `sys.stdout` / `sys.stderr` are None. Uvicorn's default
    # logging formatter calls `sys.stdout.isatty()` and crashes
    # before the server even starts. Provide a black-hole stream so
    # any library that pokes at stdout doesn't NPE, and tell uvicorn
    # to skip its color-aware default log config (the plain Python
    # `logging` config in main.py:55 still works).
    _frozen = getattr(_sys, "frozen", False)
    if _frozen:
        class _NullStream:
            def write(self, *_a, **_k):
                return 0
            def flush(self):
                pass
            def isatty(self):
                return False
        if _sys.stdout is None:
            _sys.stdout = _NullStream()
        if _sys.stderr is None:
            _sys.stderr = _NullStream()

    # When running as a frozen sidecar, bind only to loopback (no
    # firewall prompt, smaller attack surface). Dev keeps 0.0.0.0
    # so LAN-device testing still works.
    _host = "127.0.0.1" if _frozen else "0.0.0.0"
    # log_config=None disables uvicorn's default dictConfig (which
    # tries to instantiate a color formatter that NPEs on a None
    # stdout). Our root logger.basicConfig at the top of this module
    # still routes uvicorn's logs sensibly.
    uvicorn.run(
        app,
        host=_host,
        port=5167,
        log_config=None if _frozen else uvicorn.config.LOGGING_CONFIG,
    )
