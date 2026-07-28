/**
 * Tolerant coercion for anything an agent pushes into the bridge.
 *
 * This exists because of a specific failure: on 2026-07-15 Codex built a
 * score-import endpoint whose date rule was `/^\d{4}-\d{2}-\d{2}$/`. Any batch
 * containing one row with "7/15/2026", an Excel serial, an ISO timestamp, or an
 * empty string was rejected whole, with the message "One or more score records
 * are invalid" — no row index, no field name. Two commits later ("Fix score
 * import date validation", "Diagnose score import validation") it gave up and
 * deleted the endpoint.
 *
 * So: accept every format a spreadsheet, a browser, or a model plausibly emits;
 * normalize to one canonical form; and when something truly can't be read, say
 * WHICH field and WHAT was received. Never throw — callers collect errors per row.
 */

/** Excel/Sheets serial dates count days from 1899-12-30. Below this, a bare number
 * is far more likely a typo than a date, so we refuse to guess. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const EXCEL_MIN = 20000; // ~1954 — anything smaller isn't a date we'd see here
const EXCEL_MAX = 80000; // ~2119

const EMPTY = new Set(["", "-", "--", "n/a", "na", "none", "null", "undefined", "tbd", "unknown"]);

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && EMPTY.has(v.trim().toLowerCase()));

const iso = (d: Date): string | null => (Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10));

/**
 * Any plausible date → "YYYY-MM-DD". Blank/absent → null (a missing date is data,
 * not an error). Unreadable → undefined, which the caller reports as a field error.
 */
export function coerceDate(value: unknown): string | null | undefined {
  if (isBlank(value)) return null;
  if (value instanceof Date) return iso(value) ?? undefined;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= EXCEL_MIN && value <= EXCEL_MAX) return iso(new Date(EXCEL_EPOCH_MS + value * 86_400_000)) ?? undefined;
    if (value > 1e11) return iso(new Date(value)) ?? undefined;          // epoch millis
    if (value > 1e9) return iso(new Date(value * 1000)) ?? undefined;    // epoch seconds
    return undefined;
  }

  if (typeof value !== "string") return undefined;
  const s = value.trim();

  // Already canonical, or an ISO timestamp — take the date part without timezone math,
  // so "2026-07-15T00:00:00Z" can't drift to the 14th for a reader west of UTC.
  const isoish = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (isoish) {
    const [, y, m, d] = isoish;
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    return dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d ? `${y}-${m}-${d}` : undefined;
  }

  // US-style M/D/YYYY or M-D-YY (NetSuite's UI format, and every US spreadsheet).
  const us = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (us) {
    const [, mo, da, yr] = us;
    const year = yr.length === 2 ? 2000 + +yr : +yr;
    const dt = new Date(Date.UTC(year, +mo - 1, +da));
    return dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +da ? iso(dt) ?? undefined : undefined;
  }

  // A bare number that arrived as a string ("45874").
  if (/^\d+$/.test(s)) return coerceDate(Number(s));

  // "Jul 15, 2026" / "15 July 2026" and friends — last resort, and only when the
  // string actually names a month, so "Superior Health" can't parse as a date.
  if (/[a-z]{3}/i.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) return iso(parsed) ?? undefined;
  }
  return undefined;
}

/** Any plausible 0-100 score → number. Blank → null. Unreadable/out-of-range → undefined. */
export function coerceScore(value: unknown): number | null | undefined {
  if (isBlank(value)) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(/[%\s]/g, ""));
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 100) return undefined;
  return Math.round(n * 10) / 10;
}

const TRUE = new Set(["true", "t", "yes", "y", "1", "dead", "x"]);
const FALSE = new Set(["false", "f", "no", "n", "0", "live", "alive"]);

/** Any plausible boolean → boolean. Blank → null. Unreadable → undefined. */
export function coerceBool(value: unknown): boolean | null | undefined {
  if (isBlank(value)) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return undefined;
}

/** A list that may arrive as an array, a JSON array string, or a delimited string. */
export function coerceList(value: unknown): string[] {
  if (isBlank(value)) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch { /* fall through to delimiter split */ }
  }
  return s.split(/\s*(?:\||;|•|\n)\s*/).map((v) => v.trim()).filter(Boolean);
}

/** Trimmed text, or null when blank. */
export function coerceText(value: unknown): string | null {
  if (isBlank(value)) return null;
  return String(value).trim();
}

/**
 * Read a field by any of its accepted names. Agents, spreadsheets and humans all
 * name the same column differently ("Internal ID" / internalId / internal_id / nsid),
 * and rejecting a push over spelling is exactly the failure this module exists to end.
 * Matching ignores case, spaces, underscores and hyphens.
 */
export function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const wanted = names.map(norm);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(norm(key)) && value !== undefined) return value;
  }
  return undefined;
}
