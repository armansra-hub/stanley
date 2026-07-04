-- TAM score vs Old Gold score split (2026-07-03, per Arman).
-- tam_score: the holistic 0-100 grade of EVERY lead record (activities + notes +
--   qual note if present) — this is what the TAM Base tab ranks on.
-- oldgold_score (existing): now reserved for TRUE Old Gold leads only — records
--   that have BOTH a qual note AND an SQL date (a past sales-qualified moment
--   worth reviving). Displayed alongside tam_score when present.
-- tam_provisional: true while the score is the free formula floor (capped at 39,
--   below every hand-graded "plausible" lead) — cleared when the deep read lands.
alter table companies add column if not exists tam_score numeric;
alter table companies add column if not exists tam_provisional boolean not null default false;
create index if not exists companies_tam_score_idx on companies (tam_score desc nulls last) where is_base = true;
notify pgrst, 'reload schema';
