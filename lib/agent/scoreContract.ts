/**
 * Canonical scoring language shared by both bridge discovery endpoints.
 *
 * Keep this separate from either route so a wording-only edit cannot leave the
 * two public contracts disagreeing about what the write path actually stores.
 */
export const SCORE_STORAGE_RULES = [
  "codex_score stores the raw pushed 0-100 TAM close probability",
  "tam_score equals codex_score except that record_dead rows and confirmed NetSuite incumbents are forced to 0",
  "public, scraped, and outside signals never change codex_score, tam_score, or oldgold_score; they rank the separate Triggered worklist",
  "oldgold_score is stored per company row: it is null when the row does not meet the Old Gold membership gate; a qualifying row stores the independently pushed revival score, falling back to its TAM grade only when no revival score was supplied",
  "retired rows tagged tam_duplicate are immutable history; an exact ID with more than one non-retired company row is ambiguous and receives no write",
  "a record-dead row requires a specific reason; making a row live clears its stale record_dead_reason",
] as const;

export const ASSESSMENT_ARTIFACT_RULES = [
  "Every current TAM assessment artifact includes old_gold_score, old_gold_class, intro_call_exists, and opportunity_exists, including assessments that are not Old Gold members",
  "An audited old_gold_score of 0 remains 0 in the assessment artifact; live companies.oldgold_score is intentionally null when that company row fails the Old Gold membership gate",
] as const;

export const SCORE_KNOWN_HISTORY = [
  "2026-07-15: a full-record regrade landed for 6,912 of 7,402 then-current TAM leads (93.4%) via a since-deleted endpoint. Those raw grades remain in companies.codex_score, with the guarded display value in tam_score.",
  "2026-08-10: the retired outside-signal score layer was removed and existing current grades were normalized. The exact cohort and independent production readback are preserved in config/tam-score-normalization-receipt.json. Public signals now rank only Triggered; they must never be folded into a TAM or Old Gold score.",
  "490 leads in that 2026-07-15 membership snapshot never received that pass; current membership and completion must be read from the current TAM coordination state before assigning work.",
  "The failed legacy import rejected whole batches when revisitOn was omitted. The bridge accepts loose dates and reports errors per row.",
] as const;
