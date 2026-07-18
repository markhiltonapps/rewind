from fastapi import HTTPException

async def assert_invited(email: str, db) -> None:
    if not await db.is_invited(email):
        raise HTTPException(status_code=403, detail="not_invited")

async def assert_under_cap(user_id: str, db, default_cap: float = 5.0) -> None:
    cap = await db.cap(user_id)
    cap = default_cap if cap is None else cap
    if await db.month_cost(user_id) >= cap:
        raise HTTPException(status_code=429, detail="monthly_limit_reached")
