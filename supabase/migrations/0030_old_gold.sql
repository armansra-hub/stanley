-- Old Gold: qual-note + lead-record intelligence (2026-07-01).
-- CSV-sourced: last BDR SQL date + the qualification note (raw text, hashed so the
-- LLM analysis re-runs only when the note actually changes).
-- Analysis-sourced (in-session LLM pass over note + NetSuite record PDF):
--   oldgold_score 0-100, oldgold_class (timing_arrived | contract_clock | stalled_warm |
--   lost_to_competitor | dead | insufficient), oldgold_reasons (array of explicit,
--   quoted reasons; undated evidence carries a "⚠" marker), record_digest (tight
--   history summary shown in the drawer on every tab), record_dead + reason
--   (database-wide ⛔ — visible everywhere, priority crushed, never hidden),
--   revisit_on (auto-computed "their timing arrives here" date).
alter table companies add column if not exists last_sql_date date;
alter table companies add column if not exists qual_note text;
alter table companies add column if not exists qual_hash text;
alter table companies add column if not exists oldgold_score numeric;
alter table companies add column if not exists oldgold_class text;
alter table companies add column if not exists oldgold_reasons jsonb;
alter table companies add column if not exists record_digest text;
alter table companies add column if not exists record_dead boolean not null default false;
alter table companies add column if not exists record_dead_reason text;
alter table companies add column if not exists revisit_on date;
notify pgrst, 'reload schema';
