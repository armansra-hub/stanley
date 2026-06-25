-- Run in the Supabase SQL editor (new query).
-- (1) starred: a company you've starred stays in the Starred tab regardless of
--     status/export, until you unstar or delete it.
-- (2) lead_pool: cheap Google-Maps finds park here (no signal yet). A qualifier
--     checks each pooled domain for hiring/ERP signals; only ones with a real
--     signal get promoted into `companies`. No hand-entering no-signal leads.

alter table companies add column if not exists starred boolean not null default false;

create table if not exists lead_pool (
  key             text primary key,           -- normalized domain, or "name:<lowername>"
  name            text not null,
  domain          text,
  state           text,
  city            text,
  source          text not null default 'google_maps',
  first_seen_at   timestamptz not null default now(),
  last_checked_at timestamptz,
  check_count     int not null default 0,
  promoted_at     timestamptz
);

create index if not exists lead_pool_check_idx on lead_pool (promoted_at, last_checked_at);
