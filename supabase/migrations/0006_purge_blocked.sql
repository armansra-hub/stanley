-- 0006: one-time purge (2026-06-25 decision). Remove DISCOVERED prospects that
-- now fall in the blocked industries (accounting/CPA/tax, call centers, law),
-- plus every unidentified ("Name Unavailable") lead. Scoped to source='discovered'
-- so the AE's own IMPORTED lists are never touched. Going forward these are
-- blocked at ingest (config/territory.ts, config/coverage.ts, config/news.ts,
-- lib/ingest/orchestrator.ts). NOTE: Freight & Logistics is NOT purged — it stays
-- in territory; only true 3PLs are filtered (going forward) via the is_3pl gate.
-- Existing 3PL rows aren't reliably identifiable by subindustry, so they aren't
-- bulk-purged here; dismiss any you spot.
--
-- Safe to re-run. Signals cascade via their company_id FK; if your FK isn't ON
-- DELETE CASCADE, the explicit signals delete below covers it.

-- 1. Delete signals for the rows we're about to remove (covers non-cascading FKs).
delete from signals s
using companies c
where s.company_id = c.id
  and c.source = 'discovered'
  and (
    c.subindustry in (
      'Accounting Services',
      'Call Centers & Business Centers',
      'Law Firms & Legal Services'
    )
    or lower(trim(c.name)) = 'name unavailable'
  );

-- 2. Delete the companies themselves.
delete from companies c
where c.source = 'discovered'
  and (
    c.subindustry in (
      'Accounting Services',
      'Call Centers & Business Centers',
      'Law Firms & Legal Services'
    )
    or lower(trim(c.name)) = 'name unavailable'
  );

-- Note: the Net-New lead pool (Google Maps) is un-enriched, so it has no
-- subindustry to filter on. Blocked categories were removed from the Maps search
-- rotation (config/coverage.ts), so no new accounting/law/freight/3PL leads will
-- be pooled. Existing pooled rows age out naturally as you work/clear the pool.
