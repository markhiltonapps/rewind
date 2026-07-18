# Phase 1 — Cloud AI Proxy + Accounts (Design)

**Date:** 2026-07-18
**Status:** Design approved (pending written-spec review)
**Owner:** Mark Hilton (Neato Ventures)
**Depends on:** nothing (first commercialization phase)
**Blocks:** Phase 2 (code signing), Phase 3 (web/signup/download), Phase 4 (billing)

## 1. Goal

Let Neato Rewind be distributed to other people using **Mark's single Gemini
key for all users**, without the key ever shipping inside the app (where it
would leak and expose uncapped cost). Introduce user **accounts** and
**per-account usage caps** so cost is controlled and metered.

This is the foundation for commercialization: it fixes the key-leak risk,
establishes accounts, and gives a usage ledger that later phases (billing)
build on.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Cloud stack | **Supabase** (Auth + Postgres) + a dedicated proxy service |
| Proxy architecture | **Approach A** — dedicated FastAPI service on Cloud Run that reuses the existing Python Gemini code |
| Cost control | **Invite-only** beta **+ per-account monthly cap** |
| Audio handling | **Pass-through, store nothing** (design kept storage-*ready* for a later phase) |
| Sign-in | **Google OAuth + email magic link** |

## 3. Architecture

```
Desktop app ──login (Supabase JWT)──►  rewind-proxy (Cloud Run)  ──Mark's key──► Gemini
     │                                        │
     └───────────────► Supabase ◄─────────────┘
                (Auth · invites · usage/quota in Postgres)
```

Three units, each independently understandable and testable:

1. **Supabase** — Auth (Google + email magic link) and Postgres (invite list,
   usage ledger, per-account caps).
2. **rewind-proxy** — the ONLY holder of the Gemini key. A small FastAPI
   service on Cloud Run (scale-to-zero). Reuses the Gemini
   transcription/summary/embedding logic already in `backend/app/`.
3. **Desktop app** — gains a sign-in screen and, in `cloud` mode, sends all AI
   work to the proxy instead of calling Gemini directly.

**Key safety:** `BUNDLED_GEMINI_KEY` is removed from shipped builds. The key
exists only as a Cloud Run secret. This is the core purpose of the phase.

## 4. Auth & accounts

- **Providers:** Google OAuth + email magic link (passwordless). Managed by
  Supabase Auth.
- **Desktop sign-in flow:** user clicks "Sign in with Google" → app opens the
  system browser → Supabase completes auth → redirects back into the app via a
  registered deep link (`rewind://auth-callback`) → app stores the session and
  refreshes it silently thereafter.
- **Invite-only gate:** enforced at the proxy. A validly-logged-in but
  un-invited user gets a friendly "you're on the waitlist" response. Invites
  are rows in an `invites` table (Mark approves emails).

## 5. Proxy service (`rewind-proxy`)

FastAPI on Cloud Run. Endpoints mirror the three Gemini operations the app does
today:

- `POST /v1/transcribe` — compressed audio → transcript
- `POST /v1/summarize` — transcript text → summary JSON
- `POST /v1/embed` — text chunks → embedding vectors

**Per-request pipeline (identical for all three):**
1. Verify the Supabase JWT (reject invalid/expired).
2. Confirm the caller's email is in `invites`.
3. Confirm the account is under its monthly cap (see §6).
4. Call Gemini with the server-side key, reusing the existing Python logic.
5. Append a `usage_events` row.
6. Return the result.

Audio is streamed to Gemini and **discarded** — nothing persisted server-side
in Phase 1.

**Key handling:** Gemini key is a Cloud Run secret / env var, never returned to
the client, never logged.

## 6. Metering & quota (Supabase Postgres)

Tables:

- **`invites`** — `(email PRIMARY KEY, created_at, note)`. Invite-only gate.
- **`usage_events`** — append-only ledger:
  `(id, user_id, email, kind, raw_units, est_cost_usd, created_at)`.
  `kind ∈ {transcribe, summarize, embed}`. `raw_units` keeps the natural unit
  for auditing (audio-seconds for transcribe, tokens for summarize/embed);
  `est_cost_usd` is the normalized cost derived from Gemini's pricing.
- **`account_limits`** (optional; a global default applies when absent) —
  `(user_id, monthly_cost_cap_usd)`.

**Quota enforcement:** the cap is a single **monthly estimated-cost cap** so all
three operations share one honest currency (a mixed audio-seconds/tokens cap
would be apples-to-oranges). Before step 4, the proxy sums the current calendar
month's `est_cost_usd` for the user and compares it to their cap (per-user
override or the global default). Over cap → HTTP 429 with
`{"error":"monthly_limit_reached"}`. In practice transcription dominates the
cost, so the cap effectively bounds recording volume.

This ledger is also the cost dashboard and the seed for Phase 4 billing.

## 7. Desktop app refactor (non-breaking rollout)

The overriding constraint: **do not break the working local app.**

- **`ai_mode` setting:** `local` (today's direct-to-Gemini behavior) or
  `cloud` (via the proxy). Dev builds keep `local` available; **commercial
  release builds default to `cloud`.**
- **Where it changes:** the three call sites in `backend/app/main.py`
  (`/transcribe-audio`, the summary path, the embeddings path) branch on
  `ai_mode`. In `cloud` mode they call the proxy with the Supabase JWT; in
  `local` mode they behave exactly as today.
- **Recovery fallback (reuse existing):** the app already saves a recovery WAV
  and shows "recording saved locally" when transcription fails. That mechanism
  is unchanged and now also covers proxy-unreachable / quota / auth errors — so
  an outage degrades gracefully and never loses audio.
- **Audio compression:** compress WAV → Opus (via the already-bundled ffmpeg)
  before upload. ~30× smaller; lowers bandwidth and Gemini cost.
- **Sign-in gate:** `cloud` mode requires a logged-in session; signed-out shows
  the sign-in screen instead of recording-with-no-transcription.

## 8. Audio handling (pass-through, storage-ready)

Phase 1 stores nothing server-side. To keep a future storage phase cheap to add:
the proxy endpoints and the `usage_events` ledger are keyed by `user_id` +
a per-request `meeting_id`, so a later phase can add an audio/transcript store
keyed the same way without reworking the API.

## 9. Error handling

| Condition | Behavior |
|---|---|
| Session expired | Silent refresh; if that fails, prompt re-login |
| Not invited | "You're on the waitlist" message |
| Over monthly cap | "Monthly limit reached" message |
| Proxy unreachable / Gemini error | Recovery WAV saved + retry (existing pattern) |

## 10. Testing

- **Proxy unit tests:** JWT verification, invite gate, quota enforcement (under
  / at / over cap), key never leaked in responses/logs.
- **Proxy integration test:** transcribe a short sample end-to-end against
  Gemini; assert a usage row is written with correct units.
- **App end-to-end:** short recording in `cloud` mode produces a transcript +
  summary; a forced proxy failure falls back to a recovery WAV (no data loss).
- **Cost accuracy:** recorded `units` match the actual audio length / token
  counts within tolerance.

## 11. Out of scope for Phase 1 (future phases)

- Server-side storage of audio/transcripts (kept *compatible*, not built).
- Billing / Stripe / paid tiers (Phase 4).
- Microsoft sign-in.
- macOS support (separate track).
- The browser extension (Chrome-tab-switch fix) — independent.

## 12. Prerequisites Mark must provide (for the build phase)

These need Mark's accounts and can't be provisioned autonomously:

1. A **Supabase project** (or authorize creating one).
2. **Google OAuth credentials** (Google Cloud console) for "Sign in with Google."
3. A **Google Cloud project + Cloud Run** (or chosen host) to deploy the proxy.
4. The **Gemini API key with active billing** (to store as the Cloud Run secret).
5. A **domain** for the proxy (optional but recommended, e.g. `api.getneato…`).

## 13. Risks / open questions

- **Cost at scale:** every user's transcription bills to Mark's key. The
  monthly cap + invite-only bound this in Phase 1; billing (Phase 4) makes it
  sustainable.
- **Privacy posture shift:** audio now transits Mark's server (not only Google).
  A privacy policy is needed before public distribution.
- **Large audio:** mitigated by client-side Opus compression; Cloud Run has no
  hard request-size wall like Edge Functions, but very long meetings should be
  validated end-to-end.
- **Desktop deep-link auth:** `rewind://` callback registration must work across
  the installer; validate on a clean machine.
