import os
from dataclasses import dataclass
import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import HTTPException

@dataclass(frozen=True)
class AuthedUser:
    user_id: str
    email: str

_jwks_client: PyJWKClient | None = None

def _client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        url = f"{os.environ['SUPABASE_URL']}/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(url)
    return _jwks_client

async def verify_jwt(authorization: str | None) -> AuthedUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    token = authorization.split(" ", 1)[1]
    try:
        signing_key = _client().get_signing_key_from_jwt(token)
        claims = pyjwt.decode(
            token, signing_key.key, algorithms=["ES256"], audience="authenticated"
        )
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="expired")
    except Exception:
        raise HTTPException(status_code=401, detail="invalid_token")
    sub, email = claims.get("sub"), claims.get("email")
    if not sub or not email:
        raise HTTPException(status_code=401, detail="missing_claims")
    return AuthedUser(user_id=sub, email=email)
