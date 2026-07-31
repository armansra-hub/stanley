-- 0038: the LinkedIn reading path (2026-07-30).
--
-- Arman: walk every TAM lead's LinkedIn company page, read the posts, and surface two
-- different things — (a) trigger EVENTS (hiring, expansion, new product) and (b) how
-- the business actually OPERATES, because an operating model that looks like a typical
-- NetSuite customer is itself worth flagging. His example: a company posting about
-- doing project-based accounting, which is a NetSuite strength.
--
-- Division of labour: LinkedIn blocks unauthenticated fetching, and Codex already
-- drives it in an authenticated browser. So Codex FETCHES post text and pushes it via
-- /api/agent/documents (hash-verified, idempotent, already built); Claude Code reads
-- that text locally and writes the findings here. No API key, no scraper, no ToS risk.
--
-- URLs did not need resolving: 5,362 of 6,949 leads (77%) already carry a LinkedIn
-- company page inside the NetSuite record text Codex uploaded, stamped by NetSuite's
-- own "LinkedIn URL" field.

alter table companies add column if not exists linkedin_url text;

-- LinkedIn posts arrive through the existing documents ingest, so they inherit its
-- sha256 verification and (nsid, doc_type, sha256) idempotency.
alter table lead_documents drop constraint if exists lead_documents_doc_type_check;
alter table lead_documents add constraint lead_documents_doc_type_check
  check (doc_type in ('record_text', 'pdf_text', 'note', 'activity', 'linkedin_post', 'website_copy', 'other'));

-- What the reading FOUND. Deliberately separate from `triggers`: a trigger is a dated
-- event that ranks the Triggered tab, whereas a fit finding is a standing characteristic
-- that must NOT reorder an events-first list (Arman's call — "tag only, no ranking
-- change"). Both render as a badge wherever the lead appears.
create table if not exists lead_insights (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  netsuite_internal_id text,
  source               text not null default 'linkedin'   -- linkedin | website
                       check (source in ('linkedin', 'website', 'record')),
  kind                 text not null                      -- what class of finding
                       check (kind in ('trigger', 'netsuite_fit', 'ops_profile')),
  label                text not null,                     -- the badge text: "job posting", "project-based accounting"
  detail               text,                              -- the reasoning, in a sentence
  evidence             text,                              -- VERBATIM quote — every finding must be checkable
  evidence_url         text,
  confidence           text default 'medium' check (confidence in ('high', 'medium', 'low')),
  posted_at            date,                              -- when the post ran, for freshness
  created_at           timestamptz not null default now(),
  -- One finding of a given label per lead per source; re-reading is idempotent.
  constraint lead_insights_dedupe unique (company_id, source, kind, label)
);
create index if not exists lead_insights_company_idx on lead_insights (company_id);
create index if not exists lead_insights_kind_idx on lead_insights (kind, created_at desc);

-- Reading progress, so a multi-day march is resumable and its coverage is measurable.
alter table companies add column if not exists linkedin_checked_at timestamptz;
create index if not exists companies_linkedin_cursor_idx on companies (linkedin_checked_at nulls first);
