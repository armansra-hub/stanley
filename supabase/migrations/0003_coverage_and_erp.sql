-- Run in the Supabase SQL editor.
-- (1) discovery_coverage: tracks which slice of the TAM each source has already
-- scraped, so each run advances to a NEW slice instead of re-paying for the same
-- companies. (2) already_on_netsuite: flag companies the evidence shows are
-- already on NetSuite/a modern ERP (existing users, not QuickBooks-pain leads).

create table if not exists discovery_coverage (
  source        text not null,
  slice_key     text not null,
  last_run_at   timestamptz,
  run_count     int not null default 0,
  results_count int not null default 0,
  primary key (source, slice_key)
);

alter table companies add column if not exists already_on_netsuite boolean not null default false;
