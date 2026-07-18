# Cloud AI Proxy + Accounts (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all of Rewind's Gemini usage through a server-side proxy that holds Mark's key, gated by Supabase accounts (invite-only, per-account monthly cost cap), so the app can be distributed without the key leaking.

**Architecture:** Desktop app authenticates with Supabase (Google / magic link) and, in `cloud` mode, sends transcription/summary/embedding work to a FastAPI proxy on Cloud Run. The proxy verifies the JWT, enforces invite + monthly-cost cap against Supabase Postgres, calls Gemini with a server-side key, meters usage, and returns the result. The existing local path stays intact behind an `ai_mode` switch.

**Tech Stack:** Supabase (Auth + Postgres), FastAPI + `google-genai` on Cloud Run, Tauri desktop app (Rust + Next.js), `@supabase/supabase-js`, ffmpeg (Opus compression).

## Global Constraints

- The Gemini key MUST NOT appear in any shipped app artifact or client response/log. It exists only as a Cloud Run secret. Remove `BUNDLED_GEMINI_KEY` from release builds.
- Do not break the existing `local` AI path — it remains the default in dev builds and the fallback mechanism (recovery WAV) is unchanged.
- Audio is pass-through only: the proxy stores no audio in Phase 1.
- Cost cap is a single **monthly estimated-USD cap per account**; over cap → HTTP 429 `{"error":"monthly_limit_reached"}`.
- Invite-only: a valid JWT whose email is not in `invites` → HTTP 403 `{"error":"not_invited"}`.
- Spec of record: `docs/superpowers/specs/2026-07-18-cloud-ai-proxy-phase1-design.md`.

---

## Decomposition & sequencing

Three milestones behind a prerequisites gate. Each milestone is independently testable and should be its own review cycle:

- **Milestone 0 — Prerequisites (Mark, manual).** Cloud accounts/credentials. Blocks everything.
- **Milestone 1 — Supabase foundation.** Schema + auth config. Testable via SQL + a login round-trip.
- **Milestone 2 — Proxy service.** FastAPI proxy, deployed. Testable via `curl` with a real JWT, independent of the app.
- **Milestone 3 — Desktop app integration.** Sign-in + `ai_mode=cloud` + fallback. Testable end-to-end.

> Milestones 2 and 3 are large enough that, before executing each, the implementer should re-read this plan's milestone section and the spec. If desired, split M2 and M3 into their own plan files at execution time.

---

## Milestone 0 — Prerequisites (manual, Mark)

Not code; a gate. Nothing in M1–M3 can be deployed/tested until these exist. Capture the resulting values in a local `.env` (never committed).

- [ ] **Create a Supabase project.** Record `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the JWT signing secret / JWKS URL.
- [ ] **Enable auth providers** in Supabase: Email (magic link) and Google. For Google, create OAuth credentials in Google Cloud Console (Authorized redirect URI = the Supabase callback shown in the Supabase Google provider settings). Record Google client id/secret into Supabase.
- [ ] **Create a Google Cloud project + enable Cloud Run** (or choose Fly/Render — the plan assumes Cloud Run; adjust deploy commands if different).
- [ ] **Provision a Gemini API key with active billing** (this is the server key). Record as `GEMINI_API_KEY` for the proxy secret. (This is the depleted-credits fix at the product level.)
- [ ] **(Optional) Register a domain/subdomain** for the proxy, e.g. `api.<yourdomain>`; otherwise use the Cloud Run URL.
- [ ] **Register the desktop deep-link scheme** decision: `rewind://auth-callback` (used in M3; no action now, just confirm the scheme name).

**Gate:** M1 starts only once `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GEMINI_API_KEY` exist.

---

## Milestone 1 — Supabase foundation

**File Structure:**
- Create: `cloud/supabase/migrations/0001_phase1_schema.sql` — invites, usage_events, account_limits + RLS.
- Create: `cloud/supabase/seed_invite.sql` — helper to add an invite.
- Create: `cloud/README.md` — how to apply migrations (Supabase CLI or SQL editor).

**Interfaces produced (consumed by M2):**
- Table `invites(email text primary key, created_at timestamptz default now(), note text)`.
- Table `usage_events(id bigint identity pk, user_id uuid, email text, kind text check in ('transcribe','summarize','embed'), raw_units double precision, est_cost_usd double precision, created_at timestamptz default now())`.
- Table `account_limits(user_id uuid primary key, monthly_cost_cap_usd double precision)`.
- Convention: default monthly cap = `5.00` USD when no `account_limits` row.

### Task 1.1: Schema migration

**Files:**
- Create: `cloud/supabase/migrations/0001_phase1_schema.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- invites: only these emails may use the proxy (invite-only gate)
create table if not exists public.invites (
  email      text primary key,
  created_at timestamptz not null default now(),
  note       text
);

-- usage_events: append-only metering ledger
create table if not exists public.usage_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  email         text not null,
  kind          text not null check (kind in ('transcribe','summarize','embed')),
  raw_units     double precision not null,   -- audio-seconds or tokens (audit)
  est_cost_usd  double precision not null,   -- normalized cost (cap currency)
  created_at    timestamptz not null default now()
);
create index if not exists usage_events_user_month_idx
  on public.usage_events (user_id, created_at);

-- account_limits: optional per-user override of the global default cap
create table if not exists public.account_limits (
  user_id             uuid primary key,
  monthly_cost_cap_usd double precision not null
);

-- RLS: clients never touch these directly; the proxy uses the service role
-- (which bypasses RLS). Enable RLS with no policies so anon/auth keys can't read.
alter table public.invites        enable row level security;
alter table public.usage_events   enable row level security;
alter table public.account_limits enable row level security;
```

- [ ] **Step 2: Apply it** (Supabase SQL editor, or `supabase db push` if using the CLI). Expected: three tables exist, RLS enabled, no policies.

- [ ] **Step 3: Verify** — in the SQL editor run `select count(*) from usage_events;` → returns `0`. `insert into invites(email) values ('mark@…');` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add cloud/supabase/migrations/0001_phase1_schema.sql
git commit -m "feat(cloud): Phase 1 Supabase schema — invites, usage ledger, caps"
```

### Task 1.2: Auth config + login smoke test

**Files:** none (Supabase console config) + `cloud/README.md` notes.

- [ ] **Step 1:** In Supabase Auth settings, confirm Email (magic link) and Google are enabled (from M0). Add `rewind://auth-callback` and `http://localhost` to the allowed redirect URLs.
- [ ] **Step 2:** Smoke-test login via the Supabase-hosted auth UI or a 10-line local HTML page using `@supabase/supabase-js` `signInWithOtp` — confirm you receive a JWT.
- [ ] **Step 3:** Decode the JWT (jwt.io) and confirm it carries `sub` (user_id) and `email`. These are what the proxy will read.
- [ ] **Step 4: Commit** the README notes.

```bash
git add cloud/README.md
git commit -m "docs(cloud): Supabase auth config + JWT claims we rely on"
```

**Milestone 1 done when:** tables exist with RLS, and a real login yields a JWT containing `sub` + `email`.

---

## Milestone 2 — Proxy service (`rewind-proxy`)

**File Structure:**
- Create: `cloud/proxy/app/main.py` — FastAPI app + routes.
- Create: `cloud/proxy/app/auth.py` — verify Supabase JWT → `{user_id, email}`.
- Create: `cloud/proxy/app/gates.py` — invite check + monthly-cost-cap check (Supabase queries).
- Create: `cloud/proxy/app/meter.py` — write `usage_events` + Gemini cost estimate.
- Create: `cloud/proxy/app/gemini.py` — transcription/summary/embedding calls (lifted from `backend/app/main.py` + `transcript_processor.py` + `embeddings.py`).
- Create: `cloud/proxy/tests/…` — pytest suite.
- Create: `cloud/proxy/Dockerfile`, `cloud/proxy/requirements.txt`.

**Interfaces produced (consumed by M3):**
- `POST /v1/transcribe` — multipart `audio` (Opus/wav) + `meeting_id` form field; `Authorization: Bearer <jwt>` → `{"transcript": str}`.
- `POST /v1/summarize` — JSON `{meeting_id, text, model?}` → `{"summary": <json>}`.
- `POST /v1/embed` — JSON `{meeting_id, texts: [str]}` → `{"embeddings": [[float]]}`.
- All: `403 not_invited`, `429 monthly_limit_reached`, `401 invalid_token` as specified.

### Task 2.1: JWT verification

**Files:**
- Create: `cloud/proxy/app/auth.py`
- Test: `cloud/proxy/tests/test_auth.py`

**Interfaces:**
- Produces: `async def verify_jwt(authorization: str) -> AuthedUser` where `AuthedUser = dataclass(user_id: str, email: str)`. Raises `HTTPException(401)` on missing/invalid/expired.

- [ ] **Step 1: Write the failing test**

```python
# cloud/proxy/tests/test_auth.py
import pytest, time, jwt as pyjwt
from app.auth import verify_jwt, AuthedUser
from fastapi import HTTPException

SECRET = "test-secret"  # in prod: Supabase JWT secret / JWKS

def make_token(**claims):
    base = {"sub": "u-1", "email": "a@b.com", "exp": int(time.time()) + 60}
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
```

- [ ] **Step 2: Run → FAIL** (`app.auth` not found). `cd cloud/proxy && pytest tests/test_auth.py -v`
- [ ] **Step 3: Implement**

```python
# cloud/proxy/app/auth.py
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
```

> Note: Supabase signs with HS256 using the project JWT secret; if the project uses asymmetric JWKS, swap `decode` for JWKS verification. Confirm in M1 which the project uses.

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `git add cloud/proxy/app/auth.py cloud/proxy/tests/test_auth.py && git commit -m "feat(proxy): Supabase JWT verification"`

### Task 2.2: Invite + monthly-cost-cap gates

**Files:**
- Create: `cloud/proxy/app/gates.py`
- Test: `cloud/proxy/tests/test_gates.py`

**Interfaces:**
- Consumes: `AuthedUser` (2.1).
- Produces: `async def assert_invited(email: str, db) -> None` (raises `HTTPException(403,'not_invited')`); `async def assert_under_cap(user_id: str, db, default_cap=5.0) -> None` (raises `HTTPException(429,'monthly_limit_reached')`). `db` is an injected async Supabase/Postgres client; tests use a fake exposing `.month_cost(user_id)`, `.cap(user_id)`, `.is_invited(email)`.

- [ ] **Step 1: Write failing tests** (fake db):

```python
# cloud/proxy/tests/test_gates.py
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
    assert e.value.status_code == 403

@pytest.mark.asyncio
async def test_over_default_cap_429():
    with pytest.raises(HTTPException) as e:
        await assert_under_cap("u", FakeDB(month=5.01), default_cap=5.0)
    assert e.value.status_code == 429

@pytest.mark.asyncio
async def test_under_cap_ok():
    await assert_under_cap("u", FakeDB(month=1.0, cap=10.0))  # no raise
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement**

```python
# cloud/proxy/app/gates.py
from fastapi import HTTPException

async def assert_invited(email: str, db) -> None:
    if not await db.is_invited(email):
        raise HTTPException(status_code=403, detail="not_invited")

async def assert_under_cap(user_id: str, db, default_cap: float = 5.0) -> None:
    cap = await db.cap(user_id)
    cap = default_cap if cap is None else cap
    if await db.month_cost(user_id) >= cap:
        raise HTTPException(status_code=429, detail="monthly_limit_reached")
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 2.3: Metering + cost estimate

**Files:**
- Create: `cloud/proxy/app/meter.py`
- Test: `cloud/proxy/tests/test_meter.py`

**Interfaces:**
- Produces: `def estimate_cost(kind: str, raw_units: float) -> float` using the current Gemini 2.5 Flash pricing constants (copy from `backend/app/costs.py`); `async def record_usage(db, user, kind, raw_units) -> None` inserts a `usage_events` row with `est_cost_usd = estimate_cost(...)`.

- [ ] **Step 1: Test** `estimate_cost('transcribe', 60)` returns a positive float matching the pricing constant × 60. (Copy exact constants from `backend/app/costs.py`; assert against them.)
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** `estimate_cost` (constants from `costs.py`) + `record_usage` (insert via the injected db).
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 2.4: Gemini calls (lift existing code)

**Files:**
- Create: `cloud/proxy/app/gemini.py`
- Test: `cloud/proxy/tests/test_gemini_contract.py` (mock the `google-genai` client — assert we call it with the server key and parse results; do NOT hit the network in unit tests).

**Interfaces:**
- Produces: `async def transcribe(audio_bytes, mime) -> tuple[str, float]` (transcript, audio_seconds); `async def summarize(text, model) -> dict`; `async def embed(texts) -> tuple[list[list[float]], int]` (vectors, token_count). Key read from `os.environ['GEMINI_API_KEY']`.

- [ ] **Step 1:** Copy the transcription (`/transcribe-audio` handler), summary (`transcript_processor.process_transcript`), and embedding (`embeddings._embed_batch`) logic from `backend/app/` into `gemini.py`, adapted to take the key from env and return `(result, units)`.
- [ ] **Step 2:** Write contract tests with a mocked `genai.Client`.
- [ ] **Step 3:** Run → PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(proxy): Gemini transcription/summary/embed lifted from backend"`

### Task 2.5: Routes wiring the pipeline

**Files:**
- Create: `cloud/proxy/app/main.py`
- Test: `cloud/proxy/tests/test_routes.py` (FastAPI `TestClient`, all deps overridden with fakes).

**Interfaces:** the three `/v1/*` endpoints (see milestone header). Each: `verify_jwt` → `assert_invited` → `assert_under_cap` → `gemini.*` → `record_usage` → return.

- [ ] **Step 1: Write route tests** for the happy path + `403`/`429`/`401` using dependency overrides (fake db, fake gemini). Assert a `usage_events` insert happens on success and does NOT happen on gate rejection.
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** the FastAPI app: dependency-inject `verify_jwt` and a real Supabase db client (`app/db.py` thin wrapper over the service-role REST/`postgrest`), and wire the pipeline.
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 2.6: Containerize + deploy to Cloud Run

**Files:**
- Create: `cloud/proxy/Dockerfile`, `cloud/proxy/requirements.txt`, `cloud/proxy/.dockerignore`.

- [ ] **Step 1:** Write `requirements.txt` (fastapi, uvicorn, pyjwt, httpx/postgrest, google-genai) and a slim `Dockerfile` (`python:3.12-slim`, `uvicorn app.main:app`).
- [ ] **Step 2:** Build locally, run with env vars pointing at Supabase + a test Gemini key; `curl` `/v1/summarize` with a real JWT from M1 → expect a summary and a new `usage_events` row.
- [ ] **Step 3:** Deploy: `gcloud run deploy rewind-proxy --source cloud/proxy --set-secrets GEMINI_API_KEY=…,SUPABASE_JWT_SECRET=…,SUPABASE_SERVICE_ROLE_KEY=… --region … --allow-unauthenticated`. Record the service URL.
- [ ] **Step 4:** Repeat the `curl` against the deployed URL. Verify `403` for a non-invited email and `429` when the cap is manually lowered.
- [ ] **Step 5: Commit** the Dockerfile/requirements.

**Milestone 2 done when:** the deployed proxy transcribes/summarizes/embeds for an invited, under-cap user via `curl`, meters each call, and correctly returns `403`/`429`/`401`.

---

## Milestone 3 — Desktop app integration

**File Structure:**
- Create: `frontend/src/lib/authClient.ts` — `@supabase/supabase-js` client + session storage + deep-link handler.
- Create: `frontend/src/components/SignIn.tsx` — Google + magic-link UI.
- Create: `frontend/src/lib/aiClient.ts` — calls the proxy (`/v1/*`) with the JWT; used when `ai_mode=cloud`.
- Modify: `backend/app/main.py` — the three AI call sites branch on `ai_mode` (`cloud` → forward to proxy; `local` → existing behavior). *(Simplest seam: the local backend proxies to the cloud proxy so the Rust/UI layer barely changes. Alternative: call the proxy from the frontend directly — decide at execution; the plan assumes the local-backend seam to minimize app churn.)*
- Modify: `frontend/src-tauri/tauri.conf.json` — register the `rewind://` deep link; remove bundled key wiring for release.
- Modify: `backend/app/keys.py` / `_resolve_gemini_api_key` — release builds must not carry a bundled key.

**Interfaces consumed:** the proxy `/v1/*` endpoints (M2) and the Supabase session JWT.

### Task 3.1: `ai_mode` switch + local path preserved (non-breaking)

- [ ] **Step 1:** Add an `ai_mode` setting (default `local` in dev, `cloud` in release) read in `backend/app/main.py`.
- [ ] **Step 2:** Write a test that with `ai_mode=local`, `/transcribe-audio` behaves exactly as today (existing tests still pass).
- [ ] **Step 3:** Add the `cloud` branch that forwards the (compressed) audio + JWT to `POST {PROXY_URL}/v1/transcribe` and returns its transcript; on any error, fall through to the existing recovery-WAV path.
- [ ] **Step 4:** Test the `cloud` branch against a stubbed proxy (success + forced failure → recovery WAV written).
- [ ] **Step 5: Commit.**

### Task 3.2: Sign-in flow (Google + magic link) with deep-link callback

- [ ] **Step 1:** Add `@supabase/supabase-js`; build `authClient.ts` (init, `signInWithOAuth('google')`, `signInWithOtp`, session persistence, silent refresh).
- [ ] **Step 2:** Register `rewind://auth-callback` in `tauri.conf.json` + a Rust deep-link handler that hands the callback URL to the webview to complete the session.
- [ ] **Step 3:** Build `SignIn.tsx`; gate `cloud` mode on a session (signed-out → show SignIn).
- [ ] **Step 4:** Manual test on a clean machine: Google sign-in opens browser, returns to app, session persists across restart.
- [ ] **Step 5: Commit.**

### Task 3.3: Client-side Opus compression before upload

- [ ] **Step 1:** Before `POST /v1/transcribe`, transcode the WAV → Opus with the bundled ffmpeg.
- [ ] **Step 2:** Verify a real recording round-trips (Opus upload → transcript) and is ~30× smaller than the WAV.
- [ ] **Step 3: Commit.**

### Task 3.4: Remove the bundled key from release; end-to-end

- [ ] **Step 1:** Ensure release builds resolve NO Gemini key locally (cloud mode only); `grep` the built artifact to confirm the key string is absent.
- [ ] **Step 2:** End-to-end: signed-in invited user records a short Meet → transcript + summary come back via the proxy; a `usage_events` row is written; over-cap shows the limit message; signed-out shows SignIn.
- [ ] **Step 3:** Confirm `local` dev builds still work unchanged.
- [ ] **Step 4: Commit.**

**Milestone 3 done when:** a signed-in invited user gets transcription/summary through the proxy end-to-end, the key is provably absent from release artifacts, and dev `local` mode is unchanged.

---

## Self-review notes

- **Spec coverage:** accounts/auth (M1.2, M3.2), invite-only (1.1, 2.2), monthly cost cap (1.1, 2.2, 2.3), proxy endpoints (2.1–2.5), key-off-client (3.4), non-breaking rollout + recovery fallback (3.1), Opus compression (3.3), pass-through/no-storage (2.4/2.5 store nothing), testing (per-task) — all present.
- **Placeholders:** none intended; the one deliberate execution-time decision (local-backend seam vs frontend-direct) is flagged in M3 file structure, not left vague in a step.
- **Type consistency:** `AuthedUser(user_id,email)` used consistently 2.1→2.2→2.5; gate function names (`assert_invited`, `assert_under_cap`) consistent; `record_usage`/`estimate_cost` consistent.
- **Deferred verification:** Supabase JWT alg (HS256 vs JWKS) confirmed in M1 and swapped in 2.1 if needed — called out, not silently assumed.
