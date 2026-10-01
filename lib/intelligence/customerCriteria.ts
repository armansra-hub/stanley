import type { ApprovedCustomerCatalog, ApprovedCustomerCriterion, CustomerBusinessScopeProof } from "./customerApprovedCatalog";
import type { OperatingMatchTopic } from "./topicSearch";

/** Read-side models. Authored customer bindings and native prospect answers
 * have separate provenance; evidence-field observations never imply a match. */
export type CustomerCriterionExample = {
  customerId: string; distinctCompanyKey: string; name: string; website: string | null;
  industry: string | null; industryIds: string[]; identityQualification: unknown;
  offeringScope: string; whyMatches: string; factIds: string[];
  facts: CustomerBusinessScopeProof["facts"]; sourceGaps: string[]; profileSha256: string;
};
export type CustomerCriteriaCatalogResult = {
  available: true; version: string; status: "approved"; processing: "paused" | "enabled" | "unavailable";
  families: ApprovedCustomerCatalog["navigationFamilies"];
  criteria: (ApprovedCustomerCriterion & { supportedCustomers: number; evaluatedCustomers: number })[];
  industries: { id: string; label: string }[];
  customerCoverage: { records: number; businessScopesClosed: number; identityOrSourceGaps: number;
    criterionBoundRecords: number; fieldMappedRecords: number };
};
export type CustomerCriteriaCandidate = {
  companyId: string; name: string; domain: string | null; subindustry: string | null; internalId: string;
  status?: string; decisions: Record<string, string>; industryIds?: string[] | null;
};
export type CustomerCriteriaAccount = CustomerCriteriaCandidate & {
  sharedCriteria: { id: string; label: string; customer: CustomerCriterionExample }[];
  topics: OperatingMatchTopic[];
};
export type CustomerCriteriaMatches = {
  version: string; criterion: string; industry: string; page: number; pageSize: number; hasMore: boolean;
  state: "ready" | "not_yet_evaluated" | "industry_not_established";
  total: number | null; evaluatedAccounts: number; industryUnknownAccounts: number;
  accounts: CustomerCriteriaAccount[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function customerProviderIndustry(proof: CustomerBusinessScopeProof): { label: string | null; ids: string[] } {
  const own = proof.mapping.ownIndustry;
  // Only an explicitly authored provider classification with cited own facts.
  if (!object(own) || !Array.isArray(own.factIds) || !own.factIds.length
    || !own.factIds.every(id => proof.facts.some(f => f.id === id && f.state === "supported" && f.subject.kind === "customer"))) return { label: null, ids: [] };
  const rawIds = proof.mapping.providerIndustryIds ?? own.industryIds;
  const industryFacts = proof.mapping.industryFactIds ?? own.factIds;
  const attributed = Array.isArray(industryFacts) && industryFacts.length > 0
    && industryFacts.every(id => proof.facts.some(f => f.id === id && f.state === "supported" && f.subject.kind === "customer"));
  return { label: typeof own.label === "string" ? own.label : null,
    ids: attributed && Array.isArray(rawIds) && rawIds.every(x => typeof x === "string") ? [...new Set(rawIds)] : [] };
}
export function criterionCustomerExamples(criterion: ApprovedCustomerCriterion, proofs: readonly CustomerBusinessScopeProof[], industry = "all"): CustomerCriterionExample[] {
  const examples: CustomerCriterionExample[] = [], distinct = new Set<string>();
  for (const proof of proofs) {
    if (proof.businessScope.status === "identity_or_source_gap") continue;
    const ownIndustry = customerProviderIndustry(proof);
    if (industry !== "all" && !ownIndustry.ids.includes(industry)) continue;
    const bindings = proof.criterionBindings.filter(b => b.criterionId === criterion.id && b.definitionVersion === criterion.definitionVersion
      && b.profileSha256 === proof.fullProfileSha256 && b.state === "supported" && b.factIds.length
      && b.factIds.every(id => proof.facts.some(f => f.id === id && f.state === "supported" && f.subject.kind === "customer")));
    for (const binding of bindings) {
      const distinctCompanyKey = typeof proof.mapping.distinctCompanyKey === "string" ? proof.mapping.distinctCompanyKey : proof.customerId;
      const key = `${distinctCompanyKey}\0${binding.offeringScope}`;
      if (distinct.has(key)) continue;
      distinct.add(key);
      examples.push({ customerId: proof.customerId, distinctCompanyKey, name: proof.name, website: proof.website,
        industry: ownIndustry.label, industryIds: ownIndustry.ids,
        identityQualification: proof.mapping.identityQualification ?? proof.mapping.identityAttribution ?? proof.mapping.identityStatus ?? null,
        offeringScope: binding.offeringScope, whyMatches: binding.whyMatches, factIds: binding.factIds,
        facts: proof.facts.filter(f => binding.factIds.includes(f.id)), sourceGaps: proof.sourceGaps, profileSha256: proof.fullProfileSha256 });
    }
  }
  return examples.sort((a, b) => a.name.localeCompare(b.name) || a.customerId.localeCompare(b.customerId));
}
export function projectCustomerCriteriaCatalog(catalog: ApprovedCustomerCatalog, proofs: readonly CustomerBusinessScopeProof[],
  industries: { id: string; label: string }[], processing: CustomerCriteriaCatalogResult["processing"]): CustomerCriteriaCatalogResult {
  return { available: true, version: catalog.version, status: "approved", processing, families: catalog.navigationFamilies, industries,
    criteria: catalog.facets.map(f => ({ ...f,
      supportedCustomers: new Set(criterionCustomerExamples(f, proofs).map(e => e.distinctCompanyKey)).size,
      evaluatedCustomers: new Set(proofs.filter(p => p.criterionBindings.some(b => b.criterionId === f.id && b.definitionVersion === f.definitionVersion))
        .map(p => typeof p.mapping.distinctCompanyKey === "string" ? p.mapping.distinctCompanyKey : p.customerId)).size })),
    customerCoverage: { records: proofs.length, businessScopesClosed: proofs.filter(p => p.businessScope.status !== "identity_or_source_gap").length,
      identityOrSourceGaps: proofs.filter(p => p.businessScope.status === "identity_or_source_gap").length,
      criterionBoundRecords: proofs.filter(p => p.criterionBindings.length > 0).length,
      fieldMappedRecords: proofs.filter(p => Array.isArray(p.mapping.matches) && p.mapping.matches.length > 0).length } };
}
/** All patterns is the union of whole supported predicates. A navigation family
 * and a field's presence are never predicates. No financial/purchase score. */
export function matchCustomerCriteria(input: {
  catalog: ApprovedCustomerCatalog; proofs: readonly CustomerBusinessScopeProof[]; candidates: readonly CustomerCriteriaCandidate[];
  criterion: string; industry: string; page: number;
}): CustomerCriteriaMatches {
  const criteria = input.criterion === "all" ? input.catalog.facets : input.catalog.facets.filter(f => f.id === input.criterion);
  if (!criteria.length || !Number.isSafeInteger(input.page) || input.page < 1) throw new Error("invalid_customer_criteria_selection");
  const examples = new Map(criteria.map(c => [c.id, criterionCustomerExamples(c, input.proofs, input.industry)]));
  const seen = new Set<string>();
  let evaluatedAccounts = 0, industryUnknownAccounts = 0;
  const accounts = input.candidates.flatMap(candidate => {
    if (seen.has(candidate.companyId)) return [];
    seen.add(candidate.companyId);
    const evaluated = criteria.some(c => Object.hasOwn(candidate.decisions, c.id));
    if (evaluated) evaluatedAccounts++;
    if (input.industry !== "all") {
      if (!candidate.industryIds) industryUnknownAccounts++;
      if (!candidate.industryIds?.includes(input.industry)) return [];
    }
    const domain = (candidate.domain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
    const sharedCriteria = criteria.flatMap(c => {
      if (candidate.decisions[c.id] !== "supported") return [];
      const customer = examples.get(c.id)?.find(e => {
        if (!domain || !e.website) return true;
        try { return new URL(e.website).hostname.replace(/^www\./, "").toLowerCase() !== domain; } catch { return false; }
      });
      return customer ? [{ id: c.id, label: c.label, customer }] : [];
    });
    return sharedCriteria.length ? [{ ...candidate, sharedCriteria, topics: [] } satisfies CustomerCriteriaAccount] : [];
  }).sort((a, b) => b.sharedCriteria.length - a.sharedCriteria.length || a.name.localeCompare(b.name) || a.companyId.localeCompare(b.companyId));
  const pageSize = 25, offset = (input.page - 1) * pageSize;
  const state = !evaluatedAccounts ? "not_yet_evaluated" : input.industry !== "all" && industryUnknownAccounts === seen.size ? "industry_not_established" : "ready";
  return { version: input.catalog.version, criterion: input.criterion, industry: input.industry, page: input.page, pageSize,
    state, total: state === "ready" ? accounts.length : null, evaluatedAccounts, industryUnknownAccounts,
    hasMore: offset + pageSize < accounts.length, accounts: accounts.slice(offset, offset + pageSize) };
}
