# Landing Page & Self-Serve Install Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Dark-Premium marketing site on Vercel with an instant self-serve signup that adds visitors to the Supabase `invites` table (under a global cap) and hands them a cloud-mode Windows installer, plus the sign-in-email fix that makes the funnel work end to end.

**Architecture:** A new `web/` Next.js app (static hero/sections + two serverless API routes) talks to Supabase with a server-only service-role key. New Supabase tables gate the cap and capture waitlists. Resend becomes Supabase's SMTP provider so real users receive numeric sign-in codes. The distributed installer is rebuilt in cloud mode (no bundled key) and hosted in a public Supabase Storage bucket.

**Tech Stack:** Next.js 14.2.x (App Router) · React 18 · TailwindCSS 3.4 · TypeScript 5.7 · `@supabase/supabase-js` ^2.110 · Vitest (web tests) · Supabase (Postgres + Auth + Storage) · Resend (SMTP) · Vercel · Tauri 2 / NSIS (installer).

## Global Constraints

- Product name is exactly **Neato Rewind**; company is **Neato Ventures LLC**.
- Supabase project ref: `feronxsrxawcxhjllpxg`; URL `https://feronxsrxawcxhjllpxg.supabase.co`.
- Proxy URL (verbatim): `https://rewind-proxy-236465589949.us-west2.run.app`.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only: it may appear in Vercel server env and Supabase, **never** in any `NEXT_PUBLIC_*` var, browser bundle, or desktop artifact.
- New tables use the Phase 1 pattern: **RLS enabled, no policies** (only the service-role reaches them).
- Visual direction is **Dark Premium**: bg `#070a14`, panel `#0f1526`, hero radial `radial-gradient(120% 120% at 50% 0%, #1b2440 0%, #0b0f1c 60%, #070a14 100%)`, accent gradient `#6ea8ff`→`#9b7bff`, text `#eef1f8`/`#aeb8d0`/`#7f8db0`, hairline border `rgba(255,255,255,.08)`.
- Approved section order: Hero → compatibility strip → How it works (3) → Features (6) → Privacy band → Signup/Download CTA → Footer.
- The distributed installer MUST be a cloud-mode build with an **empty** `BUNDLED_GEMINI_KEY`.
- Global cap lives in `site_limits.max_invited` (single source of truth), default **200**.
- Signup and notify endpoints are **idempotent**.

---

## File Structure

**Supabase / build (no app code):**
- `cloud/supabase/migrations/0002_landing.sql` — new tables + seed.
- `docs/ops/cloud-mode-build.md` — documented cloud-mode build + upload steps.

**Web app (`web/`):**
- `web/package.json`, `web/next.config.mjs`, `web/tsconfig.json`, `web/tailwind.config.ts`, `web/postcss.config.mjs`, `web/vitest.config.ts` — scaffold/config.
- `web/src/app/layout.tsx`, `web/src/app/globals.css` — root shell + theme.
- `web/src/app/page.tsx` — the landing page (composes sections).
- `web/src/components/Nav.tsx`, `Hero.tsx`, `Compat.tsx`, `HowItWorks.tsx`, `Features.tsx`, `PrivacyBand.tsx`, `SignupCTA.tsx`, `Footer.tsx` — sections.
- `web/src/components/SignupForm.tsx` — client form (used by Hero + SignupCTA).
- `web/src/components/MacNotifyButton.tsx` — client macOS capture.
- `web/src/lib/supabaseAdmin.ts` — server-only admin client + dep factories.
- `web/src/lib/signup.ts` — pure `processSignup(email, deps)`.
- `web/src/lib/notify.ts` — pure `processNotify(email, deps)`.
- `web/src/lib/email.ts` — shared email validation.
- `web/src/app/api/signup/route.ts`, `web/src/app/api/notify-macos/route.ts` — thin route wrappers.
- `web/src/lib/__tests__/signup.test.ts`, `notify.test.ts`, `email.test.ts` — unit tests.
- `web/.env.example`, `web/README.md` — env documentation.

---

## Task 1: Supabase schema additions (`0002_landing`)

**Files:**
- Create: `cloud/supabase/migrations/0002_landing.sql`

**Interfaces:**
- Produces: tables `public.mac_waitlist(email pk, created_at)`, `public.overflow_waitlist(email pk, created_at)`, `public.site_limits(id pk, max_invited)` with one seeded row `{id:1, max_invited:200}`.

- [ ] **Step 1: Write the migration**

Create `cloud/supabase/migrations/0002_landing.sql`:

```sql
-- Phase 3 — landing page + self-serve install flow.
-- See docs/superpowers/specs/2026-07-20-landing-page-and-install-flow-design.md
-- Same pattern as 0001: RLS enabled, NO policies. Only the service-role
-- key (used by the Vercel /api routes) reaches these tables.

-- mac_waitlist: emails from the "macOS — Notify me" button.
create table if not exists public.mac_waitlist (
  email      text primary key,
  created_at timestamptz not null default now()
);

-- overflow_waitlist: signups that arrived after the global invite cap was hit.
create table if not exists public.overflow_waitlist (
  email      text primary key,
  created_at timestamptz not null default now()
);

-- site_limits: single-row global cap. When invites count >= max_invited,
-- new signups are waitlisted instead of invited (spend backstop).
create table if not exists public.site_limits (
  id          int primary key default 1,
  max_invited int not null default 200
);

insert into public.site_limits (id, max_invited)
  values (1, 200)
  on conflict (id) do nothing;

alter table public.mac_waitlist      enable row level security;
alter table public.overflow_waitlist enable row level security;
alter table public.site_limits       enable row level security;
```

- [ ] **Step 2: Apply the migration to Supabase**

Apply via the Supabase MCP `apply_migration` tool (name `0002_landing`, the SQL above) against project `feronxsrxawcxhjllpxg`. (If MCP is unavailable, run the SQL in the Supabase SQL editor.)

- [ ] **Step 3: Verify the tables and seed exist**

Run this read via Supabase MCP `execute_sql` (project `feronxsrxawcxhjllpxg`):

```sql
select (select count(*) from public.mac_waitlist)      as mac,
       (select count(*) from public.overflow_waitlist) as overflow,
       (select max_invited from public.site_limits where id = 1) as cap;
```

Expected: `mac=0, overflow=0, cap=200`.

- [ ] **Step 4: Commit**

```bash
git add cloud/supabase/migrations/0002_landing.sql
git commit -m "feat(cloud): add landing-page schema (waitlists + global cap)"
```

---

## Task 2: Resend SMTP + numeric-code sign-in email

**Files:** none (Supabase + Resend dashboard config). Produces working email delivery of a numeric OTP.

**Interfaces:**
- Produces: a Supabase Auth config where `signInWithOtp({email})` sends an email **containing the numeric code** (`{{ .Token }}`), delivered via Resend (no built-in-mailer rate limit).

- [ ] **Step 1: Create a Resend account + sending identity**

Sign up at https://resend.com. Either verify a domain you control, or use Resend's onboarding/shared sending domain for beta. In Resend → **API Keys / SMTP**, note the SMTP host (`smtp.resend.com`), port (`465`), username (`resend`), and the generated password (an API key). Do **not** paste the key into chat — enter it directly in Supabase in Step 2.

- [ ] **Step 2: Point Supabase Auth at Resend SMTP**

Supabase Dashboard → **Project Settings → Authentication → SMTP Settings** (Custom SMTP): enable it and enter:
- Sender email: an address on your verified/allowed domain (e.g. `login@…`).
- Sender name: `Neato Rewind`.
- Host: `smtp.resend.com`, Port: `465`, Username: `resend`, Password: the Resend key.
Save.

- [ ] **Step 3: Make the email contain the numeric code**

Supabase Dashboard → **Authentication → Emails** → the **Magic Link** template (this is the template `signInWithOtp` for email uses). Replace the body so it includes the code token:

```html
<h2>Your Neato Rewind sign-in code</h2>
<p>Enter this code in the app to sign in:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>This code expires shortly. If you didn't request it, you can ignore this email.</p>
```

Save.

- [ ] **Step 4: (Optional) set OTP length to 6**

Supabase Dashboard → **Authentication → Providers → Email** → set **OTP length** to `6` for a friendlier code. (The app already accepts 6–8 digits, so this is cosmetic; leave default if you prefer.)

- [ ] **Step 5: Verify end to end (real email)**

In a terminal, trigger a real OTP send (replace with your address):

```bash
curl -s -X POST "https://feronxsrxawcxhjllpxg.supabase.co/auth/v1/otp" \
  -H "apikey: sb_publishable_S_JknkWrscDQu-NrRc8q1Q_1ip7OyId" \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_EMAIL","create_user":true}'
```

Expected: HTTP 200, and within ~1 minute an email arrives **containing a numeric code** (not just a link). This confirms Resend delivery + the token template. No code change; nothing to commit.

---

## Task 3: Cloud-mode release build + public download bucket

**Files:**
- Create: `docs/ops/cloud-mode-build.md`
- Temporarily set for the build only: `backend/app/keys.py` (`BUNDLED_GEMINI_KEY = ""`)

**Interfaces:**
- Produces: a public URL `DOWNLOAD_WINDOWS_URL` serving a cloud-mode NSIS installer that contains no Gemini key.

- [ ] **Step 1: Document the cloud-mode build**

Create `docs/ops/cloud-mode-build.md`:

```markdown
# Building the cloud-mode Windows installer

The distributed installer must (a) route all AI through the proxy and
(b) contain NO Gemini key.

1. Blank the bundled key for the build:
   - In `backend/app/keys.py` set `BUNDLED_GEMINI_KEY = ""`.
     (Do NOT commit this change if the file is tracked with a real key;
     it's a build-time state. See "Key rotation" below.)
2. Build with cloud env baked in (PowerShell, from `frontend/`):

   $env:NEXT_PUBLIC_AI_MODE = "cloud"
   $env:REWIND_AI_MODE = "cloud"
   $env:REWIND_PROXY_URL = "https://rewind-proxy-236465589949.us-west2.run.app"
   pnpm tauri build

3. Artifact: `frontend/src-tauri/target/release/bundle/nsis/Neato Rewind_0.1.0_x64-setup.exe`.
4. Verify no key shipped (see Step 3 of the plan task).

## Key rotation (do soon)
`backend/app/keys.py` currently contains a real Gemini key in git history.
Rotate the key in Google AI Studio, keep the new key ONLY in the Cloud Run
proxy secret (`GEMINI_API_KEY`) — never in the repo or the installer.
```

- [ ] **Step 2: Build the installer in cloud mode**

Set `BUNDLED_GEMINI_KEY = ""` in `backend/app/keys.py`, then from `frontend/` run the PowerShell build in the doc above. Expected: build succeeds and produces the NSIS `-setup.exe`.

- [ ] **Step 3: Verify the artifact contains no Gemini key**

Google Gemini keys start with `AIza`. Scan the built app payload:

```bash
grep -rc "AIza" "frontend/src-tauri/target/release/" | grep -v ":0$" || echo "NO KEY FOUND (good)"
```

Expected: `NO KEY FOUND (good)`. If any match appears, the bundled key was not blanked — fix `keys.py` and rebuild before continuing.

- [ ] **Step 4: Create the public downloads bucket and upload**

Supabase Dashboard → **Storage** → New bucket → name `downloads`, **Public** = on. Upload the verified `-setup.exe`, renaming it `NeatoRewind-Setup-0.1.0-x64.exe`. Copy its public URL (looks like `https://feronxsrxawcxhjllpxg.supabase.co/storage/v1/object/public/downloads/NeatoRewind-Setup-0.1.0-x64.exe`). This is `DOWNLOAD_WINDOWS_URL`.

- [ ] **Step 5: Confirm the URL downloads**

```bash
curl -sI "DOWNLOAD_WINDOWS_URL" | head -5
```

Expected: `HTTP/2 200` and a `content-type` of `application/octet-stream` (or similar binary type).

- [ ] **Step 6: Commit the doc**

```bash
git add docs/ops/cloud-mode-build.md
git commit -m "docs(ops): document cloud-mode installer build + download hosting"
```

(Do not commit the temporary `keys.py` blanking if it would remove/rotate the tracked key — that's handled under Key rotation.)

---

## Task 4: Scaffold `web/` Next.js app + Dark-Premium theme shell

**Files:**
- Create: `web/package.json`, `web/next.config.mjs`, `web/tsconfig.json`, `web/postcss.config.mjs`, `web/tailwind.config.ts`, `web/vitest.config.ts`, `web/.gitignore`
- Create: `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/src/app/page.tsx` (placeholder), `web/.env.example`

**Interfaces:**
- Produces: a runnable Next.js app in `web/` with Tailwind theme tokens `bg-rw`, `panel`, `accentFrom`/`accentTo`, text colors, and a dark `<body>`.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "neato-rewind-web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3200",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.110.7",
    "next": "14.2.35",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "autoprefixer": "^10.4.17",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create config files**

`web/next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
export default nextConfig;
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020", "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true, "skipLibCheck": true, "strict": true, "noEmit": true,
    "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler",
    "resolveJsonModule": true, "isolatedModules": true, "jsx": "preserve",
    "incremental": true, "paths": { "@/*": ["./src/*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`web/postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`web/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rwbg: '#070a14', rwpanel: '#0f1526', rwpanel2: '#0b1120',
        rwtext: '#eef1f8', rwtext2: '#aeb8d0', rwtext3: '#7f8db0',
        accentFrom: '#6ea8ff', accentTo: '#9b7bff',
      },
      borderColor: { rwline: 'rgba(255,255,255,0.08)' },
      backgroundImage: {
        'rw-hero': 'radial-gradient(120% 120% at 50% 0%, #1b2440 0%, #0b0f1c 60%, #070a14 100%)',
        'rw-accent': 'linear-gradient(135deg, #6ea8ff, #9b7bff)',
      },
    },
  },
  plugins: [],
};
export default config;
```

`web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

`web/.gitignore`:
```
node_modules/
.next/
.env.local
```

`web/.env.example`:
```
# Server-only (Vercel: uncheck "expose to browser")
SUPABASE_URL=https://feronxsrxawcxhjllpxg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=__set_in_vercel__
DOWNLOAD_WINDOWS_URL=__public_bucket_url__
# Public
NEXT_PUBLIC_SITE_URL=http://localhost:3200
```

- [ ] **Step 3: Create the theme shell**

`web/src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
html, body { background: #070a14; color: #eef1f8; }
* { -webkit-font-smoothing: antialiased; }
```

`web/src/app/layout.tsx`:
```tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Neato Rewind — Never lose a meeting again',
  description:
    'Auto-records, transcribes, and summarizes your Teams & Google Meet calls — privately, on your PC.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-rwbg text-rwtext antialiased">{children}</body>
    </html>
  );
}
```

`web/src/app/page.tsx` (placeholder, replaced in Task 5):
```tsx
export default function Home() {
  return <main className="min-h-screen grid place-items-center text-rwtext3">web scaffold ok</main>;
}
```

- [ ] **Step 4: Install and verify it runs**

```bash
cd web && npm install && npm run build
```
Expected: `next build` completes with no type errors; the route `/` compiles.

- [ ] **Step 5: Commit**

```bash
git add web/ && git commit -m "feat(web): scaffold Next.js marketing app + Dark-Premium theme"
```

---

## Task 5: Landing page sections (static)

**Files:**
- Create: `web/src/components/Nav.tsx`, `Hero.tsx`, `Compat.tsx`, `HowItWorks.tsx`, `Features.tsx`, `PrivacyBand.tsx`, `SignupCTA.tsx`, `Footer.tsx`
- Modify: `web/src/app/page.tsx`

**Interfaces:**
- Consumes: Tailwind tokens from Task 4.
- Produces: `<Hero/>` and `<SignupCTA/>` each render a `<SignupForm/>` slot (Task 6 fills it). For now they render a placeholder `<div id="signup-hero"/>` / `<div id="signup-cta"/>` so this task stays static and independently testable.

- [ ] **Step 1: Create the section components**

Create each file with the approved copy and Dark-Premium classes. `web/src/components/Hero.tsx`:
```tsx
export function Hero() {
  return (
    <section className="bg-rw-hero px-6 pt-10 pb-16">
      <div className="mx-auto max-w-5xl">
        <h1 className="mt-14 text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.05]">
          Never lose a<br />meeting again.
        </h1>
        <p className="mt-4 max-w-xl text-rwtext2 text-lg leading-relaxed">
          Auto-records, transcribes, and summarizes your Teams &amp; Google Meet
          calls — privately, right on your PC.
        </p>
        <div id="signup-hero" className="mt-7" />
        <p className="mt-3 text-sm text-rwtext3">Free while in beta · No credit card</p>
      </div>
    </section>
  );
}
```

`web/src/components/Nav.tsx`:
```tsx
export function Nav() {
  return (
    <nav className="mx-auto max-w-5xl px-6 pt-7 flex items-center justify-between text-sm">
      <span className="flex items-center gap-2 font-bold">
        <span className="inline-block h-3.5 w-3.5 rotate-45 rounded-[3px] bg-rw-accent" />
        Neato Rewind
      </span>
      <span className="flex gap-5 text-rwtext2">
        <a href="#how">How it works</a><a href="#features">Features</a><a href="#get">Sign in</a>
      </span>
    </nav>
  );
}
```

`web/src/components/Compat.tsx`:
```tsx
export function Compat() {
  return (
    <section className="border-y border-rwline px-6 py-5 text-center text-rwtext3 text-sm">
      Works automatically with <b className="text-rwtext2">Microsoft Teams</b>,{' '}
      <b className="text-rwtext2">Google Meet</b>, and <b className="text-rwtext2">Zoom</b>{' '}
      — nothing to configure.
    </section>
  );
}
```

`web/src/components/HowItWorks.tsx`:
```tsx
const STEPS = [
  ['It detects your meeting.', 'The moment a Teams or Meet call starts, Rewind quietly begins recording. No “start” button to forget.'],
  ['It transcribes every word.', 'Speech becomes an accurate, searchable transcript — processed securely in the cloud, tied to your account.'],
  ['It hands you the summary.', 'Key points, decisions, and action items — written up and waiting when the call ends.'],
];
export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-5xl px-6 py-14">
      <div className="text-xs uppercase tracking-[0.18em] text-rwtext3">How it works</div>
      <h2 className="mt-3 text-2xl font-bold">From call to summary, automatically.</h2>
      <div className="mt-6 space-y-5">
        {STEPS.map(([t, d], i) => (
          <div key={i} className="flex gap-3">
            <span className="flex-none grid h-7 w-7 place-items-center rounded-full bg-[#1c2b4d] text-[#8fb4ff] text-sm font-bold">{i + 1}</span>
            <div><b>{t}</b><p className="text-rwtext2 leading-relaxed">{d}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

`web/src/components/Features.tsx`:
```tsx
const TILES = [
  ['🎙️', 'Auto-record', 'Starts and stops itself. One clean recording per meeting.'],
  ['📝', 'Transcripts', 'Accurate, timestamped, and fully searchable.'],
  ['✨', 'AI summaries', 'Decisions and action items, generated for you.'],
  ['🔒', 'Private by design', 'Recordings stay on your PC. You own your data.'],
  ['🔎', 'Instant recall', 'Search across every past meeting in seconds.'],
  ['⚡', 'Zero setup', 'Install, sign in, done. No bots, no calendar links.'],
];
export function Features() {
  return (
    <section id="features" className="mx-auto max-w-5xl px-6 py-14 border-t border-rwline">
      <div className="text-xs uppercase tracking-[0.18em] text-rwtext3">Features</div>
      <h2 className="mt-3 text-2xl font-bold">Everything, remembered.</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {TILES.map(([ic, t, d]) => (
          <div key={t} className="rounded-xl border border-rwline bg-rwpanel p-4">
            <div className="mb-2 grid h-8 w-8 place-items-center rounded-lg bg-[#1c2b4d]">{ic}</div>
            <b>{t}</b><p className="text-rwtext2 text-sm leading-relaxed">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

`web/src/components/PrivacyBand.tsx`:
```tsx
export function PrivacyBand() {
  return (
    <section className="bg-rwpanel2 px-6 py-14 border-t border-rwline">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-[0.18em] text-rwtext3">Privacy-first</div>
        <h2 className="mt-3 text-2xl font-bold">Your meetings never become someone else’s product.</h2>
        <p className="mt-3 max-w-xl text-rwtext2 leading-relaxed">
          Recordings and transcripts are stored locally on your machine. Cloud AI is used only to
          transcribe and summarize — nothing is sold, shared, or used to train models.
        </p>
      </div>
    </section>
  );
}
```

`web/src/components/SignupCTA.tsx`:
```tsx
export function SignupCTA() {
  return (
    <section id="get" className="bg-rw-hero px-6 py-16 text-center">
      <div className="mx-auto max-w-xl">
        <h2 className="text-3xl font-bold">Start remembering your meetings.</h2>
        <p className="mt-2 text-rwtext2">Enter your email to get instant access and the download.</p>
        <div id="signup-cta" className="mt-5" />
        <p className="mt-3 text-xs text-rwtext3">Instant access · Free while in beta · Windows now, macOS soon</p>
      </div>
    </section>
  );
}
```

`web/src/components/Footer.tsx`:
```tsx
export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 py-6 flex items-center justify-between text-xs text-rwtext3">
      <span className="flex items-center gap-2">
        <span className="inline-block h-3 w-3 rotate-45 rounded-[3px] bg-rw-accent" /> Neato Rewind
      </span>
      <span>Privacy · Terms · Support · © Neato Ventures LLC</span>
    </footer>
  );
}
```

- [ ] **Step 2: Compose the page**

Replace `web/src/app/page.tsx`:
```tsx
import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { Compat } from '@/components/Compat';
import { HowItWorks } from '@/components/HowItWorks';
import { Features } from '@/components/Features';
import { PrivacyBand } from '@/components/PrivacyBand';
import { SignupCTA } from '@/components/SignupCTA';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
    <main>
      <Nav /><Hero /><Compat /><HowItWorks /><Features /><PrivacyBand /><SignupCTA /><Footer />
    </main>
  );
}
```

- [ ] **Step 3: Build and eyeball**

```bash
cd web && npm run build && npm run dev
```
Expected: build passes; visiting `http://localhost:3200` shows the full dark page with all seven sections in order and the two empty signup slots.

- [ ] **Step 4: Commit**

```bash
git add web/src && git commit -m "feat(web): Dark-Premium landing page sections"
```

---

## Task 6: Signup flow — `/api/signup` + client form

**Files:**
- Create: `web/src/lib/email.ts`, `web/src/lib/supabaseAdmin.ts`, `web/src/lib/signup.ts`, `web/src/app/api/signup/route.ts`, `web/src/components/SignupForm.tsx`
- Create tests: `web/src/lib/__tests__/email.test.ts`, `web/src/lib/__tests__/signup.test.ts`
- Modify: `web/src/components/Hero.tsx`, `web/src/components/SignupCTA.tsx` (mount `<SignupForm/>`)

**Interfaces:**
- Produces: `isValidEmail(s: string): boolean`; `processSignup(email: string, deps: SignupDeps): Promise<SignupResult>` where
  ```ts
  type SignupResult =
    | { status: 'ok'; downloadUrl: string }
    | { status: 'waitlisted' }
    | { status: 'invalid' }
    | { status: 'error' };
  interface SignupDeps {
    countInvites(): Promise<number>;
    maxInvited(): Promise<number>;
    addInvite(email: string): Promise<void>;   // idempotent upsert
    addOverflow(email: string): Promise<void>;  // idempotent upsert
    downloadUrl: string;
  }
  ```
- `POST /api/signup` accepts `{email}` and returns the `SignupResult` as JSON with matching HTTP status (200 ok/waitlisted, 400 invalid, 500 error).

- [ ] **Step 1: Write the failing email test**

`web/src/lib/__tests__/email.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isValidEmail } from '../email';
describe('isValidEmail', () => {
  it('accepts a normal address', () => expect(isValidEmail('a@b.co')).toBe(true));
  it('rejects missing @', () => expect(isValidEmail('ab.co')).toBe(false));
  it('rejects empty', () => expect(isValidEmail('')).toBe(false));
  it('rejects spaces', () => expect(isValidEmail('a b@c.co')).toBe(false));
});
```

- [ ] **Step 2: Run it, expect failure**

`cd web && npm test` → FAIL (`isValidEmail` not found).

- [ ] **Step 3: Implement `email.ts`**

`web/src/lib/email.ts`:
```ts
const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && RE.test(s.trim());
}
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
```

- [ ] **Step 4: Run it, expect pass** — `cd web && npm test` → email tests PASS.

- [ ] **Step 5: Write the failing signup test**

`web/src/lib/__tests__/signup.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { processSignup, type SignupDeps } from '../signup';

function deps(over: Partial<SignupDeps> = {}): SignupDeps {
  return {
    countInvites: vi.fn().mockResolvedValue(0),
    maxInvited: vi.fn().mockResolvedValue(200),
    addInvite: vi.fn().mockResolvedValue(undefined),
    addOverflow: vi.fn().mockResolvedValue(undefined),
    downloadUrl: 'https://dl/setup.exe',
    ...over,
  };
}

describe('processSignup', () => {
  it('invalid email → invalid, no writes', async () => {
    const d = deps();
    const r = await processSignup('nope', d);
    expect(r).toEqual({ status: 'invalid' });
    expect(d.addInvite).not.toHaveBeenCalled();
  });
  it('under cap → ok + download, invites written', async () => {
    const d = deps();
    const r = await processSignup(' A@B.CO ', d);
    expect(r).toEqual({ status: 'ok', downloadUrl: 'https://dl/setup.exe' });
    expect(d.addInvite).toHaveBeenCalledWith('a@b.co');
  });
  it('at cap → waitlisted, overflow written, NOT invited', async () => {
    const d = deps({ countInvites: vi.fn().mockResolvedValue(200) });
    const r = await processSignup('a@b.co', d);
    expect(r).toEqual({ status: 'waitlisted' });
    expect(d.addOverflow).toHaveBeenCalledWith('a@b.co');
    expect(d.addInvite).not.toHaveBeenCalled();
  });
  it('db throws → error', async () => {
    const d = deps({ addInvite: vi.fn().mockRejectedValue(new Error('x')) });
    const r = await processSignup('a@b.co', d);
    expect(r).toEqual({ status: 'error' });
  });
});
```

- [ ] **Step 6: Run it, expect failure** — FAIL (`processSignup` not found).

- [ ] **Step 7: Implement `signup.ts`**

`web/src/lib/signup.ts`:
```ts
import { isValidEmail, normalizeEmail } from './email';

export interface SignupDeps {
  countInvites(): Promise<number>;
  maxInvited(): Promise<number>;
  addInvite(email: string): Promise<void>;
  addOverflow(email: string): Promise<void>;
  downloadUrl: string;
}
export type SignupResult =
  | { status: 'ok'; downloadUrl: string }
  | { status: 'waitlisted' }
  | { status: 'invalid' }
  | { status: 'error' };

export async function processSignup(email: string, deps: SignupDeps): Promise<SignupResult> {
  if (!isValidEmail(email)) return { status: 'invalid' };
  const addr = normalizeEmail(email);
  try {
    const [count, max] = await Promise.all([deps.countInvites(), deps.maxInvited()]);
    if (count >= max) {
      await deps.addOverflow(addr);
      return { status: 'waitlisted' };
    }
    await deps.addInvite(addr);
    return { status: 'ok', downloadUrl: deps.downloadUrl };
  } catch {
    return { status: 'error' };
  }
}
```

- [ ] **Step 8: Run it, expect pass** — `cd web && npm test` → all signup tests PASS.

- [ ] **Step 9: Implement the admin client + real deps**

`web/src/lib/supabaseAdmin.ts`:
```ts
import { createClient } from '@supabase/supabase-js';
import type { SignupDeps } from './signup';

function admin() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-only
  return createClient(url, key, { auth: { persistSession: false } });
}

export function signupDeps(): SignupDeps {
  const sb = admin();
  return {
    async countInvites() {
      const { count, error } = await sb.from('invites').select('email', { count: 'exact', head: true });
      if (error) throw error;
      return count ?? 0;
    },
    async maxInvited() {
      const { data, error } = await sb.from('site_limits').select('max_invited').eq('id', 1).single();
      if (error) throw error;
      return data.max_invited as number;
    },
    async addInvite(email) {
      const { error } = await sb.from('invites').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
      if (error) throw error;
    },
    async addOverflow(email) {
      const { error } = await sb.from('overflow_waitlist').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
      if (error) throw error;
    },
    downloadUrl: process.env.DOWNLOAD_WINDOWS_URL!,
  };
}

export function macNotify() {
  const sb = admin();
  return async (email: string) => {
    const { error } = await sb.from('mac_waitlist').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
    if (error) throw error;
  };
}
```

- [ ] **Step 10: Implement the route**

`web/src/app/api/signup/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { processSignup } from '@/lib/signup';
import { signupDeps } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let email = '';
  try { email = (await req.json())?.email ?? ''; } catch { /* empty */ }
  const result = await processSignup(email, signupDeps());
  const code = result.status === 'invalid' ? 400 : result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status: code });
}
```

- [ ] **Step 11: Implement the client form + mount it**

`web/src/components/SignupForm.tsx`:
```tsx
'use client';
import { useState } from 'react';

export function SignupForm({ variant = 'hero' }: { variant?: 'hero' | 'cta' }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'waitlisted' | 'error'>('idle');
  const [downloadUrl, setDownloadUrl] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('loading');
    try {
      const r = await fetch('/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (d.status === 'ok') { setDownloadUrl(d.downloadUrl); setState('ok'); }
      else if (d.status === 'waitlisted') setState('waitlisted');
      else setState('error');
    } catch { setState('error'); }
  }

  if (state === 'ok') {
    return (
      <a href={downloadUrl} className="inline-block rounded-lg bg-rw-accent px-5 py-3 font-semibold text-rwbg">
        ⬇ Download for Windows
      </a>
    );
  }
  if (state === 'waitlisted') return <p className="text-rwtext2">You’re on the list — we’ll email you when a spot opens.</p>;

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-3 items-center justify-center">
      <input
        type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className="rounded-lg border border-rwline bg-rwpanel2 px-4 py-3 text-rwtext placeholder:text-rwtext3 min-w-[240px]"
      />
      <button type="submit" disabled={state === 'loading'}
        className="rounded-lg bg-rw-accent px-5 py-3 font-semibold text-rwbg disabled:opacity-60">
        {state === 'loading' ? 'Working…' : variant === 'hero' ? '⬇ Get access' : 'Get access →'}
      </button>
      {state === 'error' && <p className="w-full text-sm text-red-400">Something went wrong — please try again.</p>}
    </form>
  );
}
```

Mount it: in `Hero.tsx` replace `<div id="signup-hero" className="mt-7" />` with `<div className="mt-7"><SignupForm variant="hero" /></div>` (and `import { SignupForm } from '@/components/SignupForm';`). In `SignupCTA.tsx` replace `<div id="signup-cta" className="mt-5" />` with `<div className="mt-5"><SignupForm variant="cta" /></div>` (add the import).

- [ ] **Step 12: Build + full test run**

```bash
cd web && npm test && npm run build
```
Expected: all Vitest tests pass; `next build` compiles including `/api/signup`.

- [ ] **Step 13: Commit**

```bash
git add web/src && git commit -m "feat(web): self-serve signup API + client form (cap-aware, idempotent)"
```

---

## Task 7: macOS notify — `/api/notify-macos` + button

**Files:**
- Create: `web/src/lib/notify.ts`, `web/src/app/api/notify-macos/route.ts`, `web/src/components/MacNotifyButton.tsx`
- Create test: `web/src/lib/__tests__/notify.test.ts`
- Modify: `web/src/components/Hero.tsx` (add the button beside the form)

**Interfaces:**
- Consumes: `isValidEmail` (Task 6), `macNotify()` (Task 6 `supabaseAdmin.ts`).
- Produces: `processNotify(email, deps)` with `interface NotifyDeps { addMac(email: string): Promise<void> }` returning `{status:'ok'|'invalid'|'error'}`; `POST /api/notify-macos` `{email}` → JSON + status (200/400/500).

- [ ] **Step 1: Write the failing test**

`web/src/lib/__tests__/notify.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { processNotify } from '../notify';
describe('processNotify', () => {
  it('valid → ok + write', async () => {
    const addMac = vi.fn().mockResolvedValue(undefined);
    expect(await processNotify(' X@Y.CO ', { addMac })).toEqual({ status: 'ok' });
    expect(addMac).toHaveBeenCalledWith('x@y.co');
  });
  it('invalid → invalid, no write', async () => {
    const addMac = vi.fn();
    expect(await processNotify('bad', { addMac })).toEqual({ status: 'invalid' });
    expect(addMac).not.toHaveBeenCalled();
  });
  it('throws → error', async () => {
    const addMac = vi.fn().mockRejectedValue(new Error('x'));
    expect(await processNotify('x@y.co', { addMac })).toEqual({ status: 'error' });
  });
});
```

- [ ] **Step 2: Run it, expect failure** — FAIL (`processNotify` not found).

- [ ] **Step 3: Implement `notify.ts`**

```ts
import { isValidEmail, normalizeEmail } from './email';
export interface NotifyDeps { addMac(email: string): Promise<void>; }
export type NotifyResult = { status: 'ok' | 'invalid' | 'error' };
export async function processNotify(email: string, deps: NotifyDeps): Promise<NotifyResult> {
  if (!isValidEmail(email)) return { status: 'invalid' };
  try { await deps.addMac(normalizeEmail(email)); return { status: 'ok' }; }
  catch { return { status: 'error' }; }
}
```

- [ ] **Step 4: Run it, expect pass** — `cd web && npm test` → notify tests PASS.

- [ ] **Step 5: Implement the route**

`web/src/app/api/notify-macos/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { processNotify } from '@/lib/notify';
import { macNotify } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let email = '';
  try { email = (await req.json())?.email ?? ''; } catch { /* empty */ }
  const result = await processNotify(email, { addMac: macNotify() });
  const code = result.status === 'invalid' ? 400 : result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status: code });
}
```

- [ ] **Step 6: Implement the button + mount it**

`web/src/components/MacNotifyButton.tsx`:
```tsx
'use client';
import { useState } from 'react';

export function MacNotifyButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');

  if (state === 'ok') return <span className="text-rwtext2 text-sm">Thanks — we’ll email you when macOS is ready.</span>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('loading');
    try {
      const r = await fetch('/api/notify-macos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setState(r.ok ? 'ok' : 'error');
    } catch { setState('error'); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="rounded-lg border border-rwline px-5 py-3 font-semibold text-rwtext2">
        macOS — Notify me
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex gap-2 items-center">
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className="rounded-lg border border-rwline bg-rwpanel2 px-3 py-2 text-rwtext placeholder:text-rwtext3" />
      <button type="submit" disabled={state === 'loading'}
        className="rounded-lg border border-rwline px-4 py-2 text-rwtext2">
        {state === 'loading' ? '…' : 'Notify me'}
      </button>
    </form>
  );
}
```

Mount in `Hero.tsx`: wrap the signup slot and button in a flex row, e.g. replace the signup `<div>` with:
```tsx
<div className="mt-7 flex flex-wrap items-center gap-3">
  <SignupForm variant="hero" />
  <MacNotifyButton />
</div>
```
(add `import { MacNotifyButton } from '@/components/MacNotifyButton';`).

- [ ] **Step 7: Build + full test run**

```bash
cd web && npm test && npm run build
```
Expected: all tests pass; build compiles both API routes.

- [ ] **Step 8: Commit**

```bash
git add web/src && git commit -m "feat(web): macOS notify-me capture (API + button)"
```

---

## Task 8: Deploy to Vercel

**Files:** none (Vercel dashboard/CLI + env).

**Interfaces:**
- Produces: a live `*.vercel.app` URL serving the site, with server env set.

- [ ] **Step 1: Create the Vercel project**

In the Vercel dashboard: **Add New → Project → import `markhiltonapps/rewind`**. Set **Root Directory = `web`**. Framework auto-detects Next.js. Do not deploy yet.

- [ ] **Step 2: Set environment variables**

In the project's **Settings → Environment Variables** (Production + Preview):
- `SUPABASE_URL` = `https://feronxsrxawcxhjllpxg.supabase.co` (server)
- `SUPABASE_SERVICE_ROLE_KEY` = the service-role key (server; **not** exposed to browser)
- `DOWNLOAD_WINDOWS_URL` = the public bucket URL from Task 3
- `NEXT_PUBLIC_SITE_URL` = the assigned `*.vercel.app` URL

- [ ] **Step 3: Deploy**

Trigger a deploy (push to `main`, or "Deploy" in the dashboard). Expected: build succeeds; the `*.vercel.app` URL renders the landing page.

- [ ] **Step 4: Smoke-test the live APIs**

```bash
curl -s -X POST "https://<your>.vercel.app/api/signup" \
  -H "Content-Type: application/json" -d '{"email":"bad"}'
```
Expected: `{"status":"invalid"}` with HTTP 400. (Full valid-signup E2E happens in Task 9 to avoid burning a real invite here.)

- [ ] **Step 5: Record the URL**

No commit. Note the live URL for Task 9 and for the eventual `neatorewind.com` mapping.

---

## Task 9: Manual end-to-end verification

**Files:** none. Gate before calling the funnel done.

- [ ] **Step 1: Fresh signup reveals the download**

On the live site, enter a **new** email in the hero form. Expected: the button flips to "⬇ Download for Windows". Verify in Supabase (`execute_sql`): `select email from invites where email='<that email>';` returns the row.

- [ ] **Step 2: Cap behavior**

Temporarily set the cap low to prove the branch: `update public.site_limits set max_invited = (select count(*) from public.invites) where id=1;` Then sign up with another new email. Expected: "You're on the list…"; the email appears in `overflow_waitlist`, not `invites`. **Restore** the cap: `update public.site_limits set max_invited = 200 where id=1;`

- [ ] **Step 3: macOS notify**

Click "macOS — Notify me", submit an email. Expected: success message; row present in `mac_waitlist`.

- [ ] **Step 4: Download + install + sign in**

Download the installer from the revealed link, install (accept the one-time SmartScreen "More info → Run anyway"), open the app. Request a sign-in code. Expected: a **numeric code email** arrives (via Resend); entering it signs you in.

- [ ] **Step 5: Record → cloud transcription is metered**

Record ~15 seconds, stop. Expected: transcript + summary appear; a new `usage_events` row exists for that email (`select kind, created_at from usage_events order by created_at desc limit 2;`), proving the downloaded build uses the proxy.

- [ ] **Step 6: Note the result**

If all pass, the funnel is live. Record any follow-ups (e.g. map `neatorewind.com`, Phase 2 signing to remove the SmartScreen warning).

---

## Self-Review Notes

- **Spec coverage:** C1 site → Tasks 4–5; C2 signup → Task 6; C3 notify → Task 7; C4 schema → Task 1; C5 download hosting → Task 3; C6 cloud-mode build → Task 3; C7 Resend email → Task 2; deploy → Task 8; E2E → Task 9; global cap → Tasks 1+6; guardrails → Task 6 (cap) + Task 2 (Resend limits) + existing per-user cap.
- **Cost backstop:** cap enforced in `processSignup` before `addInvite` (Task 6, Step 7), sourced from `site_limits` (Task 1).
- **Service-role safety:** key only read in `supabaseAdmin.ts` (server) via non-`NEXT_PUBLIC_` env; routes set `runtime = 'nodejs'`.
- **Type consistency:** `SignupDeps`/`SignupResult`/`NotifyDeps` defined in Task 6/7 and consumed by the same-task routes and `supabaseAdmin.ts`; `downloadUrl` threaded from env → deps → result.
```
