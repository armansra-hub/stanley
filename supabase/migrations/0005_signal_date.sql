-- 0005: capture the ACTUAL date a signal happened (post/news/job date), distinct
-- from detected_at (when we ingested it). Drives the 2026-onward recency filter
-- and recency-weighted scoring (lib/time.ts, lib/ingest/orchestrator.ts), and is
-- the temporal backbone the Missions calendar will build on later.

alter table signals add column if not exists signal_date timestamptz;

-- Helps "newest signal first" sorting and recency queries.
create index if not exists signals_signal_date_idx on signals (signal_date desc nulls last);
