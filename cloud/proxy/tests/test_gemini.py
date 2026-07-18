"""Tests for app.gemini — all Gemini SDK calls are mocked; no network."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.gemini as gemini_mod


# ---------------------------------------------------------------------------
# Helpers: build mock client trees
# ---------------------------------------------------------------------------

def _make_transcribe_mock(transcript_text: str) -> MagicMock:
    """Return a mock genai.Client where aio.files.upload and
    aio.models.generate_content behave like the real SDK."""
    mock_client = MagicMock()

    # aio.files.upload returns an uploaded-file object
    uploaded_file = MagicMock()
    mock_client.aio.files.upload = AsyncMock(return_value=uploaded_file)

    # aio.models.generate_content returns a response with .text
    response = MagicMock()
    response.text = transcript_text
    mock_client.aio.models.generate_content = AsyncMock(return_value=response)

    return mock_client


def _make_summarize_mock(summary_dict: dict) -> MagicMock:
    """Return a mock genai.Client for summarize — generate_content only."""
    mock_client = MagicMock()

    response = MagicMock()
    response.text = json.dumps(summary_dict)
    mock_client.aio.models.generate_content = AsyncMock(return_value=response)

    return mock_client


def _make_embed_mock(vectors: list[list[float]]) -> MagicMock:
    """Return a mock genai.Client for embed — embed_content only."""
    mock_client = MagicMock()

    # resp.embeddings is a list of objects each with .values
    embeddings = []
    for vec in vectors:
        emb = MagicMock()
        emb.values = vec
        embeddings.append(emb)

    response = MagicMock()
    response.embeddings = embeddings
    mock_client.aio.models.embed_content = AsyncMock(return_value=response)

    return mock_client


# ---------------------------------------------------------------------------
# transcribe
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_transcribe_client_constructed_with_env_key(monkeypatch):
    """genai.Client must be called with the GEMINI_API_KEY env var."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-transcribe")
    mock_client = _make_transcribe_mock("Hello world")

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client) as mock_ctor:
        result = await gemini_mod.transcribe(b"fake-audio", "audio/wav")

    mock_ctor.assert_called_once_with(api_key="test-key-transcribe")


@pytest.mark.asyncio
async def test_transcribe_uploads_audio_and_calls_generate(monkeypatch):
    """transcribe must upload bytes then call generate_content."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    audio = b"\x00\x01\x02audio"
    mock_client = _make_transcribe_mock("  Some transcript  ")

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.transcribe(audio, "audio/wav")

    # upload was called once
    mock_client.aio.files.upload.assert_awaited_once()
    upload_call = mock_client.aio.files.upload.call_args
    # config mime_type propagated
    assert upload_call.kwargs["config"]["mime_type"] == "audio/wav"

    # generate_content was called once
    mock_client.aio.models.generate_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_transcribe_returns_stripped_text(monkeypatch):
    """transcribe strips surrounding whitespace from response.text."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_transcribe_mock("  Hello world  ")

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.transcribe(b"audio", "audio/wav")

    assert result == "Hello world"


@pytest.mark.asyncio
async def test_transcribe_returns_empty_string_for_none_response(monkeypatch):
    """If response.text is None, transcribe returns empty string."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_transcribe_mock(None)  # type: ignore[arg-type]

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.transcribe(b"audio", "audio/wav")

    assert result == ""


# ---------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------

_SAMPLE_SUMMARY = {
    "MeetingName": "Sprint Planning with Ali",
    "SectionSummary": {"title": "Section Summary", "blocks": []},
    "CriticalDeadlines": {"title": "Critical Deadlines", "blocks": []},
    "KeyItemsDecisions": {"title": "Key Items & Decisions", "blocks": []},
    "ImmediateActionItems": {"title": "Immediate Action Items", "blocks": []},
    "NextSteps": {"title": "Next Steps", "blocks": []},
    "OtherImportantPoints": {"title": "Other Important Points", "blocks": []},
    "ClosingRemarks": {"title": "Closing Remarks", "blocks": []},
}


@pytest.mark.asyncio
async def test_summarize_client_constructed_with_env_key(monkeypatch):
    """genai.Client must be called with GEMINI_API_KEY."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-summarize")
    mock_client = _make_summarize_mock(_SAMPLE_SUMMARY)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client) as mock_ctor:
        await gemini_mod.summarize("Some transcript text")

    mock_ctor.assert_called_once_with(api_key="test-key-summarize")


@pytest.mark.asyncio
async def test_summarize_calls_generate_content(monkeypatch):
    """summarize must call aio.models.generate_content."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_summarize_mock(_SAMPLE_SUMMARY)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        await gemini_mod.summarize("Some transcript text")

    mock_client.aio.models.generate_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_summarize_returns_dict(monkeypatch):
    """summarize must return a dict parsed from the JSON response."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_summarize_mock(_SAMPLE_SUMMARY)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.summarize("Some transcript text")

    assert isinstance(result, dict)
    assert result["MeetingName"] == "Sprint Planning with Ali"
    assert "SectionSummary" in result


@pytest.mark.asyncio
async def test_summarize_uses_default_model(monkeypatch):
    """summarize passes model=gemini-2.5-flash by default."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_summarize_mock(_SAMPLE_SUMMARY)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        await gemini_mod.summarize("text")

    call_kwargs = mock_client.aio.models.generate_content.call_args.kwargs
    assert call_kwargs["model"] == "gemini-2.5-flash"


@pytest.mark.asyncio
async def test_summarize_accepts_custom_model(monkeypatch):
    """summarize passes through any explicitly provided model name."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_summarize_mock(_SAMPLE_SUMMARY)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        await gemini_mod.summarize("text", model="gemini-pro")

    call_kwargs = mock_client.aio.models.generate_content.call_args.kwargs
    assert call_kwargs["model"] == "gemini-pro"


# ---------------------------------------------------------------------------
# embed
# ---------------------------------------------------------------------------

_SAMPLE_VECTORS = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]


@pytest.mark.asyncio
async def test_embed_client_constructed_with_env_key(monkeypatch):
    """genai.Client must be called with GEMINI_API_KEY."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-embed")
    mock_client = _make_embed_mock(_SAMPLE_VECTORS)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client) as mock_ctor:
        await gemini_mod.embed(["hello", "world"])

    mock_ctor.assert_called_once_with(api_key="test-key-embed")


@pytest.mark.asyncio
async def test_embed_calls_embed_content(monkeypatch):
    """embed must call aio.models.embed_content."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_embed_mock(_SAMPLE_VECTORS)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        await gemini_mod.embed(["hello", "world"])

    mock_client.aio.models.embed_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_embed_returns_list_of_lists(monkeypatch):
    """embed must return a list of float lists, one per input string."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_embed_mock(_SAMPLE_VECTORS)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.embed(["hello", "world"])

    assert isinstance(result, list)
    assert len(result) == 2
    for vec in result:
        assert isinstance(vec, list)
        assert all(isinstance(x, float) for x in vec)


@pytest.mark.asyncio
async def test_embed_vector_values_match(monkeypatch):
    """embed must return the exact float values from the mock response."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_embed_mock(_SAMPLE_VECTORS)

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        result = await gemini_mod.embed(["hello", "world"])

    assert result == _SAMPLE_VECTORS


@pytest.mark.asyncio
async def test_embed_empty_input_returns_empty_list(monkeypatch):
    """embed([]) must short-circuit and return [] without touching the SDK."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    with patch.object(gemini_mod.genai, "Client") as mock_ctor:
        result = await gemini_mod.embed([])

    assert result == []
    mock_ctor.assert_not_called()


@pytest.mark.asyncio
async def test_embed_uses_correct_model(monkeypatch):
    """embed must use gemini-embedding-001."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    mock_client = _make_embed_mock([[0.1]])

    with patch.object(gemini_mod.genai, "Client", return_value=mock_client):
        await gemini_mod.embed(["text"])

    call_kwargs = mock_client.aio.models.embed_content.call_args.kwargs
    assert call_kwargs["model"] == "gemini-embedding-001"
