import { applyRecordScoreRules } from "./adjust";
import { deriveOldGold, type NormalizedScoreRow } from "./scores";

export interface CompanyScoreContext {
  record_dead?: boolean | null;
  erp_incumbent?: string | null;
  qual_note?: unknown;
  last_sql_date?: unknown;
  record_digest?: unknown;
  record_dead_reason?: unknown;
  lists?: unknown;
}

export interface StoredScoreDecision {
  /** The independent grader output, retained even when a hard zero applies. */
  codexScore: number;
  /** Raw grade unless a record-derived hard zero applies. */
  tamScore: number;
  /** Null means this company row is not an Old Gold member. */
  oldGoldScore: number | null;
  hardZeroReason: string | null;
  recordDead: boolean;
  scoreNote: string;
}

/** Historical duplicate rows are audit evidence, not a second grade target. */
export function isRetiredTamDuplicate(company: CompanyScoreContext): boolean {
  return Array.isArray(company.lists) && company.lists.map(String).includes("tam_duplicate");
}

/** A dead row always has a specific reason; a live row never retains a stale one. */
export function effectiveRecordDeadReason(
  row: NormalizedScoreRow,
  company: CompanyScoreContext,
  recordDead: boolean,
): string | null {
  if (!recordDead) return null;
  const value = row.recordDeadReasonProvided
    ? row.recordDeadReason
    : String(company.record_dead_reason ?? "").trim() || null;
  return value && value.trim() ? value.trim() : null;
}

/**
 * Pure score-write law used by the bridge route.
 *
 * Deliberately accepts no trigger rows. Public intelligence cannot enter this
 * function, which makes the TAM/Triggered boundary structural rather than a
 * comment callers have to remember.
 */
export function deriveStoredScores(
  row: NormalizedScoreRow,
  company: CompanyScoreContext,
): StoredScoreDecision {
  // An omitted recordDead field means preserve the company's current state.
  const recordDead = row.recordDead ?? Boolean(company.record_dead);
  const grade = applyRecordScoreRules(row.tamScore, {
    ...company,
    record_dead: recordDead,
    record_digest: row.recordDigest ?? String(company.record_digest ?? ""),
  });
  const oldGoldCandidate = grade.hardZeroReason
    ? 0
    : (row.oldGoldScore ?? grade.score);

  return {
    codexScore: row.tamScore,
    tamScore: grade.score,
    oldGoldScore: deriveOldGold(
      oldGoldCandidate,
      company,
      row.lastSqlDate,
      [row.recordDigest ?? "", ...row.oldGoldReasons].join(" "),
    ),
    hardZeroReason: grade.hardZeroReason,
    recordDead,
    scoreNote: grade.hardZeroReason
      ? `hard 0 - ${grade.hardZeroReason}`
      : "TAM equals raw grade; public signals are Triggered-only",
  };
}
