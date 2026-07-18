import pytest, time, jwt as pyjwt
from app.auth import verify_jwt, AuthedUser
from fastapi import HTTPException

SECRET = "test-secret"

def make_token(**claims):
    base = {"sub": "u-1", "email": "a@b.com", "aud": "authenticated",
            "exp": int(time.time()) + 60}
    base.update(claims)
    return pyjwt.encode(base, SECRET, algorithm="HS256")

@pytest.mark.asyncio
async def test_valid_token_returns_user(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    u = await verify_jwt(f"Bearer {make_token()}")
    assert u == AuthedUser(user_id="u-1", email="a@b.com")

@pytest.mark.asyncio
async def test_expired_token_401(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    with pytest.raises(HTTPException) as e:
        await verify_jwt(f"Bearer {make_token(exp=1)}")
    assert e.value.status_code == 401

@pytest.mark.asyncio
async def test_missing_bearer_401(monkeypatch):
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    with pytest.raises(HTTPException) as e:
        await verify_jwt(None)
    assert e.value.status_code == 401
