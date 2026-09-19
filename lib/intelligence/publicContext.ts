import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export const PUBLIC_SCALE_CONTEXT_VERSION = "public-scale-v1";
export const MAX_PUBLIC_SCALE_CONTEXT_BYTES = 3200;
export type PublicContextObservation = { id: string; company_id: string; source_kind: string; source_url: string;
  title: string; evidence_text: string; event_date: string | null; observed_at: string; is_current: boolean;
  feedback_excluded?: boolean; attributes: Record<string, unknown> | null };
export type PublicScaleSource = { observationId: string; url: string; eventDate: string | null; observedAt: string;
  passages: { start: number; end: number; text: string }[] };
export type PublicScaleContext = { version: string; text: string; sources: PublicScaleSource[];
  status: "sourced_context" | "unknown"; sourceReadLimit: number; bounded: boolean };

const scope = "Public scale/footprint context, quoted from previously captured public sources. Revenue, employee count, current location/entity totals and acquisition-relative size remain unknown unless an attributable, appropriately dated passage explicitly supplies them. These excerpts are context, not proof of the new event or a recomputed Jev judgment. A collection date does not make an older claim current; customer/supplier footprint is not the account's footprint. No private CRM size fields are included.";
const scaleTerms = /\b(?:employees?|headcount|team of|offices?|locations?|facilit(?:y|ies)|branches|subsidiar(?:y|ies)|business units?|operat(?:es|ing|ions)|annual revenue|revenue of|countries|states|fleet|warehouses?|distribution cent(?:er|re)s?)\b/gi;

function excerptEnd(text: string, start: number, proposed: number, bytes: number) {
  let end = proposed;
  while (end > start && Buffer.byteLength(text.slice(start, end), "utf8") > bytes) end = start + Math.max(0, Math.floor((end - start) * .9));
  if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return end;
}

/** Locates original source spans for the model's first pass. A keyword hit is
 * only a passage selector; it never asserts the mentioned number is company scale. */
export function publicScalePassages(text: string) {
  const passages: { start: number; end: number; text: string }[] = [];
  for (const match of text.matchAll(scaleTerms)) {
    const position = match.index;
    const boundary = Math.max(text.lastIndexOf("\n", position), text.lastIndexOf(". ", position));
    const start = Math.max(0, boundary < 0 ? 0 : boundary + 1, position - 220);
    const lineEnd = text.indexOf("\n", position), sentenceEnd = text.indexOf(". ", position);
    const ends = [lineEnd, sentenceEnd < 0 ? -1 : sentenceEnd + 1].filter(value => value > position);
    const end = excerptEnd(text, start, Math.min(ends.length ? Math.min(...ends) : text.length, position + 420), 750);
    if (end <= position || passages.some(passage => position >= passage.start && position < passage.end)) continue;
    passages.push({ start, end, text: text.slice(start, end) });
    if (passages.length >= 2) break;
  }
  return passages;
}

export function buildPublicScaleContext(companyId: string, observations: readonly PublicContextObservation[], excludeObservationId?: string): PublicScaleContext {
  const eligible = observations.filter(row => row.company_id === companyId && row.id !== excludeObservationId
    && row.is_current && !row.feedback_excluded && ["website", "news"].includes(row.source_kind)
    && row.attributes?.companyRelationship === "direct" && Number(row.attributes.companyRelevance) >= .8)
    .sort((a, b) => Number(b.source_kind === "website") - Number(a.source_kind === "website")
      || Date.parse(b.observed_at) - Date.parse(a.observed_at));
  const sources: PublicScaleSource[] = [];
  const text = () => `${scope}\n${JSON.stringify({ version: PUBLIC_SCALE_CONTEXT_VERSION, sources })}`;
  let bounded = observations.length >= 40;
  const seen = new Set<string>();
  for (const row of eligible) {
    if (seen.has(row.source_url)) continue;
    try { const url = new URL(row.source_url); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue; }
    catch { continue; }
    const passages = publicScalePassages(row.evidence_text);
    if (!passages.length) continue;
    const source = { observationId: row.id, url: row.source_url, eventDate: row.event_date, observedAt: row.observed_at, passages };
    sources.push(source);
    if (Buffer.byteLength(text(), "utf8") > MAX_PUBLIC_SCALE_CONTEXT_BYTES && passages.length > 1) passages.pop();
    if (Buffer.byteLength(text(), "utf8") > MAX_PUBLIC_SCALE_CONTEXT_BYTES) { sources.pop(); bounded = true; continue; }
    seen.add(row.source_url);
    if (sources.length >= 3) { bounded = bounded || eligible.length > sources.length; break; }
  }
  return { version: PUBLIC_SCALE_CONTEXT_VERSION, text: text(), sources,
    status: sources.length ? "sourced_context" : "unknown", sourceReadLimit: 40, bounded };
}

/** Read only captured public observations. Private CRM and company size fields
 * are intentionally absent. Optional context failure must not block main evidence. */
export async function loadPublicScaleObservations(companyId: string): Promise<PublicContextObservation[]> {
  const { data, error } = await serviceClient().from("intelligence_observations")
    .select("id,company_id,source_kind,source_url,title,evidence_text,event_date,observed_at,is_current,feedback_excluded,attributes")
    .eq("company_id", companyId).eq("is_current", true).eq("feedback_excluded", false)
    .in("source_kind", ["website", "news"]).not("attributes", "is", null)
    .order("observed_at", { ascending: false }).limit(40);
  if (error) throw new Error("Public scale context unavailable");
  return (data ?? []) as PublicContextObservation[];
}
