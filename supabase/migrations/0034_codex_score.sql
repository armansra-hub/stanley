-- 0034: codex close-probability scoring becomes the TAM score (2026-07-14).
-- tam_score now holds the ADJUSTED close-probability (codex baseline ± Stanley's
-- outside signals, capped ±15, hard 0-guardrails). codex_score preserves the raw
-- codex number for side-by-side reading; score_adjust_note documents any delta.
alter table companies add column if not exists codex_score numeric;
alter table companies add column if not exists score_adjust_note text;
