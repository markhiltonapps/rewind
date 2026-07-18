import os
from dataclasses import dataclass
import jwt as pyjwt
from fastapi import HTTPException

@dataclass(frozen=True)
class AuthedUser:
    user_id: str
    email: str

async def verify_jwt(authorization: str | None) -> AuthedUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    token = authorization.split(" ", 1)[1]
    secret = os.environ["SUPABASE_JWT_SECRET"]
    try:
        claims = pyjwt.decode(
            token, secret, algorithms=["HS256"], audience="authenticated"
        )
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="invalid_token")
    sub, email = claims.get("sub"), claims.get("email")
    if not sub or not email:
        raise HTTPException(status_code=401, detail="missing_claims")
    return AuthedUser(user_id=sub, email=email)
