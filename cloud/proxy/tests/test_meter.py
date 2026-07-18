import pytest
from app.meter import estimate_cost, record_usage, USD_PER_AUDIO_SECOND, USD_PER_TOKEN
from app.auth import AuthedUser


class FakeDB:
    """Records the last insert_usage call for assertion."""
    def __init__(self):
        self.last_call = None

    async def insert_usage(self, **kwargs):
        self.last_call = kwargs


# ---------------------------------------------------------------------------
# estimate_cost
# ---------------------------------------------------------------------------

def test_estimate_cost_transcribe():
    result = estimate_cost("transcribe", 60)
    assert result == pytest.approx(60 * USD_PER_AUDIO_SECOND)


def test_estimate_cost_summarize():
    result = estimate_cost("summarize", 1000)
    assert result == pytest.approx(1000 * USD_PER_TOKEN)


def test_estimate_cost_embed():
    result = estimate_cost("embed", 500)
    assert result == pytest.approx(500 * USD_PER_TOKEN)


def test_estimate_cost_unknown_raises():
    with pytest.raises(ValueError):
        estimate_cost("unknown_kind", 100)


# ---------------------------------------------------------------------------
# record_usage
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_record_usage_passes_correct_fields():
    db = FakeDB()
    user = AuthedUser(user_id="u-42", email="test@example.com")
    await record_usage(db, user, kind="transcribe", raw_units=30.0)

    expected_cost = estimate_cost("transcribe", 30.0)
    assert db.last_call is not None
    assert db.last_call["user_id"] == "u-42"
    assert db.last_call["email"] == "test@example.com"
    assert db.last_call["kind"] == "transcribe"
    assert db.last_call["raw_units"] == 30.0
    assert db.last_call["est_cost_usd"] == pytest.approx(expected_cost)


@pytest.mark.asyncio
async def test_record_usage_summarize_correct_cost():
    db = FakeDB()
    user = AuthedUser(user_id="u-1", email="a@b.com")
    await record_usage(db, user, kind="summarize", raw_units=2000.0)

    expected_cost = estimate_cost("summarize", 2000.0)
    assert db.last_call["est_cost_usd"] == pytest.approx(expected_cost)


@pytest.mark.asyncio
async def test_record_usage_embed_correct_cost():
    db = FakeDB()
    user = AuthedUser(user_id="u-2", email="b@c.com")
    await record_usage(db, user, kind="embed", raw_units=5000.0)

    expected_cost = estimate_cost("embed", 5000.0)
    assert db.last_call["est_cost_usd"] == pytest.approx(expected_cost)
