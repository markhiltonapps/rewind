import pytest
from fastapi import HTTPException
from app.gates import assert_invited, assert_under_cap

class FakeDB:
    def __init__(self, invited=True, month=0.0, cap=None):
        self._invited, self._month, self._cap = invited, month, cap
    async def is_invited(self, email): return self._invited
    async def month_cost(self, uid): return self._month
    async def cap(self, uid): return self._cap

@pytest.mark.asyncio
async def test_not_invited_403():
    with pytest.raises(HTTPException) as e:
        await assert_invited("x@y.com", FakeDB(invited=False))
    assert e.value.status_code == 403 and e.value.detail == "not_invited"

@pytest.mark.asyncio
async def test_invited_ok():
    await assert_invited("x@y.com", FakeDB(invited=True))  # no raise

@pytest.mark.asyncio
async def test_over_default_cap_429():
    with pytest.raises(HTTPException) as e:
        await assert_under_cap("u", FakeDB(month=5.01), default_cap=5.0)
    assert e.value.status_code == 429 and e.value.detail == "monthly_limit_reached"

@pytest.mark.asyncio
async def test_under_cap_ok():
    await assert_under_cap("u", FakeDB(month=1.0, cap=10.0), default_cap=5.0)

@pytest.mark.asyncio
async def test_per_user_cap_override_used():
    # user cap of 2.0 overrides the 5.0 default -> 2.5 is over
    with pytest.raises(HTTPException) as e:
        await assert_under_cap("u", FakeDB(month=2.5, cap=2.0), default_cap=5.0)
    assert e.value.status_code == 429
