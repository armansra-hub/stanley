-- 0021: separate rotation cursor for the slow structured-signal sweep (USAspending
-- federal awards + SEC EDGAR Form D funding). These change slowly, so they cycle the
-- base on their own cadence instead of sharing the fast news sweep's last_checked_at.
alter table companies add column if not exists signals_checked_at timestamptz;
