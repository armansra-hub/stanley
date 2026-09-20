import { coerceDate, coerceText } from "./coerce";
/** Integrity-bearing evidence preserves bytes and capture precision. Display
 * fields still use tolerant coercion; full records must hash as captured. */
export function recordEvidenceText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() ? value : null : coerceText(value);
}
export function recordEvidenceCapturedAt(value: unknown): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return coerceDate(value) ?? null;
}
