export const FORM5500_QUARANTINE_KEY = "stanley_quarantine";
export const FORM5500_HISTORY_MAX_ROWS = 100;

export type Form5500ObservationEvidence = {
  sponsor_state?: unknown;
  evidence?: unknown;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Reader policy, independent of the legacy method/confidence label. Missing
 * city support alone is not a false-identity finding. A reviewed inactive marker
 * permits reconsideration but cannot bypass a current state contradiction. */
export function form5500ObservationExclusion(
  companyState: string | null | undefined,
  row: Form5500ObservationEvidence,
): string | null {
  const evidence = row.evidence;
  if (evidence != null && !object(evidence)) return "malformed_observation_evidence";
  if (object(evidence) && owns(evidence, FORM5500_QUARANTINE_KEY)) {
    const marker = evidence[FORM5500_QUARANTINE_KEY];
    if (!object(marker) || typeof marker.active !== "boolean") return "malformed_quarantine_marker";
    if (marker.active) return "active_quarantine";
  }
  if (row.sponsor_state != null && typeof row.sponsor_state !== "string") return "malformed_sponsor_state";
  const source = ((row.sponsor_state ?? "") as string).trim().toUpperCase();
  const current = (companyState ?? "").trim().toUpperCase();
  return source && current && source !== current ? "current_state_contradiction" : null;
}

/** The ingestion request does not control the reserved local review marker.
 * Existing markers (including reviewed reversals) remain byte-for-byte values.
 * The caller must compare-and-set the original evidence when updating a row. */
export function form5500EvidenceForWrite(existing: unknown, incoming: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = object(incoming) ? { ...incoming } : {};
  delete result[FORM5500_QUARANTINE_KEY];
  if (object(existing) && owns(existing, FORM5500_QUARANTINE_KEY)) {
    result[FORM5500_QUARANTINE_KEY] = existing[FORM5500_QUARANTINE_KEY];
  }
  return result;
}
