-- 0035: the AGENT BRIDGE — the "backroom" where Stanley's two agents meet (2026-07-27).
--
-- Arman runs two agents against Stanley: Claude Code (repo, migrations, grading
-- pipeline, monitoring) and OpenAI Codex (cloud agent on a second laptop, driving
-- NetSuite through Chrome). They had no shared channel: Codex built a score-import
-- endpoint on 2026-07-15, pushed 6,932 regrades through it, then DELETED it — so
-- everything it has graded since has had nowhere to land.
--
-- Three tables, one job each:
--   agent_messages  — talk to each other (and to Arman) with durable, readable notes
--   agent_tasks     — a live status board: what each agent is doing RIGHT NOW, how far along
--   lead_documents  — the record TEXT behind a lead (NetSuite record body, PDF text),
--                     pushed up by whichever agent can see it, readable by both
-- Plus score_snapshots so a bulk grade write has evidence for reviewed recovery.
-- Migration 0046 extends this historical core snapshot to every mutated field.
--
-- NOTE ON PDFs: push TEXT, not binaries. This project is on Supabase's free tier
-- (500MB database, and no storage buckets provisioned); the local PDF corpus alone
-- is ~15GB. Extracted text for the whole ~7,400-lead TAM is ~100MB and fits fine.

create table if not exists agent_messages (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  from_agent  text not null check (from_agent in ('codex', 'claude', 'arman', 'system')),
  to_agent    text not null check (to_agent   in ('codex', 'claude', 'arman', 'all')),
  -- contract = "here is an interface you can rely on"; handoff = "your turn";
  -- status/question/answer/error/note are self-explanatory.
  kind        text not null default 'note'
              check (kind in ('note', 'status', 'question', 'answer', 'handoff', 'error', 'contract')),
  subject     text not null,
  body        text,
  ref         jsonb not null default '{}'::jsonb,   -- ids, counts, file paths, anything structured
  thread_id   uuid,                                  -- replies carry the parent's id
  read_at     timestamptz
);
create index if not exists agent_messages_inbox_idx on agent_messages (to_agent, read_at, created_at desc);
create index if not exists agent_messages_thread_idx on agent_messages (thread_id);

-- Live status board. One row per unit of work an agent is doing. Agents heartbeat
-- while running so a stalled job is visible as a stale heartbeat rather than silence.
create table if not exists agent_tasks (
  id            uuid primary key default gen_random_uuid(),
  agent         text not null check (agent in ('codex', 'claude')),
  title         text not null,
  state         text not null default 'running'
                check (state in ('queued', 'running', 'blocked', 'done', 'failed')),
  done          integer not null default 0,
  total         integer,
  note          text,                                -- current step, or why it's blocked
  detail        jsonb not null default '{}'::jsonb,
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists agent_tasks_live_idx on agent_tasks (state, heartbeat_at desc);

-- The record text behind a lead. Keyed by NetSuite internal ID because that is the
-- one identifier both agents share; company_id is resolved on write when it matches.
-- The (nsid, doc_type, sha256) unique key makes re-pushing the same document a no-op,
-- so an interrupted upload can simply be re-run from the start.
create table if not exists lead_documents (
  id                   uuid primary key default gen_random_uuid(),
  netsuite_internal_id text not null,
  company_id           uuid references companies(id) on delete set null,
  doc_type             text not null default 'record_text'
                       check (doc_type in ('record_text', 'pdf_text', 'note', 'activity', 'other')),
  source               text,                         -- e.g. 'netsuite_ui', 'pdf:<filename>'
  title                text,
  body                 text not null,
  sha256               text not null,
  captured_at          timestamptz,
  created_at           timestamptz not null default now(),
  constraint lead_documents_dedupe unique (netsuite_internal_id, doc_type, sha256)
);
create index if not exists lead_documents_nsid_idx on lead_documents (netsuite_internal_id);
create index if not exists lead_documents_company_idx on lead_documents (company_id);

-- Undo buffer for bulk score writes. Every /api/agent/scores import snapshots the
-- prior values of the rows it is about to touch, tagged with the import's label.
create table if not exists score_snapshots (
  id                   bigserial primary key,
  taken_at             timestamptz not null default now(),
  label                text not null,
  company_id           uuid not null,
  netsuite_internal_id text,
  tam_score            numeric,
  codex_score          numeric,
  oldgold_score        numeric,
  score_adjust_note    text
);
create index if not exists score_snapshots_label_idx on score_snapshots (label, taken_at desc);
