-- 0034: codex close-probability scoring becomes the TAM score (2026-07-14).
-- Current invariant (normalized 2026-08-10): codex_score preserves the raw grade;
-- tam_score equals it except for record-derived hard zeros. Public signals rank
-- Triggered separately and never change either grade. score_adjust_note preserves
-- write provenance and any hard-zero reason.
alter table companies add column if not exists codex_score numeric;
alter table companies add column if not exists score_adjust_note text;
