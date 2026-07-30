-- 0037: news signals are QUEUED for human/agent verification, not published directly.
--
-- Why (Arman, 2026-07-30): 40% of the TAM (2,751 of 6,949 leads) have exactly one
-- distinctive word in their name — Access, Weekday, Aerofly, Encore, Diagram, Circle,
-- Momentum. Matching a headline to a company by name alone cannot work for those: a
-- one-word name is indistinguishable from its ordinary use. A full sweep produced
-- "Metallica Scholars Initiative" for a lead named Metallica, "Aerofly RC 10:
-- Expansion Pack" for Aerofly, and "Fairfax County expands I-66 trail access" for
-- Access. Regex blocklists are whack-a-mole — 14 words patched, more kept appearing.
--
-- The fix is judgment, not pattern matching. News candidates land here; Claude Code
-- reads each one locally (Arman's Pro plan — never his API key, see the standing rule)
-- and marks keep or reject. Only kept candidates become triggers, so nothing unverified
-- can reach the Triggered tab.
--
-- Website careers/growth signals do NOT queue: those now carry verified page evidence
-- (a real job-page check plus the posting line, an event-gated growth phrase), so they
-- are self-justifying. This queue is for headline-to-company attribution specifically.

create table if not exists trigger_candidates (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  netsuite_internal_id text,
  company_name         text not null,          -- as matched, so a verdict is readable later
  type                 text not null,          -- funding | ma | press | finance_hire | new_entity | …
  summary              text not null,          -- the headline
  source_name          text,
  source_url           text,
  signal_date          timestamptz,
  strength             numeric,
  half_life_days       integer,
  verdict              text check (verdict in ('keep', 'reject')),
  verdict_reason       text,                   -- why — so the call can be audited
  verdict_by           text,                   -- 'claude' | 'codex' | 'arman'
  promoted_trigger_id  uuid,                   -- set once it becomes a real trigger
  created_at           timestamptz not null default now(),
  decided_at           timestamptz,
  -- Re-running a sweep must not pile up duplicates of the same headline.
  constraint trigger_candidates_dedupe unique (company_id, type, summary)
);
create index if not exists trigger_candidates_pending_idx on trigger_candidates (verdict, created_at desc);
create index if not exists trigger_candidates_company_idx on trigger_candidates (company_id);
