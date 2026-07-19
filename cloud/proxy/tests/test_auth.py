"""Tests for app/auth.py — ES256 JWT verification via mocked JWKS client."""
import time
import pytest
import jwt as pyjwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from fastapi import HTTPException

from app.auth import verify_jwt, AuthedUser
import app.auth as auth_module


# ---------------------------------------------------------------------------
# Shared EC keypair for tests
# ---------------------------------------------------------------------------

_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_PUBLIC_KEY = _PRIVATE_KEY.public_key()

_PRIVATE_KEY_PEM = _PRIVATE_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)

_WRONG_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_WRONG_PUBLIC_KEY = _WRONG_PRIVATE_KEY.public_key()
_WRONG_PRIVATE_KEY_PEM = _WRONG_PRIVATE_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)


# ---------------------------------------------------------------------------
# Helper: make a signed ES256 token
# ---------------------------------------------------------------------------

def make_token(private_key_pem=None, **overrides):
    """Return a signed ES256 JWT. Uses _PRIVATE_KEY_PEM by default."""
    if private_key_pem is None:
        private_key_pem = _PRIVATE_KEY_PEM
    base = {
        "sub": "u-1",
        "email": "a@b.com",
        "aud": "authenticated",
        "exp": int(time.time()) + 60,
    }
    base.update(overrides)
    return pyjwt.encode(base, private_key_pem, algorithm="ES256")


# ---------------------------------------------------------------------------
# Fixture: monkeypatch _client() so it returns the correct public key
# ---------------------------------------------------------------------------

class _FakeSigningKey:
    """Mimics the object returned by PyJWKClient.get_signing_key_from_jwt."""
    def __init__(self, public_key):
        self.key = public_key


class _FakeJWKSClient:
    """Returns the correct signing key without any network call."""
    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return _FakeSigningKey(self._public_key)


@pytest.fixture(autouse=True)
def reset_jwks_client():
    """Reset the module-level JWKS client singleton before each test."""
    original = auth_module._jwks_client
    auth_module._jwks_client = None
    yield
    auth_module._jwks_client = original


def _patch_client(monkeypatch, public_key=None):
    """Patch app.auth._client to return a fake JWKS client using *public_key*."""
    if public_key is None:
        public_key = _PUBLIC_KEY
    fake = _FakeJWKSClient(public_key)
    monkeypatch.setattr("app.auth._client", lambda: fake)
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_valid_token_returns_user(monkeypatch):
    _patch_client(monkeypatch)
    token = make_token()
    u = await verify_jwt(f"Bearer {token}")
    assert u == AuthedUser(user_id="u-1", email="a@b.com")


@pytest.mark.asyncio
async def test_expired_token_401(monkeypatch):
    _patch_client(monkeypatch)
    token = make_token(exp=int(time.time()) - 10)
    with pytest.raises(HTTPException) as exc:
        await verify_jwt(f"Bearer {token}")
    assert exc.value.status_code == 401
    assert exc.value.detail == "expired"


@pytest.mark.asyncio
async def test_missing_bearer_401(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    with pytest.raises(HTTPException) as exc:
        await verify_jwt(None)
    assert exc.value.status_code == 401
    assert exc.value.detail == "missing_bearer"


@pytest.mark.asyncio
async def test_wrong_key_401(monkeypatch):
    """Token signed by a different key must be rejected as invalid_token."""
    # Patch client to verify with the CORRECT public key,
    # but sign the token with a DIFFERENT private key.
    _patch_client(monkeypatch, public_key=_PUBLIC_KEY)
    token = make_token(private_key_pem=_WRONG_PRIVATE_KEY_PEM)
    with pytest.raises(HTTPException) as exc:
        await verify_jwt(f"Bearer {token}")
    assert exc.value.status_code == 401
    assert exc.value.detail == "invalid_token"
