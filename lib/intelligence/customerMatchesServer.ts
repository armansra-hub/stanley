import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isPublishableTriggerForCompany, type TriggerEvidence } from "@/lib/triggers/signalIntegrity";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, operatingFacetDecision } from "./operatingCatalog";
import { catalogFacetVersion } from "./operatingCoverage";
import { catalogTopic, type TopicSearchAccountRow } from "./topicSearch";
import { rankCustomerMatches, type CustomerMatchCandidate, type CustomerReference, type CustomerMatchesResult, type CustomerWhyNow } from "./customerMatches";
import { customerReferenceEvidenceKey, customerReferenceCatalogSources, type CustomerReferenceSeed } from "./customerReferenceSources";
import referenceData from "./customerReferenceData.json";

type StoredReference = { id: string; catalog_version: string; evidence_key: string; status: string; result: unknown };
type CandidateTrigger = TriggerEvidence & { id: string; signal_date: string | null };
type CandidateRow = Omit<CustomerMatchCandidate, "whyNow"> & {
  description: string | null; ns_industry: string | null; record_dead: boolean | null; triggers: CandidateTrigger[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function safeUrl(v: unknown): v is string {
  try { const u = new URL(String(v)); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function readyCustomerReference(seed: CustomerReferenceSeed, stored: StoredReference | undefined): CustomerReference | null {
  if (!stored || stored.status !== "complete" || stored.catalog_version !== OPERATING_CATALOG_VERSION
    || stored.evidence_key !== customerReferenceEvidenceKey(seed) || !object(stored.result)) return null;
  try { customerReferenceCatalogSources(seed); } catch { return null; }
  const result = stored.result;
  if (result.id !== seed.id || result.catalogVersion !== OPERATING_CATALOG_VERSION || result.status !== "verified"
    || !object(result.answers) || typeof result.completedAt !== "string" || !Number.isFinite(Date.parse(result.completedAt))) return null;
  const sources = new Map(seed.sources.map(source => [source.url, source]));
  for (const facet of OPERATING_FACETS) {
    const answer = result.answers[facet.id];
    if (!object(answer) || !object(answer.nativeResult) || answer.facetVersion !== catalogFacetVersion(facet)
      || answer.nativeResult.questionId !== facet.id || operatingFacetDecision(answer.nativeResult.answer) !== answer.decision
      || !Array.isArray(answer.sourceUrls) || (!answer.sourceUrls.length && answer.decision !== "insufficient_evidence")
      || answer.sourceUrls.some(url => typeof url !== "string" || !sources.has(url))) return null;
  }
  // Identity and announcement come from the maintained seed, never provider prose.
  // Only public website receipts and native choices cross the browser boundary.
  return { id: seed.id, name: seed.name, domain: seed.domain, website: seed.website,
    announcementDate: seed.announcementDate, announcementType: seed.announcementType,
    buyingProgramId: seed.buyingProgramId, subindustry: seed.comparisonIndustry,
    catalogVersion: OPERATING_CATALOG_VERSION, completedAt: result.completedAt, status: "verified",
    sources: seed.sources.map(source => ({ url: source.url, title: source.title, contentHash: source.contentHash })),
    answers: result.answers as CustomerReference["answers"], identityNotes: seed.identityNotes };
}

const TIMING_LABELS: Record<string, string> = {
  ma: "Acquisition", m_and_a: "Acquisition", finance_hire: "Finance hiring", new_entity: "New entity",
  new_facility: "New facility", new_location: "New location", fleet_expansion: "Fleet expansion",
  new_service_line: "New service line", new_service: "New service", erp_tech: "Finance-system activity",
  federal_award: "Verified federal award", federal_subaward: "Federal subaward", sam_award_notice: "SAM award notice",
  government_announcement: "Government award announcement", operating_change: "Operating change",
};
export function customerWhyNow(row: CandidateRow, now: number): CustomerWhyNow[] {
  const seen = new Set<string>();
  return (row.triggers ?? []).filter(trigger => {
    const time = trigger.signal_date ? Date.parse(trigger.signal_date) : NaN;
    if (!Number.isFinite(time) || time > now || now - time > 180 * 86_400_000 || !TIMING_LABELS[trigger.type]
      || !safeUrl(trigger.source_url) || !isPublishableTriggerForCompany(trigger, row)) return false;
    const finding = trigger.metadata?.jevFinding;
    const attrs = object(finding) && object(finding.attributes) ? finding.attributes : null;
    if (attrs && (attrs.companyRelationship !== "direct" || (attrs.contentClass && attrs.contentClass !== "actual_company_development"))) return false;
    if (trigger.type === "erp_tech" && (!attrs || attrs.operatingChangeType !== "systems_change")) return false;
    if (trigger.type === "operating_change" && (!attrs || !["expansion", "service_launch", "systems_change", "contract_award", "billing_or_finance_process"].includes(String(attrs.operatingChangeType)))) return false;
    const key = object(finding) && typeof finding.eventId === "string" ? finding.eventId : `${trigger.source_url}|${trigger.type}|${trigger.signal_date}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.signal_date!.localeCompare(a.signal_date!) || a.id.localeCompare(b.id)).slice(0, 3)
    .map(trigger => ({ id: trigger.id, label: TIMING_LABELS[trigger.type], eventDate: trigger.signal_date!, sourceUrl: trigger.source_url! }));
}

export async function loadCustomerMatches(input: { pattern: string; page: number; showHidden: boolean }): Promise<CustomerMatchesResult> {
  const db = serviceClient();
  const seeds = referenceData.references as CustomerReferenceSeed[];
  const facetVersions = Object.fromEntries(OPERATING_FACETS.map(f => [f.id, catalogFacetVersion(f)]));
  const [snapshot, referenceRows] = await Promise.all([
    db.rpc("intelligence_customer_match_candidates", { p_catalog_version: OPERATING_CATALOG_VERSION, p_facet_versions: facetVersions, p_show_hidden: input.showHidden }),
    db.from("intelligence_customer_references").select("id,catalog_version,evidence_key,status,result").in("id", seeds.map(seed => seed.id)),
  ]);
  if (snapshot.error) throw snapshot.error;
  if (referenceRows.error) throw referenceRows.error;
  if (!snapshot.data || !Array.isArray(snapshot.data.accounts)) throw new Error("customer_matches_unavailable");
  const rows = new Map((referenceRows.data as StoredReference[] ?? []).map(row => [row.id, row]));
  const references = seeds.flatMap(seed => { const ref = readyCustomerReference(seed, rows.get(seed.id)); return ref ? [ref] : []; });
  const now = Date.now();
  const candidates = (snapshot.data.accounts as CandidateRow[]).map(row => ({ companyId: row.companyId, name: row.name, domain: row.domain,
    subindustry: row.subindustry, internalId: row.internalId, status: row.status, decisions: row.decisions,
    whyNow: customerWhyNow(row, now) }));
  const result = rankCustomerMatches({ candidates, references, referenceTotal: seeds.length, asOf: referenceData.asOf,
    pattern: input.pattern, page: input.page, now });
  if (!result.accounts.length) return result;
  const hydrated = await db.rpc("intelligence_customer_match_evidence", { p_catalog_version: OPERATING_CATALOG_VERSION, p_facet_versions: facetVersions,
    p_selection: result.accounts.map(account => ({ companyId: account.companyId, facets: account.reference.sharedTraits.map(trait => trait.id) })) });
  if (hydrated.error) throw hydrated.error;
  if (!Array.isArray(hydrated.data)) throw new Error("customer_match_evidence_unavailable");
  const evidence = new Map((hydrated.data as Pick<TopicSearchAccountRow, "companyId" | "observations" | "catalogFacets">[]).map(row => [row.companyId, row]));
  result.accounts = result.accounts.flatMap(account => {
    const row = evidence.get(account.companyId);
    if (!row) return [];
    const topics = (row.catalogFacets ?? []).flatMap(facet => { const topic = catalogTopic(facet, row.observations); return topic ? [topic] : []; });
    // Current proof must cover every stated shared fact even if a source changed
    // during this read. A stale answer cannot survive merely as a similarity tag.
    if (account.reference.sharedTraits.some(trait => !topics.some(topic => topic.id === trait.id))) return [];
    return [{ ...account, topics }];
  });
  return result;
}
