import { operatingFacet, type OperatingFacetDecision } from "./operatingCatalog";
import type { OperatingMatchTopic } from "./topicSearch";
import { summarizeCustomerCohort, type CustomerCohortSummary } from "./customerCohortSummary";
import type { loadCustomerResearchSummary } from "./customerResearchServer";

/** Public response types and deterministic cached-fact ranking. No provider calls. */
export type CustomerReferenceSource = { url: string; title: string; contentHash: string; text?: string };
export type CustomerReferenceReading = { status: "complete" | "pending" | "running" | "blocked"; answered: number; total: 47;
  lastError: string | null; updatedAt: string | null; unavailableAnswers?: number };
export type CustomerReference = {
  id: string; name: string; domain: string; website: string; announcementDate: string;
  announcementType: "new_customer" | "expansion" | "renewal" | "unknown"; buyingProgramId?: string;
  subindustry?: string; catalogVersion: string; completedAt: string | null; status: "verified" | "partial" | "pending";
  reading?: CustomerReferenceReading;
  sources: CustomerReferenceSource[];
  answers: Record<string, { decision: OperatingFacetDecision; nativeResult: unknown; facetVersion: string; sourceUrls: string[] }>;
  identityNotes?: string[];
};
export type CustomerReferenceRegistry = { schemaVersion: 1; asOf: string; references: CustomerReference[] };
type Branch = { id: string; label: string; all: string[]; anchor: string[]; optional: string[]; subindustries?: string[]; prospectNonAsset3pl?: boolean };
export type CustomerPattern = { id: string; label: string; description: string; branches: Branch[] };

const facilities = ["Facilities Management & Commercial Cleaning"];
const creative = ["Advertising & Marketing", "Multimedia & Graphic Design"];
export const CUSTOMER_PATTERNS: CustomerPattern[] = [
  { id: "integrators", label: "IT, AV and security integrators", description: "Equipment, installation and ongoing IT/security delivery.", branches: [
    { id: "it-integrators", label: "IT resale, installation and managed service", all: ["rr_c01", "rr_i01"], anchor: ["rr_i01"], optional: ["rr_c05", "rr_c06"] },
  ] },
  { id: "facilities", label: "Multi-site cleaning and facilities", description: "Customer-site service with projects or a managed provider network. Industry is the recorded CRM classification.", branches: [
    { id: "facilities-projects", label: "Customer sites plus routine and project service", all: ["rr_c05", "rr_f01"], anchor: [], optional: ["rr_f02", "rr_c06"], subindustries: facilities },
    { id: "facilities-network", label: "Customer sites with provider coordination and payments", all: ["rr_c05", "rr_c04", "rr_s03"], anchor: [], optional: ["rr_c03"], subindustries: facilities },
  ] },
  { id: "provider-networks", label: "Service networks with provider payments", description: "Specific provider-delivery and payment roles, separated by operating model.", branches: [
    { id: "facility-providers", label: "Facilities provider network", all: ["rr_c04", "rr_s03"], anchor: [], optional: ["rr_c05", "rr_c03"], subindustries: facilities },
    { id: "delivery-providers", label: "Last-mile partners and payouts", all: ["rr_t05", "rr_c04", "rr_s03"], anchor: ["rr_t05"], optional: ["rr_c05"] },
    { id: "staffing-providers", label: "Staffing assignments and provider payments", all: ["rr_p01", "rr_c04", "rr_s03"], anchor: ["rr_p01"], optional: ["rr_c03"] },
  ] },
  { id: "transport", label: "Asset-based and other transport models", description: "Fleet plus brokerage, specialized brokerage, and last-mile delivery stay distinct. This broad view does not require non-asset status. Brokerage alone never means non-asset.", branches: [
    { id: "fleet-specialized", label: "Owned fleet and brokerage with specialized freight", all: ["rr_t02", "rr_t04"], anchor: ["rr_t02"], optional: ["rr_t03", "rr_c05"] },
    { id: "fleet-multiple", label: "Owned fleet and brokerage with several transport services", all: ["rr_t02", "rr_t03"], anchor: ["rr_t02"], optional: ["rr_t04", "rr_c05"] },
    { id: "broker-specialized", label: "Specialized brokerage; asset ownership not inferred", all: ["rr_t01", "rr_t04"], anchor: ["rr_t01"], optional: ["rr_t02", "rr_t03", "rr_c05"] },
    { id: "last-mile", label: "Last-mile delivery with partner payments", all: ["rr_t05", "rr_s03"], anchor: ["rr_t05"], optional: ["rr_c04", "rr_c05"] },
  ] },
  { id: "non-asset-3pl", label: "Non-asset-based 3PLs", description: "Prospects require saved, source-backed Jev non-asset-based 3PL support. Brokerage alone is insufficient, and supported or conflicting owned-fleet evidence excludes the prospect. Customer comparisons establish shared freight or last-mile characteristics, not customer non-asset status.", branches: [
    { id: "broker-specialized", label: "Shared specialized freight brokerage", all: ["rr_t01", "rr_t04"], anchor: ["rr_t01"], optional: ["rr_t03", "rr_c05"], prospectNonAsset3pl: true },
    { id: "broker-programs", label: "Shared brokerage and transport programs", all: ["rr_t01", "rr_t03"], anchor: ["rr_t01"], optional: ["rr_t04", "rr_c05"], prospectNonAsset3pl: true },
    { id: "last-mile", label: "Shared last-mile delivery and partner payments", all: ["rr_t05", "rr_s03"], anchor: ["rr_t05"], optional: ["rr_c04", "rr_c05"], prospectNonAsset3pl: true },
  ] },
  { id: "field-service", label: "Equipment and field-service operators", description: "Project delivery with documented cost types and a concrete field-service mode.", branches: [
    { id: "routine-projects", label: "Project costs plus routine and reactive service", all: ["rr_f03", "rr_f01"], anchor: ["rr_f01"], optional: ["rr_c08", "rr_c05"] },
    { id: "documented-fieldwork", label: "Project costs plus documented field closeout", all: ["rr_f03", "rr_f02"], anchor: ["rr_f02"], optional: ["rr_c08", "rr_c05"] },
    { id: "technical-fieldwork", label: "Project costs plus testing or compliance services", all: ["rr_f03", "rr_c12"], anchor: ["rr_c12"], optional: ["rr_c08", "rr_c05"] },
  ] },
  { id: "implementation", label: "Implementation firms with ongoing support", description: "The company's own named-platform practice and continuing service.", branches: [
    { id: "vendor-implementation", label: "Platform implementation plus ongoing delivery", all: ["rr_c02", "rr_i02"], anchor: ["rr_i02"], optional: ["rr_c03", "rr_c06"] },
  ] },
  { id: "creative", label: "Creative businesses with physical operations", description: "Merchandise and fulfillment or physical events, not a generic agency label.", branches: [
    { id: "merchandise", label: "Creative services with merchandise and fulfillment", all: ["rr_c07"], anchor: [], optional: ["rr_c10", "rr_c06"], subindustries: creative },
    { id: "experiences", label: "Physical experiences and production projects", all: ["rr_m01", "rr_f03"], anchor: ["rr_m01"], optional: ["rr_c04", "rr_c05"] },
  ] },
  { id: "expert-platforms", label: "Expert services delivered through a platform", description: "Human expert work delivered through technology, with its actual service model.", branches: [
    { id: "investigation-platform", label: "Investigation expertise and a delivery platform", all: ["rr_c03", "rr_p02"], anchor: ["rr_p02"], optional: ["rr_c02", "rr_c12"] },
    { id: "research-platform", label: "Research/advisory membership and a delivery platform", all: ["rr_c03", "rr_p03"], anchor: ["rr_p03"], optional: ["rr_c11", "rr_c02"] },
    { id: "language-platform", label: "Language services delivered through a platform", all: ["rr_c03", "rr_c02"], anchor: [], optional: ["rr_c04", "rr_s03"], subindustries: ["Translation & Linguistic Services"] },
  ] },
  { id: "media-rights", label: "Media with rights-owner payments", description: "Licensing revenue and outgoing royalties are separately established.", branches: [
    { id: "rights-payments", label: "Licensing and rights-owner payments", all: ["rr_c11", "rr_m04"], anchor: ["rr_m04"], optional: ["rr_m02"] },
  ] },
];

export type CustomerMatchCandidate = {
  companyId: string; name: string; domain: string | null; subindustry: string | null; internalId: string; status: string;
  decisions: Record<string, OperatingFacetDecision>;
  /** Source-backed, saved native Jev answer about this prospect, never inferred from brokerage. */
  nonAsset3pl?: OperatingMatchTopic;
  whyNow: CustomerWhyNow[];
};
export type CustomerWhyNow = { id: string; label: string; eventDate: string; sourceUrl: string };
type Trait = { id: string; label: string };
export type CustomerMatchAccount = Omit<CustomerMatchCandidate, "decisions"> & {
  primaryPattern: { id: string; label: string; branchId: string; branchLabel: string };
  otherPatterns: { id: string; label: string }[];
  reference: { id: string; name: string; domain: string; website: string; announcementDate: string;
    announcementType: CustomerReference["announcementType"]; recent: boolean; ageDays: number; sources: CustomerReferenceSource[];
    reading?: CustomerReferenceReading;
    sharedTraits: Trait[]; unknownTraits: Trait[]; differentTraits: Trait[];
    sharedTraitSources: { traitId: string; urls: string[] }[];
    sharedNativeAnswers?: { traitId: string; nativeResult: unknown }[] };
  fit: { label: string; explanation: string; rarity: { matched: number; assessed: number }; industryBasis: string };
  topics: OperatingMatchTopic[];
};
export type CustomerMatchesResult = {
  research?: Awaited<ReturnType<typeof loadCustomerResearchSummary>>;
  industry?: string;
  industries?: { id: string; label: string; prospects: number; customers: number }[];
  patterns: { id: string; label: string; description: string; count: number; referenceCount: number }[];
  accounts: CustomerMatchAccount[]; total: number; page: number; pageSize: 25; hasMore: boolean;
  referenceCoverage: { verified: number; pending: number; asOf: string; total?: number; partial?: number; usable?: number };
  customerCohort?: CustomerCohortSummary;
  /** Completion is reported by the canonical catalog endpoint, not recomputed by the shortlist. */
  coverage: { eligible: number; assessed: number | null; asOf: string };
  note: string;
};
const DAY = 86_400_000;
const supported = (d: Record<string, OperatingFacetDecision>, ids: string[]) => ids.every(id => d[id] === "supported");
const decisive = (d: Record<string, OperatingFacetDecision>, ids: string[]) => ids.every(id => d[id] === "supported" || d[id] === "not_supported");
const trait = (id: string): Trait => ({ id, label: operatingFacet(id)?.label ?? id });
// NetSuite imports and public discovery use two established label vocabularies
// (see businessServices.ts laneFor). These explicit equivalent lane names are
// metadata aliases only; no name/domain keywords establish an industry. Broad
// Operational Support Services is deliberately not inferred to be cleaning or
// translation, and Advisory Services is not inferred to be implementation.
const COMPARISON_INDUSTRY_ALIASES: readonly (readonly string[])[] = [
  ["Facilities Management", "Facilities Management & Commercial Cleaning"],
  ["Agencies", "Advertising & Marketing", "Multimedia & Graphic Design"],
];
export function industryMatches(subindustry: string | null | undefined, allowed: readonly string[]): boolean {
  if (!subindustry) return false;
  if (allowed.includes(subindustry)) return true;
  return COMPARISON_INDUSTRY_ALIASES.some(group => group.includes(subindustry) && allowed.some(value => group.includes(value)));
}
const branchIndustry = (subindustry: string | null | undefined, branch: Branch) => !branch.subindustries || industryMatches(subindustry, branch.subindustries);
const fleetExcluded = (decisions: Record<string, OperatingFacetDecision>) => ["supported", "conflicting"].includes(decisions.rr_t02);
const branchCandidateEligible = (candidate: CustomerMatchCandidate, branch: Branch) => branchIndustry(candidate.subindustry, branch)
  && (!branch.prospectNonAsset3pl || (candidate.nonAsset3pl?.id === "non_asset_based_3pl"
    && candidate.nonAsset3pl.state === "supported" && candidate.nonAsset3pl.sources.length > 0 && !fleetExcluded(candidate.decisions)));

// Independent optional reasons each contribute once, regardless of overlapping
// category count. These groups affect ordering, never native facet decisions.
const INDEPENDENT_REASONS = [
  ["rr_c03", "rr_c04", "rr_s03"], ["rr_c05"], ["rr_c06"],
  ["rr_c08", "rr_c10"], ["rr_c02", "rr_c11", "rr_c12"], ["rr_t03", "rr_t04", "rr_m02"],
];

export function rankCustomerMatches(input: { candidates: CustomerMatchCandidate[]; references: CustomerReference[]; asOf: string;
  referenceTotal: number; pattern?: string; industry?: string; page?: number; now?: number }): CustomerMatchesResult {
  const now = input.now ?? Date.now(), selected = input.pattern ?? "all", page = input.page ?? 1;
  const industry = input.industry ?? "all";
  if (selected !== "all" && !CUSTOMER_PATTERNS.some(p => p.id === selected)) throw new Error("invalid_customer_pattern");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("invalid_customer_page");
  const allCandidates = [...new Map(input.candidates.map(c => [c.companyId, c])).values()];
  const candidates = industry === "all" ? allCandidates : allCandidates.filter(candidate => industryMatches(candidate.subindustry, [industry]));
  // Audited registry IDs are the entity deduplication boundary. Distinct
  // businesses can share a website or buying program and still have different
  // operating facts; neither relationship removes a customer from comparison.
  // Renewal-only customers remain comparable, with their event type displayed.
  const refs = [...input.references].filter(ref => ["verified", "partial"].includes(ref.status)
    && Number.isFinite(Date.parse(ref.announcementDate)) && Date.parse(ref.announcementDate) <= now)
    .sort((a, b) => b.announcementDate.localeCompare(a.announcementDate) || a.id.localeCompare(b.id));
  const entities = new Set<string>();
  const allReferences = refs.filter(ref => {
    if (entities.has(ref.id)) return false;
    entities.add(ref.id); return true;
  });
  const industryNames = [...new Set([...allCandidates.map(row => row.subindustry), ...allReferences.map(row => row.subindustry)]
    .filter((value): value is string => typeof value === "string" && !!value.trim()))].sort((a, b) => a.localeCompare(b));
  const industries = industryNames.map(label => ({ id: label, label,
    prospects: allCandidates.filter(row => industryMatches(row.subindustry, [label])).length,
    customers: allReferences.filter(row => industryMatches(row.subindustry, [label])).length }));
  const references = industry === "all" ? allReferences : allReferences.filter(reference => industryMatches(reference.subindustry, [industry]));
  const referenceDecisions = new Map(references.map(ref => [ref.id, Object.fromEntries(Object.entries(ref.answers).map(([id, answer]) => [id, answer.decision]))]));
  const branches = CUSTOMER_PATTERNS.flatMap(pattern => pattern.branches.map(branch => {
    const cohort = candidates.filter(c => branchCandidateEligible(c, branch) && supported(c.decisions, branch.anchor));
    const assessed = cohort.filter(c => decisive(c.decisions, branch.all)).length;
    const matched = cohort.filter(c => supported(c.decisions, branch.all)).length;
    // Customer references establish the shared service facts, not non-asset
    // status. The optional ownership requirement belongs to the prospect only.
    const refs = references.filter(ref => branchIndustry(ref.subindustry, branch) && supported(referenceDecisions.get(ref.id)!, branch.all));
    // A shrinkage prior prevents tiny cohorts from creating extreme rarity.
    const distinctiveness = assessed > 0 ? Math.log2((assessed + 10) / (matched + 10)) : 0;
    return { pattern, branch, refs, assessed, matched, distinctiveness };
  }));
  const patternCounts = new Map(CUSTOMER_PATTERNS.map(p => [p.id, new Set<string>()]));
  const ranked = candidates.flatMap(candidate => {
    const matches = branches.flatMap(info => {
      const { pattern, branch, refs, distinctiveness } = info;
      if (!branchCandidateEligible(candidate, branch) || !supported(candidate.decisions, branch.all)) return [];
      return refs.flatMap(reference => {
        if (candidate.domain?.toLowerCase().replace(/^www\./, "") === reference.domain.toLowerCase().replace(/^www\./, "")) return [];
        const refDecisions = referenceDecisions.get(reference.id)!;
        const optional = branch.optional.filter(id => refDecisions[id] === "supported" && candidate.decisions[id] === "supported");
        const independent = INDEPENDENT_REASONS.filter(group => group.some(id => optional.includes(id))).length;
        const age = Math.max(0, (now - Date.parse(reference.announcementDate)) / DAY);
        const recency = Math.pow(0.5, age / 180);
        // Transparent local ordering, not a conversion probability or TAM grade.
        const fitOrder = distinctiveness + recency + independent * 0.15;
        patternCounts.get(pattern.id)!.add(candidate.companyId);
        return [{ ...info, reference, refDecisions, optional, fitOrder, recent: age <= 180, ageDays: Math.floor(age) }];
      });
    }).sort((a, b) => (selected === "all" ? Number(Boolean(b.branch.prospectNonAsset3pl)) - Number(Boolean(a.branch.prospectNonAsset3pl)) : 0)
      || Number(b.recent) - Number(a.recent) || b.fitOrder - a.fitOrder || b.reference.announcementDate.localeCompare(a.reference.announcementDate)
      || a.pattern.id.localeCompare(b.pattern.id) || a.branch.id.localeCompare(b.branch.id) || a.reference.id.localeCompare(b.reference.id));
    const best = matches.find(match => selected === "all" || match.pattern.id === selected);
    if (!best) return [];
    const related = [...new Map(matches.filter(m => m.pattern.id !== best.pattern.id).map(m => [m.pattern.id, { id: m.pattern.id, label: m.pattern.label }])).values()];
    const relevant = [...new Set([...best.branch.all, ...best.branch.optional])];
    const shared = relevant.filter(id => best.refDecisions[id] === "supported" && candidate.decisions[id] === "supported");
    const notEstablished = relevant.filter(id => best.refDecisions[id] === "supported" && !["supported", "not_supported"].includes(candidate.decisions[id]));
    const different = relevant.filter(id => best.refDecisions[id] === "supported" && candidate.decisions[id] === "not_supported");
    const account: CustomerMatchAccount = {
      ...candidate, primaryPattern: { id: best.pattern.id, label: best.pattern.label, branchId: best.branch.id, branchLabel: best.branch.label },
      otherPatterns: related, reference: { id: best.reference.id, name: best.reference.name, domain: best.reference.domain,
        website: best.reference.website, announcementDate: best.reference.announcementDate, announcementType: best.reference.announcementType,
        recent: best.recent, ageDays: best.ageDays, reading: best.reference.reading ?? {
          status: best.reference.status === "verified" ? "complete" : "pending", answered: Object.keys(best.reference.answers).length,
          total: 47, lastError: null, updatedAt: best.reference.completedAt },
        sources: best.reference.sources, sharedTraits: shared.map(trait), unknownTraits: notEstablished.map(trait), differentTraits: different.map(trait),
        sharedTraitSources: shared.map(id => ({ traitId: id, urls: best.reference.answers[id].sourceUrls })),
        sharedNativeAnswers: shared.map(id => ({ traitId: id, nativeResult: best.reference.answers[id].nativeResult })) },
      fit: { label: "Evidence-backed operating resemblance", explanation: (best.branch.prospectNonAsset3pl
        ? "Saved Jev evidence separately establishes the prospect's non-asset-based 3PL status; the customer shares the listed service characteristics, with no claim about the customer's asset ownership. " : "")
        + "Complete shared operating combination. Within the selected operating pattern, references announced in the past 180 days come first; older examples remain available. Within those tiers: assessed-peer distinctiveness, reference recency (180-day half-life), and independent shared reasons. Dated timing breaks close fit ties.",
        rarity: { matched: best.matched, assessed: best.assessed },
        industryBasis: best.branch.subindustries ? "Recorded CRM industry filter; business characteristics independently interpreted by Jev." : "Shared native industry-specific operating facts; no name or keyword industry guess." },
      topics: [],
    };
    // Decisions are internal routing data; the UI receives cited supported topics.
    delete (account as Partial<CustomerMatchCandidate>).decisions;
    // This proof describes the prospect only and belongs only to branches using
    // the explicit non-asset requirement, not unrelated customer similarities.
    if (!best.branch.prospectNonAsset3pl) delete account.nonAsset3pl;
    return [{ account, fitOrder: best.fitOrder }];
  }).sort((a, b) => {
    // Within a small, explicit fit band, a real dated reason to act comes first.
    const band = (score: number) => Math.floor(score * 4);
    return Number(b.account.reference.recent) - Number(a.account.reference.recent)
      || band(b.fitOrder) - band(a.fitOrder) || Number(b.account.whyNow.length > 0) - Number(a.account.whyNow.length > 0)
      || b.fitOrder - a.fitOrder || a.account.companyId.localeCompare(b.account.companyId);
  });
  const start = (page - 1) * 25;
  const complete = allReferences.filter(ref => ref.status === "verified").length;
  return {
    industry, industries,
    patterns: CUSTOMER_PATTERNS.map(p => ({ id: p.id, label: p.label, description: p.description, count: patternCounts.get(p.id)!.size,
      referenceCount: new Set(branches.filter(b => b.pattern.id === p.id).flatMap(b => b.refs.map(r => r.id))).size })),
    accounts: ranked.slice(start, start + 25).map(r => r.account), total: ranked.length, page, pageSize: 25, hasMore: start + 25 < ranked.length,
    referenceCoverage: { verified: complete, partial: allReferences.length - complete, usable: allReferences.length,
      pending: Math.max(0, input.referenceTotal - complete), asOf: input.asOf, total: input.referenceTotal },
    customerCohort: summarizeCustomerCohort(references, now),
    coverage: { eligible: candidates.length, assessed: null, asOf: new Date(now).toISOString() },
    note: "A sourced customer resemblance, not a conversion score or confirmed finance pain. Unknown answers are not negatives, and unanswered questions remain absent. Completed and partial customer readings can contribute only their current source-backed native facts; every required pattern fact must be supported. Partial readings stay visibly incomplete, including held questions. Customer announcements include new customers, expansions and renewals; dates do not establish a new purchase. All customer patterns prefers the separate non-asset-based 3PL pattern when the prospect has the required sourced native proof; broader transport matches remain selectable. Rarity describes assessed prospects only. Ranking reads saved answers and makes no Jev requests.",
  };
}
