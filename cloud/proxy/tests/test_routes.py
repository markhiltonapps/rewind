"""Integration tests for app/main.py routes.

Strategy:
  - Use fastapi.testclient.TestClient (synchronous) so no event-loop
    setup is needed for the client itself.
  - Override get_db with a FakeDB (in-memory, configurable per test).
  - Monkeypatch app.main.verify_jwt and app.main.gemini.* so no real
    auth or network calls are made.

FakeDB captures insert_usage calls in a list so tests can assert on them.
"""

import io
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import AuthedUser
from app.main import app, get_db

# ---------------------------------------------------------------------------
# Fake database
# ---------------------------------------------------------------------------

class FakeDB:
    """In-memory stand-in for SupabaseDB.

    Args:
        invited:    Whether is_invited() returns True (default True).
        cost:       Value returned by month_cost() (default 0.0).
        cap_value:  Value returned by cap() (default None → gates use
                    default_cap=5.0).
    """

    def __init__(
        self,
        *,
        invited: bool = True,
        cost: float = 0.0,
        cap_value: float | None = None,
    ) -> None:
        self._invited = invited
        self._cost = cost
        self._cap_value = cap_value
        self.usage_calls: list[dict] = []

    async def is_invited(self, email: str) -> bool:
        return self._invited

    async def month_cost(self, user_id: str) -> float:
        return self._cost

    async def cap(self, user_id: str) -> float | None:
        return self._cap_value

    async def insert_usage(
        self,
        user_id: str,
        email: str,
        kind: str,
        raw_units: float,
        est_cost_usd: float,
    ) -> None:
        self.usage_calls.append(
            {
                "user_id": user_id,
                "email": email,
                "kind": kind,
                "raw_units": raw_units,
                "est_cost_usd": est_cost_usd,
            }
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

AUTHED_USER = AuthedUser(user_id="u-test", email="test@example.com")
AUTH_HEADER = {"Authorization": "Bearer fake-token"}


def _make_client(db: FakeDB) -> TestClient:
    """Return a TestClient with get_db overridden to return *db*."""
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, raise_server_exceptions=False)
    return client


def _patch_verify_ok(monkeypatch):
    """Patch verify_jwt so it returns AUTHED_USER without real JWT validation."""
    async def _fake_verify(authorization):
        return AUTHED_USER
    monkeypatch.setattr("app.main.verify_jwt", _fake_verify)


def _patch_verify_401(monkeypatch):
    """Patch verify_jwt so it raises HTTP 401."""
    async def _fake_verify(authorization):
        raise HTTPException(status_code=401, detail="invalid_token")
    monkeypatch.setattr("app.main.verify_jwt", _fake_verify)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

def test_healthz():
    client = TestClient(app)
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ---------------------------------------------------------------------------
# POST /v1/transcribe
# ---------------------------------------------------------------------------

class TestTranscribe:
    def test_happy_path(self, monkeypatch):
        """200, correct body, one usage row recorded."""
        _patch_verify_ok(monkeypatch)

        async def _fake_transcribe(audio_bytes, mime):
            return "Hello world transcript"

        monkeypatch.setattr("app.main.gemini.transcribe", _fake_transcribe)

        db = FakeDB()
        client = _make_client(db)

        audio_content = b"fake audio bytes"
        r = client.post(
            "/v1/transcribe",
            headers=AUTH_HEADER,
            data={"meeting_id": "mtg-1", "duration_seconds": "30.0"},
            files={"audio": ("test.wav", io.BytesIO(audio_content), "audio/wav")},
        )

        assert r.status_code == 200
        assert r.json() == {"transcript": "Hello world transcript"}
        assert len(db.usage_calls) == 1
        call = db.usage_calls[0]
        assert call["kind"] == "transcribe"
        assert call["raw_units"] == pytest.approx(30.0)

    def test_not_invited_403(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(invited=False)
        client = _make_client(db)

        r = client.post(
            "/v1/transcribe",
            headers=AUTH_HEADER,
            data={"meeting_id": "mtg-1", "duration_seconds": "30.0"},
            files={"audio": ("test.wav", io.BytesIO(b"x"), "audio/wav")},
        )

        assert r.status_code == 403
        assert r.json()["detail"] == "not_invited"

    def test_over_cap_429(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(cost=10.0, cap_value=5.0)
        client = _make_client(db)

        r = client.post(
            "/v1/transcribe",
            headers=AUTH_HEADER,
            data={"meeting_id": "mtg-1", "duration_seconds": "30.0"},
            files={"audio": ("test.wav", io.BytesIO(b"x"), "audio/wav")},
        )

        assert r.status_code == 429
        assert r.json()["detail"] == "monthly_limit_reached"

    def test_invalid_jwt_401(self, monkeypatch):
        _patch_verify_401(monkeypatch)
        db = FakeDB()
        client = _make_client(db)

        r = client.post(
            "/v1/transcribe",
            headers=AUTH_HEADER,
            data={"meeting_id": "mtg-1", "duration_seconds": "30.0"},
            files={"audio": ("test.wav", io.BytesIO(b"x"), "audio/wav")},
        )

        assert r.status_code == 401


# ---------------------------------------------------------------------------
# POST /v1/summarize
# ---------------------------------------------------------------------------

class TestSummarize:
    def test_happy_path(self, monkeypatch):
        """200, correct body, one usage row with expected raw_units."""
        _patch_verify_ok(monkeypatch)

        canned_summary = {"sections": [{"title": "Test", "blocks": []}]}

        async def _fake_summarize(text, model="gemini-2.5-flash", custom_prompt=None):
            return canned_summary

        monkeypatch.setattr("app.main.gemini.summarize", _fake_summarize)

        sample_text = "A" * 400  # 400 chars → 100 tokens
        db = FakeDB()
        client = _make_client(db)

        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-2", "text": sample_text},
        )

        assert r.status_code == 200
        assert r.json() == {"summary": canned_summary}
        assert len(db.usage_calls) == 1
        call = db.usage_calls[0]
        assert call["kind"] == "summarize"
        assert call["raw_units"] == pytest.approx(100.0)  # 400 / 4

    def test_custom_prompt_is_forwarded(self, monkeypatch):
        """A per-meeting/folder prompt must reach gemini.summarize.

        Until this route accepted the field, the request model had no
        place to put it, so per-meeting prompts, folder defaults, and the
        whole saved-prompt library silently did nothing in the shipped
        app. This is the regression guard for that.
        """
        _patch_verify_ok(monkeypatch)
        seen = {}

        async def _fake_summarize(text, model="gemini-2.5-flash", custom_prompt=None):
            seen["custom_prompt"] = custom_prompt
            return {}

        monkeypatch.setattr("app.main.gemini.summarize", _fake_summarize)

        client = _make_client(FakeDB())
        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={
                "meeting_id": "mtg-3",
                "text": "hello",
                "custom_prompt": "Focus on budget risks.",
            },
        )
        assert r.status_code == 200
        assert seen["custom_prompt"] == "Focus on budget risks."

    def test_custom_prompt_defaults_to_none(self, monkeypatch):
        """Older app builds omit the field entirely; that must still work."""
        _patch_verify_ok(monkeypatch)
        seen = {}

        async def _fake_summarize(text, model="gemini-2.5-flash", custom_prompt=None):
            seen["custom_prompt"] = custom_prompt
            return {}

        monkeypatch.setattr("app.main.gemini.summarize", _fake_summarize)

        client = _make_client(FakeDB())
        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-4", "text": "hello"},
        )
        assert r.status_code == 200
        assert seen["custom_prompt"] is None

    def test_not_invited_403(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(invited=False)
        client = _make_client(db)

        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-2", "text": "hello"},
        )

        assert r.status_code == 403

    def test_over_cap_429(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(cost=6.0)  # exceeds default_cap=5.0
        client = _make_client(db)

        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-2", "text": "hello"},
        )

        assert r.status_code == 429

    def test_invalid_jwt_401(self, monkeypatch):
        _patch_verify_401(monkeypatch)
        db = FakeDB()
        client = _make_client(db)

        r = client.post(
            "/v1/summarize",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-2", "text": "hello"},
        )

        assert r.status_code == 401


# ---------------------------------------------------------------------------
# POST /v1/embed
# ---------------------------------------------------------------------------

class TestEmbed:
    def test_happy_path(self, monkeypatch):
        """200, correct body, one usage row with expected raw_units."""
        _patch_verify_ok(monkeypatch)

        canned_embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]

        async def _fake_embed(texts):
            return canned_embeddings

        monkeypatch.setattr("app.main.gemini.embed", _fake_embed)

        texts = ["hello world", "foo bar baz"]
        # raw_units = (len("hello world") + len("foo bar baz")) / 4 = (11+11)/4 = 5.5
        expected_raw_units = sum(len(t) for t in texts) / 4

        db = FakeDB()
        client = _make_client(db)

        r = client.post(
            "/v1/embed",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-3", "texts": texts},
        )

        assert r.status_code == 200
        assert r.json() == {"embeddings": canned_embeddings}
        assert len(db.usage_calls) == 1
        call = db.usage_calls[0]
        assert call["kind"] == "embed"
        assert call["raw_units"] == pytest.approx(expected_raw_units)

    def test_not_invited_403(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(invited=False)
        client = _make_client(db)

        r = client.post(
            "/v1/embed",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-3", "texts": ["hello"]},
        )

        assert r.status_code == 403

    def test_over_cap_429(self, monkeypatch):
        _patch_verify_ok(monkeypatch)
        db = FakeDB(cost=5.0, cap_value=5.0)  # at-cap → 429
        client = _make_client(db)

        r = client.post(
            "/v1/embed",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-3", "texts": ["hello"]},
        )

        assert r.status_code == 429

    def test_invalid_jwt_401(self, monkeypatch):
        _patch_verify_401(monkeypatch)
        db = FakeDB()
        client = _make_client(db)

        r = client.post(
            "/v1/embed",
            headers=AUTH_HEADER,
            json={"meeting_id": "mtg-3", "texts": ["hello"]},
        )

        assert r.status_code == 401
