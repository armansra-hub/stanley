-- Keep the evidence table's visibility map fresh enough for interactive
-- index-only reads. At the observed 308k rows, default 20% thresholds waited
-- for roughly 62k changes; 2% + 1000 schedules ordinary maintenance around 7k.
-- These are table-local PostgreSQL autovacuum settings, not a new scheduler,
-- worker or source job. Native evidence, caches and model processing are unchanged.
-- Initial VACUUM (ANALYZE) public.intelligence_observations must be run once
-- as a separate maintenance statement outside any transaction. Never VACUUM FULL.
begin;
alter table public.intelligence_observations set (
 autovacuum_vacuum_scale_factor=0.02,
 autovacuum_vacuum_threshold=1000,
 autovacuum_vacuum_insert_scale_factor=0.02,
 autovacuum_vacuum_insert_threshold=1000,
 autovacuum_analyze_scale_factor=0.02,
 autovacuum_analyze_threshold=1000
);
commit;
