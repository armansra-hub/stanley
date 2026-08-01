-- 0040: two-phase LinkedIn reading order (2026-07-31, Arman's efficiency rule).
--
-- "First go through all the companies. If you find a trigger event on the company
-- page, don't bother with decision-makers. If you only find a fit, or nothing, THEN
-- also check the decision-maker pages. Do phase 1 for everyone before starting
-- phase 2 — don't be redundant."
--
-- linkedin_phase state machine on companies:
--   0 (default) — not started
--   1           — company page read, no trigger found (fit-only or nothing);
--                 queued for phase 2 (decision-maker pages)
--   2           — fully done — either a trigger landed on the company page (phase 2
--                 skipped), or phase 2 ran and finished regardless of outcome

alter table companies add column if not exists linkedin_phase smallint not null default 0;
create index if not exists companies_linkedin_phase_idx on companies (linkedin_phase, tam_score desc nulls last)
  where linkedin_url is not null;
