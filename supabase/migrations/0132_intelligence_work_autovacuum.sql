-- Reclaim dead row versions from checkpoint and rediscovery updates sooner.
-- At the 2026-09-29 observed row counts, 2% + 1000 makes these tables eligible
-- near 8.8k / 9.8k changes rather than the default roughly 78k / 88k.
-- This matches the evidence-table policy in 0115. It does not delete records,
-- rewrite payloads, invalidate native answers, or change jobs/leases/schedules.
--
-- PostgreSQL supports the toast.autovacuum_* storage parameters below:
-- https://www.postgresql.org/docs/16/sql-createtable.html#SQL-CREATETABLE-STORAGE-PARAMETERS
-- Explicit TOAST settings cover checkpoint JSON without altering its contents.
-- Leave cost limits/delays and worker counts inherited, so normal cluster-wide
-- autovacuum cost balancing and the existing small-compute resource limits stay
-- in force. Do not add per-table cost overrides or increase maintenance memory.
-- https://www.postgresql.org/docs/17/routine-vacuuming.html#AUTOVACUUM
--
-- Optional initial maintenance is a separate operational action, only after
-- database health and old transactions have been checked. Run ordinary VACUUM
-- (ANALYZE, TRUNCATE FALSE, PARALLEL 0) on ONE named table at a time, outside a
-- transaction, and recheck health before the next table. Respect ongoing vacuum
-- work; do not cancel healthy workers. Never use VACUUM FULL here. Ordinary
-- vacuum makes dead space reusable; it does not promise a smaller disk file.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '5s';

alter table public.intelligence_jobs set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000,
  toast.autovacuum_vacuum_scale_factor = 0.02,
  toast.autovacuum_vacuum_threshold = 1000,
  toast.autovacuum_vacuum_insert_scale_factor = 0.02,
  toast.autovacuum_vacuum_insert_threshold = 1000
);

alter table public.intelligence_observation_discoveries set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 1000,
  toast.autovacuum_vacuum_scale_factor = 0.02,
  toast.autovacuum_vacuum_threshold = 1000,
  toast.autovacuum_vacuum_insert_scale_factor = 0.02,
  toast.autovacuum_vacuum_insert_threshold = 1000
);

commit;
