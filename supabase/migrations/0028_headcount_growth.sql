-- 0028: DOL Form 5500 headcount-growth enrichment. We match claimable leads to their
-- 5500 retirement-plan filing by name and compute within-year active-participant growth
-- (EOY vs BOY). The % is ATTACHED to the lead (never filters anyone out); leads at
-- ≥25% growth surface in the Triggered worklist. Slow/annual signal (5500 is filed once
-- a year), refreshed by re-running the ingest script.
alter table companies add column if not exists headcount_growth_pct numeric;
