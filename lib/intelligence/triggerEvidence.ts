/** Public source text selected by span, never generated quotation text. */
export type TriggerSourceEvidence = {
  observationId: string;
  excerpt: string;
  start: number;
  end: number;
  observedAt: string;
};

export function readTriggerSourceEvidence(metadata: unknown): TriggerSourceEvidence | null {
  if (!metadata || typeof metadata !== "object") return null;
  const item = (metadata as Record<string, unknown>).intelligenceEvidence;
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  if (typeof row.observationId !== "string" || !/^[a-f0-9-]{36}$/i.test(row.observationId)
    || typeof row.excerpt !== "string" || !row.excerpt.trim() || row.excerpt.length > 1200
    || !Number.isInteger(row.start) || !Number.isInteger(row.end)
    || Number(row.start) < 0 || Number(row.end) - Number(row.start) !== row.excerpt.length
    || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) return null;
  return row as TriggerSourceEvidence;
}
