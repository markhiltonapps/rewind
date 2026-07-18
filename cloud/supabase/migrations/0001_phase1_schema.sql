-- Phase 1 — cloud AI proxy schema.
-- See docs/superpowers/specs/2026-07-18-cloud-ai-proxy-phase1-design.md
--
-- Clients never touch these tables directly: the proxy uses the Supabase
-- service-role key (which bypasses RLS). RLS is enabled with NO policies so
-- the anon/authenticated keys can't read or write them.

-- invites: only these emails may use the proxy (invite-only gate).
create table if not exists public.invites (
  email      text primary key,
  created_at timestamptz not null default now(),
  note       text
);

-- usage_events: append-only metering ledger. raw_units keeps the natural unit
-- for auditing (audio-seconds for transcribe, tokens for summarize/embed);
-- est_cost_usd is the normalized cost that the monthly cap is measured in.
create table if not exists public.usage_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  email        text not null,
  kind         text not null check (kind in ('transcribe','summarize','embed')),
  raw_units    double precision not null,
  est_cost_usd double precision not null,
  created_at   timestamptz not null default now()
);
create index if not exists usage_events_user_month_idx
  on public.usage_events (user_id, created_at);

-- account_limits: optional per-user override of the global default cap.
-- When absent, the proxy applies its global default (5.00 USD/month).
create table if not exists public.account_limits (
  user_id              uuid primary key,
  monthly_cost_cap_usd double precision not null
);

alter table public.invites        enable row level security;
alter table public.usage_events   enable row level security;
alter table public.account_limits enable row level security;
