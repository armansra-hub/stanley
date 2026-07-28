/**
 * Normalization for a pushed grade row, with PER-ROW, PER-FIELD errors.
 *
 * The contract deliberately mirrors the shape Codex already built on 2026-07-15
 * (internalId / tamScore / recordDigest / recordDead / revisitOn …) so it doesn't
 * have to relearn anything — but every field now accepts aliases and loose
 * formats, and a bad row is reported and skipped instead of failing its 249
 * healthy neighbours.
 */
// Relative, not "@/…": these are siblings, and vitest has no path-alias config.
import { coerceBool, coerceDate, coerceList, coerceScore, coerceText, pick } from "./coerce";

export interface NormalizedScoreRow {
  internalId: string;
  tamScore: number;
  oldGoldClass: string | null;
  oldGoldReasons: string[];
  recordDigest: string | null;
  /** null = the push didn't mention it. Absent must NOT be read as false, or a
   * partial re-push would resurrect every dead lead it touched. */
  recordDead: boolean | null;
  recordDeadReason: string | null;
  revisitOn: string | null;
  qualNote: string | null;
  lastSqlDate: string | null;
}

export interface RowError {
  index: number;
  internalId: string | null;
  field: string;
  problem: string;
  received: string;
}

const show = (v: unknown): string => {
  if (v === undefined) return "(absent)";
  if (v === null) return "(null)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/**
 * One raw row → a normalized row, or the list of reasons it can't be used.
 * Only two fields are truly required: the NetSuite internal ID (how we find the
 * company) and the score (the point of the push). Everything else degrades to null.
 */
export function normalizeScoreRow(
  raw: Record<string, unknown>,
  index: number,
): { ok: true; row: NormalizedScoreRow } | { ok: false; errors: RowError[] } {
  const errors: RowError[] = [];

  const rawId = pick(raw, "internalId", "internal id", "netsuiteInternalId", "nsid", "id", "netsuite id");
  const internalId = coerceText(rawId)?.replace(/\.0$/, "") ?? null; // spreadsheets love turning ids into floats
  if (!internalId || !/^\d+$/.test(internalId)) {
    errors.push({ index, internalId, field: "internalId", problem: "missing or not a numeric NetSuite internal ID", received: show(rawId) });
  }

  const rawScore = pick(raw, "tamScore", "score", "tam score", "grade", "closeProbability", "close probability");
  const tamScore = coerceScore(rawScore);
  if (tamScore === undefined) {
    errors.push({ index, internalId, field: "tamScore", problem: "not a number between 0 and 100", received: show(rawScore) });
  } else if (tamScore === null) {
    errors.push({ index, internalId, field: "tamScore", problem: "required — a row with no score has nothing to import", received: show(rawScore) });
  }

  const rawRevisit = pick(raw, "revisitOn", "revisit on", "revisit", "revisitDate", "followUpOn");
  const revisitOn = coerceDate(rawRevisit);
  if (revisitOn === undefined) {
    errors.push({ index, internalId, field: "revisitOn", problem: "unreadable date (accepts YYYY-MM-DD, M/D/YYYY, ISO, Excel serial, or blank)", received: show(rawRevisit) });
  }

  const rawLastSql = pick(raw, "lastSqlDate", "last sql date", "lastSql", "last sql");
  const lastSqlDate = coerceDate(rawLastSql);
  if (lastSqlDate === undefined) {
    errors.push({ index, internalId, field: "lastSqlDate", problem: "unreadable date (accepts YYYY-MM-DD, M/D/YYYY, ISO, Excel serial, or blank)", received: show(rawLastSql) });
  }

  const rawDead = pick(raw, "recordDead", "record dead", "dead", "isDead", "disqualified");
  const recordDead = coerceBool(rawDead);
  if (recordDead === undefined) {
    errors.push({ index, internalId, field: "recordDead", problem: "unreadable boolean (accepts true/false, yes/no, 1/0, or blank)", received: show(rawDead) });
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    row: {
      internalId: internalId as string,
      tamScore: tamScore as number,
      oldGoldClass: coerceText(pick(raw, "oldGoldClass", "old gold class", "ogClass")),
      oldGoldReasons: coerceList(pick(raw, "oldGoldReasons", "old gold reasons", "ogReasons", "reasons")),
      recordDigest: coerceText(pick(raw, "recordDigest", "record digest", "digest", "rationale", "summary")),
      recordDead: recordDead ?? null, // undefined already returned above as a field error
      recordDeadReason: coerceText(pick(raw, "recordDeadReason", "record dead reason", "deadReason", "disqualifyReason")),
      revisitOn: revisitOn ?? null,
      qualNote: coerceText(pick(raw, "qualNote", "qual note", "qualificationNote")),
      lastSqlDate: lastSqlDate ?? null,
    },
  };
}

export interface NormalizeResult {
  rows: NormalizedScoreRow[];
  errors: RowError[];
  duplicates: string[];
}

/**
 * Normalize a whole batch. Later rows win on duplicate internal IDs (a re-grade
 * within one payload is a correction, not a conflict) but the collision is reported
 * so nobody discovers it by noticing a wrong score weeks later.
 */
export function normalizeScoreBatch(rawRows: Record<string, unknown>[]): NormalizeResult {
  const byId = new Map<string, NormalizedScoreRow>();
  const errors: RowError[] = [];
  const duplicates: string[] = [];

  rawRows.forEach((raw, i) => {
    const result = normalizeScoreRow(raw, i);
    if (!result.ok) { errors.push(...result.errors); return; }
    if (byId.has(result.row.internalId)) duplicates.push(result.row.internalId);
    byId.set(result.row.internalId, result.row);
  });

  return { rows: [...byId.values()], errors, duplicates: [...new Set(duplicates)] };
}

/**
 * Old Gold is DERIVED, never copied. A row's oldgold_score equals its tam_score
 * only when the row is genuinely Old Gold — it has both a qual note and a prior
 * SQL date. For everyone else it must be null, not a copied number.
 *
 * This is evaluated per company row, because duplicate NetSuite internal IDs exist
 * and one twin can be Old Gold while the other isn't.
 *
 * (Hard zeros and the ±15 signal layer live in lib/agent/adjust.ts, so the scoring
 * law has exactly one implementation on the write path.)
 */
export function deriveOldGold(
  tamScore: number,
  company: { qual_note?: unknown; last_sql_date?: unknown },
  fallbackLastSql?: string | null,
): number | null {
  const isOldGold = Boolean(company.qual_note) && Boolean(company.last_sql_date ?? fallbackLastSql);
  return isOldGold ? tamScore : null;
}
