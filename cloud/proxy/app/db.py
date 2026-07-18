"""Real Supabase database client for the rewind-proxy service.

Backed by Supabase PostgREST via httpx. Reads credentials from env:
  SUPABASE_URL              — e.g. https://xyzcompany.supabase.co
  SUPABASE_SERVICE_ROLE_KEY — service-role key (never logged)

This class is NOT unit-tested here because it requires a live Supabase
instance. Integration / smoke tests belong in a separate test file that
is skipped unless SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
"""

from __future__ import annotations

import os
from datetime import date, timezone, datetime

import httpx


class SupabaseDB:
    """Async PostgREST client implementing the interface expected by
    app.gates and app.meter."""

    def __init__(self) -> None:
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # not logged
        self._base = f"{url}/rest/v1"
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------
    # gates interface
    # ------------------------------------------------------------------

    async def is_invited(self, email: str) -> bool:
        """Return True if *email* exists in the invites table."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self._base}/invites",
                params={"email": f"eq.{email}", "select": "email"},
                headers=self._headers,
            )
            resp.raise_for_status()
            return len(resp.json()) > 0

    async def month_cost(self, user_id: str) -> float:
        """Return total est_cost_usd for *user_id* in the current calendar month."""
        first_of_month = date.today().replace(day=1).isoformat()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self._base}/usage_events",
                params={
                    "user_id": f"eq.{user_id}",
                    "created_at": f"gte.{first_of_month}",
                    "select": "est_cost_usd",
                },
                headers=self._headers,
            )
            resp.raise_for_status()
            rows = resp.json()
        return sum(row["est_cost_usd"] for row in rows)

    async def cap(self, user_id: str) -> float | None:
        """Return the monthly_cost_cap_usd for *user_id*, or None if unset."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self._base}/account_limits",
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "monthly_cost_cap_usd",
                },
                headers=self._headers,
            )
            resp.raise_for_status()
            rows = resp.json()
        if not rows:
            return None
        return rows[0]["monthly_cost_cap_usd"]

    # ------------------------------------------------------------------
    # meter interface
    # ------------------------------------------------------------------

    async def insert_usage(
        self,
        user_id: str,
        email: str,
        kind: str,
        raw_units: float,
        est_cost_usd: float,
    ) -> None:
        """Insert one row into usage_events."""
        payload = {
            "user_id": user_id,
            "email": email,
            "kind": kind,
            "raw_units": raw_units,
            "est_cost_usd": est_cost_usd,
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._base}/usage_events",
                json=payload,
                headers={**self._headers, "Prefer": "return=minimal"},
            )
            resp.raise_for_status()
