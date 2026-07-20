# Neato Rewind — Landing Page & Self-Serve Install Flow Design

**Status:** Approved (design)
**Date:** 2026-07-20
**Author:** Mark Hilton / Neato Ventures LLC
**Depends on:** Phase 1 Cloud AI Proxy (Supabase Auth + `invites` table + Cloud Run proxy), M3 app→proxy wiring (verified 2026-07-20)

---

## Goal

Ship a polished public marketing website for Neato Rewind with a high-end hero
section, plus a self-serve funnel that lets a visitor sign up, download the
Windows app, sign in, and start using it immediately — all bounded by the
existing per-user and a new global cost cap so the shared Gemini key can't be
abused.

## Success Criteria

1. A visitor at the site can enter their email and, in one step, be granted
   access (added to `invites`) and shown the Windows download link.
2. The downloaded installer is a **cloud-mode build**: it talks to the Cloud
   Run proxy and contains **no** Gemini key.
3. A brand-new user can open the installed app, request a sign-in code,
   **receive a numeric code by email**, enter it, and reach the app.
4. Signup is idempotent and protected by a global cap that stops new invites
   once a configurable ceiling is reached (spend backstop).
5. The macOS "Notify me" button captures interested emails for later.
6. The site is deployed to Vercel at a `*.vercel.app` URL, with the production
   domain swappable via a single environment variable.

## Non-Goals (this phase)

- Code signing / notarization (Windows SmartScreen warning remains — Phase 2).
- A real macOS build/download (waitlist capture only).
- Payments/pricing, accounts dashboard, CAPTCHA, or email drip campaigns.
- Analytics beyond a basic page-view counter (optional, deferred).

---

## Architecture Overview

```
                          ┌──────────────────────────────┐
   Visitor ──▶ Vercel  ──▶│  Next.js marketing site (web/)│
                          │  - Hero + sections (static)   │
                          │  - Signup form                │
                          │  - /api/signup  (serverless)  │──┐ service_role
                          │  - /api/notify-macos          │  │ (server-only)
                          └──────────────────────────────┘  │
                                                             ▼
                                   ┌───────────────────────────────────┐
                                   │ Supabase (project feronxsrxawc... )│
                                   │  - invites table (self-serve add)  │
                                   │  - mac_waitlist table (new)        │
                                   │  - site_limits / global cap (new)  │
                                   │  - Auth email via Resend SMTP (new)│
                                   │  - Storage: public "downloads"     │
                                   └───────────────────────────────────┘
                                                             ▲
   Windows installer (cloud-mode build) ─── uploaded to ────┘
```

The desktop app itself is unchanged in wiring (M3 already routes AI through the
proxy). This project adds: the website, the signup/notify APIs, two small
Supabase tables + a global-cap check, Resend SMTP for real sign-in emails, a
public download bucket, and a documented cloud-mode release build.

---

## Components

### C1. Marketing website (`web/`)

- **Stack:** Next.js (App Router) + Tailwind, matching the desktop frontend's
  toolchain. New top-level `web/` directory in the `rewind` monorepo; its own
  `package.json`, independent of `frontend/`.
- **Rendering:** Hero and all content sections are static. Only the two API
  routes run server-side.
- **Visual direction:** "Dark Premium" (approved) — deep navy radial-gradient
  hero, blue→violet accent (`#6ea8ff`→`#9b7bff`), app screenshot centered.
- **Sections (approved order):** Hero → compatibility strip (Teams/Meet/Zoom) →
  How it works (3 steps) → Features (6 tiles) → Privacy band → Signup/Download
  CTA → Footer (brand + Privacy/Terms/Support + © Neato Ventures LLC).
- **Config:** `NEXT_PUBLIC_SITE_URL` (for canonical/OG), `DOWNLOAD_WINDOWS_URL`
  (public bucket link). Domain swap = change env + Vercel domain mapping.

### C2. Signup API — `POST /api/signup`

Server-side (Vercel function). Holds `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
from Vercel env (never exposed to the browser).

Request: `{ email: string }`. Behavior:
1. Validate email format; normalize to lowercase/trim.
2. **Global-cap check:** count rows in `invites`; if `>= site_limits.max_invited`
   → return `{ status: "waitlisted" }` (still record to `mac_waitlist`-style
   `overflow_waitlist`, see C4) and DO NOT reveal download.
3. Upsert `email` into `invites` (idempotent; `on conflict do nothing`).
4. Return `{ status: "ok", downloadUrl: DOWNLOAD_WINDOWS_URL }`.

Errors: invalid email → 400 `{ status: "invalid" }`; unexpected → 500
`{ status: "error" }`. The client reveals the download only on `status: "ok"`.

### C3. macOS notify API — `POST /api/notify-macos`

Request `{ email }`. Validates and upserts into `mac_waitlist(email, created_at)`.
Returns `{ status: "ok" }`. Idempotent.

### C4. Supabase schema additions (migration `0002_landing`)

- `mac_waitlist(email text primary key, created_at timestamptz default now())`
- `overflow_waitlist(email text primary key, created_at timestamptz default now())`
  — emails that hit the global cap, for later manual invite.
- `site_limits(id int primary key default 1, max_invited int not null default 200)`
  — single-row table holding the global cap; seed one row with a chosen ceiling.
- RLS enabled on all three, **no public policies** (only the service-role API
  writes them), matching the Phase 1 pattern.

### C5. Download hosting

- Public Supabase Storage bucket `downloads`.
- Object: `NeatoRewind-Setup-<version>-x64.exe` (the NSIS installer).
- `DOWNLOAD_WINDOWS_URL` = the bucket's public object URL, set in Vercel env.
- **The uploaded installer MUST be a cloud-mode build** (see C6).

### C6. Cloud-mode release build (was "M3 Piece 4")

Produce the distributable installer with cloud settings baked in at build time:
- `NEXT_PUBLIC_AI_MODE=cloud`
- `REWIND_AI_MODE=cloud`
- `REWIND_PROXY_URL=https://rewind-proxy-236465589949.us-west2.run.app`
- Bundled Gemini key **empty/removed** (no key ships in the artifact).

Deliverable: documented build command/env + the produced `.exe` uploaded to the
`downloads` bucket. Verify the artifact contains no Gemini key string.

### C7. Production email sign-in (Resend SMTP)

- Create a Resend account + verified sending domain (or Resend's shared domain
  for beta), get SMTP credentials.
- Configure Supabase Auth → SMTP with Resend (removes the built-in mailer's
  rate limit).
- Set the Auth email template so the message contains the **numeric OTP**
  (`{{ .Token }}`) that the app's existing code-entry screen expects — not just
  a magic link.
- Result: any invited user can request a code, receive it, and sign in. The
  app's `SignIn.tsx` (now accepting 6–8 digit codes) is already compatible.

---

## Data Flow: end-to-end funnel

1. Visitor lands on the site (Vercel).
2. Enters email in the CTA → `POST /api/signup`.
3. API adds them to `invites` (under global cap) → returns download URL.
4. Page reveals "Download for Windows" → they download the cloud-mode installer
   from the Supabase `downloads` bucket.
5. They install (accept the one-time SmartScreen "More info → Run anyway" until
   Phase 2 signing) and open the app.
6. App is in cloud mode → shows sign-in → they enter their email → request code.
7. Supabase (via Resend) emails the numeric code → they enter it → signed in.
8. They record a meeting → app → local backend (cloud mode) → proxy → Gemini →
   metered per-user in `usage_events`, bounded by their per-user cap.

## Error Handling

- **Signup at cap:** friendly "You're on the list — we'll email you when a spot
  opens" (recorded to `overflow_waitlist`); no download shown.
- **Invalid email:** inline field error; no API write.
- **API/network failure:** non-blocking toast "Something went wrong, try again";
  the download is never revealed without an `ok`.
- **Duplicate signup:** treated as success (idempotent) — re-reveals download.
- **macOS notify duplicate/invalid:** same idempotent/validation rules.

## Security & Cost

- `SUPABASE_SERVICE_ROLE_KEY` lives only in Vercel server env; never shipped to
  the browser or the desktop app.
- Three cost guardrails: existing **per-user cap** (`account_limits`), new
  **global invite cap** (`site_limits.max_invited`) at signup, and Resend/
  Supabase send limits.
- No Gemini key in the installer (C6 verification).
- Note (rotations): the service-role and Gemini keys are slated for rotation by
  the owner; after rotating service-role, update both the Cloud Run secret and
  the Vercel env.

## Testing

- **Signup API:** unit tests for valid/invalid email, idempotent upsert,
  at-cap → waitlisted, service-role never in client bundle.
- **Notify API:** valid/invalid/idempotent.
- **Global cap:** seed `site_limits.max_invited` low in a test and assert the
  N+1th signup is waitlisted, not invited.
- **Build verification (C6):** grep the built artifact/bundle for any Gemini key
  string → must be absent; assert cloud env baked in.
- **Manual E2E:** one real run of the full funnel (signup → download → install →
  code email via Resend → sign in → record → `usage_events` row).

## Rollout Order (informs the plan)

1. Supabase schema additions (C4) — safe, additive.
2. Resend SMTP + code template (C7) — unblocks real sign-in.
3. Cloud-mode release build + upload to bucket (C5, C6).
4. Website + signup/notify APIs (C1, C2, C3) wired to the above.
5. Deploy to Vercel; manual E2E; (later) map `neatorewind.com`.

## Open Questions (deferred, non-blocking)

- Exact `max_invited` ceiling — pick a number at implementation (default 200).
- Whether to add a lightweight page-view counter — deferred.
- Real macOS build — future phase.
