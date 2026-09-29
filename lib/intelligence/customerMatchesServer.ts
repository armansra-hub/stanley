import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isPublishableTriggerForCompany, type TriggerEvidence } from "@/lib/triggers/signalIntegrity";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, operatingFacetDecision } from "./operatingCatalog";
import { catalogFacetVersion } from "./operatingCoverage";
import { catalogTopic, type TopicSearchAccountRow } from "./topicSearch";
import { rankCustomerMatches, type CustomerMatchCandidate, type CustomerReference, type CustomerMatchesResult, type CustomerWhyNow } from "./customerMatches";
import { customerReferenceEvidenceKey, customerReferenceCatalogSources, type CustomerReferenceSeed } from "./customerReferenceSources";
import { NON_ASSET_3PL_TOPIC, savedNonAsset3plProof, type NonAssetObservation } from "./customerNonAsset3pl";
import { loadCustomerReferenceRegistry, loadCustomerReferenceMatchRows, loadCustomerReferencePartialRows, CUSTOMER_REFERENCE_CHECKPOINT_SELECT,
  customerReferenceRegistryProofSeed, customerReferenceRegistrySeed,
  type CustomerReferenceProofSeed, type CustomerReferenceRegistryRow, type StoredCustomerReference } from "./customerReferenceRegistry";

type StoredReference = StoredCustomerReference;
type CandidateTrigger = TriggerEvidence & { id: string; signal_date: string | null };
type CandidateRow = Omit<CustomerMatchCandidate, "whyNow"> & {
  description: string | null; ns_industry: string | null; record_dead: boolean | null; triggers: CandidateTrigger[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function safeUrl(v: unknown): v is string {
  try { const u = new URL(String(v)); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function readyCustomerReference(seed: CustomerReferenceProofSeed, stored: StoredReference | undefined): CustomerReference | null {
  if (!stored || stored.id !== seed.id || !["complete", "pending", "running", "blocked"].includes(stored.status)
    || stored.catalog_version !== OPERATING_CATALOG_VERSION || stored.evidence_key !== customerReferenceEvidenceKey(seed)) return null;
  try {
    if (!seed.sources.length) return null;
    const domain = seed.domain.toLowerCase().replace(/^www\./, ""), ids = new Set<string>();
    const official = (url: string) => { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); return host === domain || host.endsWith("." + domain); };
    for (const source of seed.sources) {
      if (new URL(source.url).protocol !== "https:" || ids.has(source.id) || !/^[a-f0-9]{64}$/.test(source.contentHash)
        || !Number.isFinite(Date.parse(source.observedAt)) || (!official(source.url) && !seed.sources.some(parent => parent.url === source.firstPartyLinkedFrom && official(parent.url)))) return null;
      ids.add(source.id);
    }
    // The private registry records validated hashes at capture. Ordinary cohort
    // reads need only that manifest; full bodies are checked for shown examples.
    if (seed.sources.every(source => typeof source.text === "string")) customerReferenceCatalogSources(seed as CustomerReferenceSeed);
  } catch { return null; }
  const complete = stored.status === "complete", result = stored.result;
  let rawAnswers: Record<string, unknown>, completedAt: string | null = null;
  if (complete) {
    if (!object(result) || result.id !== seed.id || result.catalogVersion !== OPERATING_CATALOG_VERSION || result.status !== "verified"
      || !object(result.answers) || typeof result.completedAt !== "string" || !Number.isFinite(Date.parse(result.completedAt))) return null;
    rawAnswers = result.answers; completedAt = result.completedAt;
  } else {
    if (stored.checkpoint_version !== 1 || stored.checkpoint_evidence_key !== stored.evidence_key || !object(stored.checkpoint_answers)) return null;
    rawAnswers = stored.checkpoint_answers;
  }
  const sources = new Map(seed.sources.map(source => [source.url, source]));
  const answers: CustomerReference["answers"] = {}; let unavailableAnswers = 0;
  for (const facet of OPERATING_FACETS) {
    const answer = rawAnswers[facet.id];
    if (answer === undefined && !complete) continue;
    if (!object(answer) || !object(answer.nativeResult) || answer.facetVersion !== catalogFacetVersion(facet)
      || answer.nativeResult.questionId !== facet.id || operatingFacetDecision(answer.nativeResult.answer) !== answer.decision
      || !Array.isArray(answer.sourceUrls) || (!answer.sourceUrls.length && answer.decision !== "insufficient_evidence")
      || answer.sourceUrls.some(url => typeof url !== "string" || !sources.has(url))) {
      if (complete) return null;
      unavailableAnswers++; continue;
    }
    // Keep the exact paid native object/citations. Missing or stale facets do
    // not become fabricated insufficient_evidence answers.
    answers[facet.id] = answer as CustomerReference["answers"][string];
  }
  if (!Object.keys(answers).length) return null;
  const lastError = typeof stored.checkpoint_last_error === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(stored.checkpoint_last_error)
    ? stored.checkpoint_last_error : null;
  // Identity and announcement come from the maintained seed, never provider prose.
  // Only public website receipts and native choices cross the browser boundary.
  return { id: seed.id, name: seed.name, domain: seed.domain, website: seed.website,
    announcementDate: seed.announcementDate, announcementType: seed.announcementType,
    buyingProgramId: seed.buyingProgramId, subindustry: seed.comparisonIndustry,
    catalogVersion: OPERATING_CATALOG_VERSION, completedAt, status: complete ? "verified" : "partial",
    reading: { status: stored.status as "complete" | "pending" | "running" | "blocked", answered: Object.keys(answers).length, total: 47,
      lastError: complete ? null : lastError, updatedAt: stored.updated_at && Number.isFinite(Date.parse(stored.updated_at)) ? stored.updated_at : completedAt,
      ...(unavailableAnswers ? { unavailableAnswers } : {}) },
    sources: seed.sources.map(source => ({ url: source.url, title: source.title, contentHash: source.contentHash })),
    answers, identityNotes: seed.identityNotes };
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

async function loadSavedNonAsset3pl(db: ReturnType<typeof serviceClient>) {
  const observations: NonAssetObservation[] = [];
  let after: string | null = null;
  // Indexed supported-topic lookup; no catalog rerun, model call or total cap.
  for (;;) {
    let query = db.from("intelligence_observations")
      .select("id,company_id,source_url,title,source_kind,event_date,observed_at,evidence_text,attributes,is_current,feedback_excluded")
      .eq("is_current", true).eq("feedback_excluded", false).contains("cached_operating_topics", [NON_ASSET_3PL_TOPIC])
      .order("id", { ascending: true }).limit(200);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error || !data) throw new Error("customer_non_asset_evidence_unavailable");
    observations.push(...data as NonAssetObservation[]);
    if (data.length < 200) break;
    after = data[data.length - 1].id;
  }
  return savedNonAsset3plProof(observations);
}

export async function loadCustomerMatches(input: { pattern: string; page: number; showHidden: boolean }): Promise<CustomerMatchesResult> {
  const db = serviceClient();
  const facetVersions = Object.fromEntries(OPERATING_FACETS.map(f => [f.id, catalogFacetVersion(f)]));
  const [snapshot, registry, referenceRows, nonAssetProofs] = await Promise.all([
    db.rpc("intelligence_customer_match_candidates", { p_catalog_version: OPERATING_CATALOG_VERSION, p_facet_versions: facetVersions, p_show_hidden: input.showHidden }),
    loadCustomerReferenceRegistry(), loadCustomerReferenceMatchRows(), loadSavedNonAsset3pl(db),
  ]);
  if (snapshot.error) throw snapshot.error;
  if (!snapshot.data || !Array.isArray(snapshot.data.accounts)) throw new Error("customer_matches_unavailable");
  const partialRows = await loadCustomerReferencePartialRows(registry, db);
  const seeds = registry.filter(row => row.source_status === "ready").flatMap(row => { const seed = customerReferenceRegistryProofSeed(row); return seed ? [seed] : []; });
  const rows = new Map([...partialRows, ...referenceRows].map(row => [row.id, row]));
  const references = seeds.flatMap(seed => { const ref = readyCustomerReference(seed, rows.get(seed.id)); return ref ? [ref] : []; });
  const now = Date.now();
  const candidates = (snapshot.data.accounts as CandidateRow[]).map(row => ({ companyId: row.companyId, name: row.name, domain: row.domain,
    subindustry: row.subindustry, internalId: row.internalId, status: row.status, decisions: row.decisions,
    ...(nonAssetProofs.has(row.companyId) ? { nonAsset3pl: nonAssetProofs.get(row.companyId)! } : {}),
    whyNow: customerWhyNow(row, now) }));
  const asOf = registry.reduce((latest, row) => row.as_of > latest ? row.as_of : latest, "2024-01-01");
  const result = rankCustomerMatches({ candidates, references, referenceTotal: registry.length, asOf,
    pattern: input.pattern, page: input.page, now });
  if (!result.accounts.length) return result;
  const selectedReferenceIds = [...new Set(result.accounts.map(account => account.reference.id))];
  const [hydrated, selectedRegistry, selectedNative] = await Promise.all([
    db.rpc("intelligence_customer_match_evidence", { p_catalog_version: OPERATING_CATALOG_VERSION, p_facet_versions: facetVersions,
      p_selection: result.accounts.map(account => ({ companyId: account.companyId, facets: account.reference.sharedTraits.map(trait => trait.id) })) }),
    db.from("intelligence_customer_reference_registry").select("*").eq("active", true).eq("source_status", "ready").in("id", selectedReferenceIds),
    db.from("intelligence_customer_references").select(`${CUSTOMER_REFERENCE_CHECKPOINT_SELECT},result`).in("id", selectedReferenceIds),
  ]);
  if (hydrated.error) throw hydrated.error;
  if (selectedRegistry.error || selectedNative.error) throw new Error("customer_reference_evidence_unavailable");
  if (!Array.isArray(hydrated.data)) throw new Error("customer_match_evidence_unavailable");
  const fullNative = new Map((selectedNative.data as StoredReference[] ?? []).map(row => [row.id, row]));
  const fullReferences = new Map((selectedRegistry.data as CustomerReferenceRegistryRow[] ?? []).flatMap(row => {
    if (fullNative.get(row.id)?.evidence_key !== rows.get(row.id)?.evidence_key) return [];
    const seed = customerReferenceRegistrySeed(row), ref = seed ? readyCustomerReference(seed, fullNative.get(seed.id)) : null;
    return ref ? [[ref.id, ref] as const] : [];
  }));
  const evidence = new Map((hydrated.data as Pick<TopicSearchAccountRow, "companyId" | "observations" | "catalogFacets">[]).map(row => [row.companyId, row]));
  result.accounts = result.accounts.flatMap(account => {
    const row = evidence.get(account.companyId);
    const fullReference = fullReferences.get(account.reference.id);
    if (!row || !fullReference) return [];
    const topics = (row.catalogFacets ?? []).flatMap(facet => { const topic = catalogTopic(facet, row.observations); return topic ? [topic] : []; });
    // Current proof must cover every stated shared fact even if a source changed
    // during this read. A stale answer cannot survive merely as a similarity tag.
    if (account.reference.sharedTraits.some(trait => !topics.some(topic => topic.id === trait.id))) return [];
    if (account.reference.sharedTraits.some(trait => fullReference.answers[trait.id]?.decision !== "supported")) return [];
    return [{ ...account, topics, reference: { ...account.reference, reading: fullReference.reading,
      sources: fullReference.sources,
      sharedTraitSources: account.reference.sharedTraits.map(trait => ({ traitId: trait.id, urls: fullReference.answers[trait.id].sourceUrls })),
      sharedNativeAnswers: account.reference.sharedTraits.map(trait => ({ traitId: trait.id, nativeResult: fullReference.answers[trait.id].nativeResult })) } }];
  });
  return result;
}
