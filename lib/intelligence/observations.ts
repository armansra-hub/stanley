import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";

export const INTELLIGENCE_VERSION = "evidence-v2";
export const intelligenceEnabled = () => process.env.STANLEY_INTELLIGENCE_ENABLED === "true";

export type EvidenceSection = { id: string; start: number; end: number; text: string };
export type ObservationInput = {
  companyId: string; companyName: string; companyDomain?: string | null; netsuiteInternalId?: string | null;
  sourceKind: "news" | "website" | "job" | "government";
  sourceUrl: string; title: string; text: string; eventDate?: string | null; observedAt?: string;
  metadata?: Record<string, unknown>;
};

export function canonicalEvidenceUrl(raw: string): string {
  const url = validatePublicHttpUrl(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

/** Exact offsets into retained normalized text; no invented quotes or dates. */
export function evidenceSections(text: string, maxLength = 3000): EvidenceSection[] {
  const out: EvidenceSection[] = [];
  for (let start = 0; start < text.length && out.length < 16;) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + maxLength / 2) end = boundary + 1;
    }
    out.push({ id: `s${out.length + 1}`, start, end, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

export function prepareObservation(input: ObservationInput) {
  if (!/^[a-f0-9-]{36}$/i.test(input.companyId) || !input.companyName.trim()) throw new Error("Invalid observation account");
  const url = canonicalEvidenceUrl(input.sourceUrl);
  const normalized = input.text.replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) throw new Error("Empty evidence");
  // Public source capture is explicitly bounded. Private full-record indexing
  // uses a separate local path and must never use this clipping behavior.
  const text = normalized.slice(0, 48_000);
  const observed = new Date(input.observedAt ?? Date.now());
  if (!Number.isFinite(observed.getTime())) throw new Error("Invalid observation time");
  const event = input.eventDate ? new Date(input.eventDate) : null;
  if (event && !Number.isFinite(event.getTime())) throw new Error("Invalid event date");
  const context = { companyName: input.companyName.trim(), companyDomain: input.companyDomain ?? null, netsuiteInternalId: input.netsuiteInternalId ?? null };
  return {
    url, text, sections: evidenceSections(text), observedAt: observed.toISOString(), eventDate: event?.toISOString() ?? null,
    // A publisher page found through a feed and through site discovery is one
    // source. Context/date/body changes still produce a new observation version.
    sourceKey: createHash("sha256").update(url).digest("hex"),
    // Context/date changes invalidate semantic reuse even when source text is identical.
    // The public company ID is already the database partition. An optional CRM
    // locator is provenance, not semantic evidence; collectors must not create
    // new versions of identical public pages merely by supplying that locator.
    contentHash: createHash("sha256").update(JSON.stringify([text, input.title, event?.toISOString(),
      { companyName: context.companyName, companyDomain: context.companyDomain }])).digest("hex"),
    metadata: { ...input.metadata, ...context, retainedCharacters: text.length, sourceCharacters: normalized.length, textTruncated: normalized.length > text.length },
  };
}

export async function enqueueObservation(input: ObservationInput): Promise<{ id: string; queued: boolean } | null> {
  if (!intelligenceEnabled()) return null;
  const prepared = prepareObservation(input);
  const { data, error } = await serviceClient().rpc("intelligence_observe", {
    p_company: input.companyId, p_source_key: prepared.sourceKey, p_source_kind: input.sourceKind,
    p_url: prepared.url, p_title: input.title.slice(0, 500), p_text: prepared.text, p_hash: prepared.contentHash,
    p_event_date: prepared.eventDate, p_observed_at: prepared.observedAt, p_metadata: prepared.metadata,
    p_sections: prepared.sections, p_version: INTELLIGENCE_VERSION,
  });
  if (error) throw new Error(`Observation persistence failed: ${error.code ?? "database_error"}`);
  if (data?.disabled) return null;
  if (!data?.id) throw new Error("Observation persistence returned no identity");
  return { id: String(data.id), queued: data.queued === true };
}
