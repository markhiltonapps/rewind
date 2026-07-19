"""
Tests for app.cloud_forward using respx to mock the proxy endpoints.

Each public function is tested for:
  - Happy path: correct URL, Bearer auth header, and parsed return value.
  - Error path: CloudForwardError raised on an HTTP 500 response.

proxy_base_url() is tested separately for missing env var and trailing
slash stripping.
"""

from __future__ import annotations

import os
import pytest
import respx
import httpx

from app.cloud_forward import (
    CloudForwardError,
    proxy_base_url,
    transcribe,
    summarize,
    embed,
)

PROXY_URL = "https://proxy.example.com"
JWT = "test-jwt-token"


# ---------------------------------------------------------------------------
# proxy_base_url
# ---------------------------------------------------------------------------


def test_proxy_base_url_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")
    assert proxy_base_url() == "https://proxy.example.com"


def test_proxy_base_url_no_trailing_slash(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com")
    assert proxy_base_url() == "https://proxy.example.com"


def test_proxy_base_url_raises_when_unset(monkeypatch):
    monkeypatch.delenv("REWIND_PROXY_URL", raising=False)
    with pytest.raises(CloudForwardError, match="REWIND_PROXY_URL"):
        proxy_base_url()


# ---------------------------------------------------------------------------
# transcribe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_transcribe_success(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    route = respx.post(f"{PROXY_URL}/v1/transcribe").mock(
        return_value=httpx.Response(200, json={"transcript": "Hello world"})
    )

    result = await transcribe(
        jwt=JWT,
        audio=b"fake-audio-bytes",
        mime="audio/wav",
        meeting_id="meeting-123",
        duration_seconds=42.5,
    )

    assert result == "Hello world"
    assert route.called
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {JWT}"
    assert b"fake-audio-bytes" in request.content
    assert b"meeting-123" in request.content


@pytest.mark.asyncio
@respx.mock
async def test_transcribe_raises_on_500(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    respx.post(f"{PROXY_URL}/v1/transcribe").mock(
        return_value=httpx.Response(500, text="Internal Server Error")
    )

    with pytest.raises(CloudForwardError, match="500"):
        await transcribe(
            jwt=JWT,
            audio=b"fake-audio-bytes",
            mime="audio/wav",
            meeting_id="meeting-123",
            duration_seconds=42.5,
        )


# ---------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_summarize_success(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    expected_summary = {"title": "Weekly Sync", "action_items": ["Do X", "Do Y"]}
    route = respx.post(f"{PROXY_URL}/v1/summarize").mock(
        return_value=httpx.Response(200, json={"summary": expected_summary})
    )

    result = await summarize(
        jwt=JWT,
        text="Let's align on the roadmap.",
        meeting_id="meeting-456",
    )

    assert result == expected_summary
    assert route.called
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {JWT}"


@pytest.mark.asyncio
@respx.mock
async def test_summarize_with_model(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    route = respx.post(f"{PROXY_URL}/v1/summarize").mock(
        return_value=httpx.Response(200, json={"summary": {"title": "Quick sync"}})
    )

    result = await summarize(
        jwt=JWT,
        text="Short meeting.",
        meeting_id="meeting-789",
        model="gemini-2.0-flash",
    )

    assert result == {"title": "Quick sync"}
    import json
    body = json.loads(route.calls.last.request.content)
    assert body["model"] == "gemini-2.0-flash"


@pytest.mark.asyncio
@respx.mock
async def test_summarize_raises_on_500(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    respx.post(f"{PROXY_URL}/v1/summarize").mock(
        return_value=httpx.Response(500, text="Internal Server Error")
    )

    with pytest.raises(CloudForwardError, match="500"):
        await summarize(jwt=JWT, text="text", meeting_id="meeting-456")


# ---------------------------------------------------------------------------
# embed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_embed_success(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    expected_embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
    route = respx.post(f"{PROXY_URL}/v1/embed").mock(
        return_value=httpx.Response(200, json={"embeddings": expected_embeddings})
    )

    result = await embed(
        jwt=JWT,
        texts=["Hello", "World"],
        meeting_id="meeting-999",
    )

    assert result == expected_embeddings
    assert route.called
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {JWT}"


@pytest.mark.asyncio
@respx.mock
async def test_embed_raises_on_500(monkeypatch):
    monkeypatch.setenv("REWIND_PROXY_URL", "https://proxy.example.com/")

    respx.post(f"{PROXY_URL}/v1/embed").mock(
        return_value=httpx.Response(500, text="Internal Server Error")
    )

    with pytest.raises(CloudForwardError, match="500"):
        await embed(jwt=JWT, texts=["Hello"], meeting_id="meeting-999")
