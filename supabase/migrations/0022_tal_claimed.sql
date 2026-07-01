-- 0022: ARS Target Account List (TAL). The AE uploads his current target/claimed
-- account list (CSV, refreshed weekly like the TAM); any lead in the system whose
-- domain or normalized name matches gets flagged. Surfaced as a red "ARS TAL CLAIMED"
-- badge. Re-upload re-syncs (reset all → set matches), so dropped accounts un-flag.
alter table companies add column if not exists tal_claimed boolean not null default false;
