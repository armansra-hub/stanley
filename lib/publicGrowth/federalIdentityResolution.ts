import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isCompanyIdentitySource } from "@/lib/companyIdentity";
import { visibleIdentityClaims, type SiteIdentityClaim } from "@/lib/sources/companyIdentityEvidence";
import { companyIdentityNames, decideIdentityMatch, normalizeName } from "./identity";
import { resolveJevIdentityCandidates, type JevIdentityCandidate, type JevIdentitySource } from "./jevIdentity";
import type { GovernmentIdentityCandidate, IdentityDecision, TamIdentity } from "./types";

export class FederalIdentityDeferredError extends Error {
  constructor(readonly reason: string) { super(`federal_identity_deferred:${reason}`); }
}
export type FederalIdentityObservation = { id: string; source_url: string; evidence_text: string; metadata?: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const NAME_BOUNDARY = /[^a-z0-9]+/g;
const containsName = (quote: string, name: string) => (` ${quote.toLowerCase().replace(/&/g, " and ").replace(NAME_BOUNDARY, " ").trim()} `)
  .includes(` ${normalizeName(name)} `);
const identityCue = /\b(?:UEI|CAGE|DUNS|Unique Entity (?:ID|Identifier))\b|\b\d+[A-Za-z]?(?:[-/]\d+)?\s+(?:[A-Za-z0-9.'-]+\s+){0,7}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Court|Ct\.?|Way|Parkway|Pkwy\.?|Highway|Hwy\.?)\b/ig;

/** Supplement explicit name-relationship declarations with real named contact
 * evidence. These self-name sources cannot invent a different legal alias:
 * only an exact known account name is attached to the passage. */
export function federalIdentitySourcesFromObservation(company: TamIdentity, observation: FederalIdentityObservation): JevIdentitySource[] {
  if (!isCompanyIdentitySource(observation.source_url, company.domain || company.website_raw)) return [];
  const sources: JevIdentitySource[] = [], knownNames = companyIdentityNames(company), normalized = knownNames.map(normalizeName);
  const content = observation.evidence_text ?? "";
  const declared = Array.isArray(observation.metadata?.identityClaims) ? observation.metadata.identityClaims as SiteIdentityClaim[] : [];
  for (const claim of [...declared, ...visibleIdentityClaims(content, knownNames)]) {
    if (!claim || typeof claim.subjectName !== "string" || !normalized.includes(normalizeName(claim.subjectName))
      || typeof claim.candidateName !== "string" || typeof claim.sourceQuote !== "string"
      || !claim.sourceQuote || claim.sourceQuote.length > 1800
      || claim.sourceFormat !== "json_ld" && !content.includes(claim.sourceQuote)) continue;
    sources.push({ id: observation.id, url: observation.source_url, subjectName: claim.subjectName,
      candidateName: claim.candidateName, quote: claim.sourceQuote, relationshipHint: claim.relationshipHint });
  }
  // These are the exact structured facts already captured from this page, not
  // an invented quotation or model summary. Irrelevant metadata is not sent.
  const identity = object(observation.metadata?.companyIdentity);
  if (Array.isArray(identity.names) && Array.isArray(identity.addresses)) {
    const names = identity.names.filter((name): name is string => typeof name === "string" && normalized.includes(normalizeName(name)));
    const addresses = identity.addresses.map(value => Object.fromEntries(["addressLine1", "addressLine2", "city", "state", "postalCode", "countryCode"]
      .filter(key => typeof object(value)[key] === "string").map(key => [key, object(value)[key]])))
      .filter(value => typeof value.addressLine1 === "string" && value.addressLine1.trim());
    if (addresses.length) for (const name of names) for (const address of addresses) {
      sources.push({ id: observation.id, url: observation.source_url, subjectName: name, candidateName: name,
        quote: JSON.stringify({ observedCompanyIdentity: { names: [...new Set(identity.names.filter(value => typeof value === "string"))].sort(), address } }),
        format: "company_identity" });
    }
  }
  let identityPage = false;
  try { identityPage = /(?:^|\/)(?:about|contact|location|office|branch|legal|impressum|company|who-we-are|capabilit)[^/]*(?:\/|$)/i.test(new URL(observation.source_url).pathname); }
  catch { /* Invalid source URLs do not produce new contact evidence. */ }
  if (identityPage) {
    // Keep every distinct identity-bearing window and its actual nearby text.
    // The resolver splits/defer oversized packets instead of silently clipping.
    for (const match of content.matchAll(identityCue)) {
      const index = match.index ?? 0, start = Math.max(0, index - 850), end = Math.min(content.length, index + 950);
      const quote = content.slice(start, end);
      for (const name of knownNames.filter(name => containsName(quote, name))) sources.push({ id: observation.id, url: observation.source_url,
        subjectName: name, candidateName: name, quote });
    }
  }
  return [...new Map(sources.map(source => [JSON.stringify([source.url, normalizeName(source.subjectName), normalizeName(source.candidateName), source.quote]), source])).values()];
}

/** Read already collected public evidence; never fetch CRM pages or regrade TAM.
 * All pages are considered in bounded database pages, rather than silently
 * excluding a useful older legal/contact page behind a recent-news limit. */
export async function loadFederalIdentitySources(company: TamIdentity, deadlineMs?: number): Promise<JevIdentitySource[]> {
  const sources: JevIdentitySource[] = [];
  for (let offset = 0; ; offset += 100) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs - 2_000) throw new FederalIdentityDeferredError("source_read_deadline");
    const { data, error } = await serviceClient().from("intelligence_observations")
      .select("id,source_url,evidence_text,metadata").eq("company_id", company.id)
      .eq("is_current", true).eq("feedback_excluded", false).order("id").range(offset, offset + 99);
    if (error) throw new FederalIdentityDeferredError("source_read_unavailable");
    for (const observation of (data ?? []) as FederalIdentityObservation[]) sources.push(...federalIdentitySourcesFromObservation(company, observation));
    if (!data || data.length < 100) return sources;
  }
}

type Candidate = GovernmentIdentityCandidate & { id?: string; recipientId?: string | null; sourceUrl?: string };
type Options = { deadlineMs?: number; sources?: JevIdentitySource[] };
type Dependencies = { loadSources?: typeof loadFederalIdentitySources; resolve?: typeof resolveJevIdentityCandidates };

/** Exact name + independent identity support stays free. Jev handles only the
 * remaining identity question, once per material company/recipient evidence. */
export async function resolveFederalIdentity(company: TamIdentity, candidate: Candidate, options: Options = {}, deps: Dependencies = {}): Promise<IdentityDecision> {
  const deterministic = decideIdentityMatch(company, candidate);
  if (deterministic.status === "verified") return deterministic;
  const sources = options.sources ?? await (deps.loadSources ?? loadFederalIdentitySources)(company, options.deadlineMs);
  const official: JevIdentityCandidate = { ...candidate,
    id: candidate.uei ? `uei:${candidate.uei.toUpperCase()}` : candidate.recipientId ? `recipient:${candidate.recipientId}`
      : candidate.cageCode ? `cage:${candidate.cageCode.toUpperCase()}` : candidate.id ?? `name:${normalizeName(candidate.legalName)}` };
  const result = await (deps.resolve ?? resolveJevIdentityCandidates)({ company, candidates: [official], sources, deadline: options.deadlineMs });
  const resolved = result.decisions.find(row => row.candidateId === official.id);
  if (!resolved) throw new FederalIdentityDeferredError(result.reason ?? "unfinished");
  return { ...resolved.decision, evidence: { ...deterministic.evidence, ...resolved.decision.evidence, jevIdentity: resolved } };
}
