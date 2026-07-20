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
