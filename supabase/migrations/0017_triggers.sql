-- 0017: Trigger engine (Phase 2). The base (14k+) is MONITORED for timing signals —
-- news, funding, M&A, finance hiring, ERP-readiness — which attach as time-DECAYING
-- triggers and rank a company up. Triggers never CREATE a base company (boost-only).
-- A company's `priority` = its strongest still-active (decayed) trigger × fit_weight ×
-- a small multi-list bonus. `last_checked_at` drives the rotation (high-fit first).
create table if not exists triggers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  type           text not null,                 -- news | funding | ma | finance_hire | press | erp_tech
  strength       int  not null default 40,
  half_life_days int  not null default 30,
  summary        text not null,                 -- "Raised $3M (Form D)", "Hiring a Controller", headline…
  source_name    text,
  source_url     text,
  signal_date    timestamptz,                   -- when the event happened (drives decay)
  detected_at    timestamptz not null default now()
);
-- One trigger per (company, article/source) — re-sweeps never duplicate.
create unique index if not exists triggers_dedupe_idx on triggers (company_id, source_url) where source_url is not null;
create index if not exists triggers_company_idx  on triggers (company_id);
create index if not exists triggers_detected_idx on triggers (detected_at desc);

alter table companies add column if not exists last_checked_at timestamptz;          -- last trigger sweep
alter table companies add column if not exists priority        numeric not null default 0; -- cached decayed priority
create index if not exists companies_priority_idx   on companies (priority desc) where is_base = true;
create index if not exists companies_lastchecked_idx on companies (last_checked_at) where is_base = true;
