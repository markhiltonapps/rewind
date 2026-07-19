"""
cloud_forward.py — forwards AI work to the deployed Rewind proxy.

Each function builds an Authorization: Bearer <jwt> header, calls the
matching proxy endpoint, and returns the parsed response field.
CloudForwardError is raised on any non-2xx HTTP response or transport error.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx


class CloudForwardError(Exception):
    """Raised on any non-2xx response or httpx transport error.

    The message includes the HTTP status (when known) and the first 300
    characters of the response body so callers can surface useful details
    without leaking secrets.
    """


def proxy_base_url() -> str:
    """Return ``REWIND_PROXY_URL`` with any trailing slash stripped.

    Raises:
        CloudForwardError: if the environment variable is not set.
    """
    url = os.environ.get("REWIND_PROXY_URL")
    if not url:
        raise CloudForwardError(
            "REWIND_PROXY_URL environment variable is not set"
        )
    return url.rstrip("/")


def _auth_headers(jwt: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {jwt}"}


def _raise_for_status(response: httpx.Response) -> None:
    """Raise CloudForwardError if *response* is not 2xx."""
    if response.is_success:
        return
    snippet = response.text[:300]
    raise CloudForwardError(
        f"Proxy returned HTTP {response.status_code}: {snippet}"
    )


async def transcribe(
    jwt: str,
    audio: bytes,
    mime: str,
    meeting_id: str,
    duration_seconds: float,
) -> str:
    """Transcribe audio via the proxy.

    Args:
        jwt: Supabase JWT for authentication.
        audio: Raw audio bytes.
        mime: MIME type of the audio (e.g. ``"audio/wav"``).
        meeting_id: Identifier for the meeting.
        duration_seconds: Duration of the audio clip.

    Returns:
        The transcript string returned by the proxy.

    Raises:
        CloudForwardError: on non-2xx response or transport error.
    """
    url = f"{proxy_base_url()}/v1/transcribe"
    files = {"audio": ("audio", audio, mime)}
    data = {
        "meeting_id": meeting_id,
        "duration_seconds": str(duration_seconds),
    }
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(
                url,
                headers=_auth_headers(jwt),
                files=files,
                data=data,
            )
    except httpx.TransportError as exc:
        raise CloudForwardError(f"Transport error during transcribe: {exc}") from exc

    _raise_for_status(response)
    return response.json()["transcript"]


async def summarize(
    jwt: str,
    text: str,
    meeting_id: str,
    model: Optional[str] = None,
) -> dict:
    """Summarize meeting text via the proxy.

    Args:
        jwt: Supabase JWT for authentication.
        text: The text to summarize.
        meeting_id: Identifier for the meeting.
        model: Optional model name override.

    Returns:
        The summary dict returned by the proxy.

    Raises:
        CloudForwardError: on non-2xx response or transport error.
    """
    url = f"{proxy_base_url()}/v1/summarize"
    payload: dict = {"meeting_id": meeting_id, "text": text}
    if model is not None:
        payload["model"] = model

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                url,
                headers=_auth_headers(jwt),
                json=payload,
            )
    except httpx.TransportError as exc:
        raise CloudForwardError(f"Transport error during summarize: {exc}") from exc

    _raise_for_status(response)
    return response.json()["summary"]


async def embed(
    jwt: str,
    texts: list[str],
    meeting_id: str,
) -> list[list[float]]:
    """Embed a list of texts via the proxy.

    Args:
        jwt: Supabase JWT for authentication.
        texts: Texts to embed.
        meeting_id: Identifier for the meeting.

    Returns:
        List of embedding vectors (each a list of floats).

    Raises:
        CloudForwardError: on non-2xx response or transport error.
    """
    url = f"{proxy_base_url()}/v1/embed"
    payload = {"meeting_id": meeting_id, "texts": texts}

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                url,
                headers=_auth_headers(jwt),
                json=payload,
            )
    except httpx.TransportError as exc:
        raise CloudForwardError(f"Transport error during embed: {exc}") from exc

    _raise_for_status(response)
    return response.json()["embeddings"]
