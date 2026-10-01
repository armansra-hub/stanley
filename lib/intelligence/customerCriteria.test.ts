import { describe, expect, it } from "vitest";
import type { ApprovedCustomerCatalog, ApprovedCustomerCriterion, CustomerBusinessScopeProof } from "./customerApprovedCatalog";
import { criterionCustomerExamples, matchCustomerCriteria, projectCustomerCriteriaCatalog } from "./customerCriteria";
import { approvedCatalogTopic, buildApprovedTopicSearchResult, type CatalogFacetRow, type TopicSearchAccountRow } from "./topicSearch";

const criterion = (id: string): ApprovedCustomerCriterion => ({ id, label: id, definitionVersion: `semantic-${id}`, familyId: "family",
  sourceProposalKey: id, originalScope: "universal", applicability: { scope: "universal" }, predicate: "Sells a product and performs installation under the named offering.",
  evidenceRules: ["Both activities belong to the provider."], exclusions: ["Customer activity alone does not qualify."],
  positiveExamples: [{ scenario: "Equipment with installation", explanation: "Both established." }], negativeExamples: [{ scenario: "Installer software", explanation: "Customers install." }] });
const catalog = { version: "approved", facets: [criterion("one"), criterion("two")], navigationFamilies: [] } as unknown as ApprovedCustomerCatalog;
const proof = (): CustomerBusinessScopeProof => ({ customerId: "customer", name: "Example", website: "https://example.com", fullProfileSha256: "hash",
  businessScope: { status: "scope_complete_with_gaps" }, sourceGaps: ["Contract detail unavailable"],
  mapping: { ownIndustry: { label: "Installer", factIds: ["own"] }, providerIndustryIds: ["G10", "G06"], matches: [{ patternId: "offer" }], identityQualification: "inferred; disclosed" },
  facts: [{ id: "own", state: "supported", subject: { kind: "customer", name: "Example" }, citations: [] }],
  criterionBindings: [{ criterionId: "one", definitionVersion: "semantic-one", profileSha256: "hash", state: "supported", factIds: ["own"], offeringScope: "Equipment installations", whyMatches: "Both activities established" }],
} as unknown as CustomerBusinessScopeProof);
const candidate = { companyId: "prospect", name: "Prospect", domain: "prospect.com", subindustry: "Installer", internalId: "1", decisions: { one: "supported" }, industryIds: ["G10"] };
const match = (overrides: Partial<Parameters<typeof matchCustomerCriteria>[0]> = {}) => matchCustomerCriteria({ catalog, proofs: [proof()], candidates: [candidate], criterion: "all", industry: "all", page: 1, ...overrides });

describe("authored customer criterion comparisons", () => {
  it("treats all patterns as union of complete predicates, never field presence", () => {
    expect(match().accounts).toHaveLength(1);
    const p = proof(); p.criterionBindings = [];
    expect(match({ proofs: [p] }).accounts).toEqual([]);
    expect(projectCustomerCriteriaCatalog(catalog, [p], [], "paused").customerCoverage).toMatchObject({ fieldMappedRecords: 1, criterionBoundRecords: 0 });
  });
  it("excludes unresolved identities, foreign subjects, stale definitions and stale profile bindings", () => {
    const p = proof(); p.businessScope.status = "identity_or_source_gap";
    expect(criterionCustomerExamples(catalog.facets[0], [p])).toEqual([]);
    const other = proof(); other.facts[0].subject.kind = "partner";
    expect(match({ proofs: [other] }).accounts).toEqual([]);
    for (const field of ["definitionVersion", "profileSha256"] as const) {
      const stale = proof(); stale.criterionBindings[0][field] = "changed";
      expect(match({ proofs: [stale] }).accounts).toEqual([]);
    }
  });
  it("preserves inferred qualification, exact offering, source gaps and own-industry boundaries", () => {
    const examples = criterionCustomerExamples(catalog.facets[0], [proof()], "G06");
    expect(examples[0]).toMatchObject({ identityQualification: "inferred; disclosed", offeringScope: "Equipment installations", sourceGaps: ["Contract detail unavailable"] });
    expect(criterionCustomerExamples(catalog.facets[0], [proof()], "G01")).toEqual([]);
    expect(match({ industry: "G06" }).accounts).toEqual([]);
    expect(match({ industry: "G10" }).accounts).toHaveLength(1);
  });
  it("never turns absent prospect answers or unestablished industry into zero matches", () => {
    expect(match({ candidates: [{ ...candidate, decisions: {} }] })).toMatchObject({ state: "not_yet_evaluated", total: null });
    expect(match({ candidates: [{ ...candidate, industryIds: undefined }], industry: "G10" })).toMatchObject({ state: "industry_not_established", total: null });
    expect(match({ candidates: [{ ...candidate, decisions: { one: "insufficient_evidence" } }] })).toMatchObject({ state: "ready", total: 0, evaluatedAccounts: 1 });
  });
  it("requires the explicit industry review facts to belong to the provider", () => {
    const p = proof(); p.mapping.industryFactIds = ["missing"];
    expect(criterionCustomerExamples(catalog.facets[0], [p], "G10")).toEqual([]);
    expect(criterionCustomerExamples(catalog.facets[0], [p], "all")).toHaveLength(1);
    p.mapping.industryFactIds = ["own"];
    expect(criterionCustomerExamples(catalog.facets[0], [p], "G10")).toHaveLength(1);
  });
  it("does not use CRM industry text, family IDs, or customer domains as positive comparisons", () => {
    expect(match({ industry: "G10", candidates: [{ ...candidate, industryIds: undefined }] }).accounts).toEqual([]);
    expect(() => match({ criterion: "family" })).toThrow();
    expect(match({ candidates: [{ ...candidate, domain: "https://www.example.com" }] }).accounts).toEqual([]);
  });
  it("deduplicates exact company keys without treating every announcement as a new example", () => {
    const alias = proof(); alias.customerId = "alias"; alias.mapping.distinctCompanyKey = "same";
    const p = proof(); p.mapping.distinctCompanyKey = "same";
    expect(criterionCustomerExamples(catalog.facets[0], [p, alias])).toHaveLength(1);
    expect(match({ candidates: [candidate, candidate] }).accounts).toHaveLength(1);
  });
});

describe("approved native prospect proof", () => {
  const observation = { id: "obs", source_url: "https://prospect.com/service", evidence_text: "Installs equipment 😀", content_hash: "sha" } as TopicSearchAccountRow["observations"][number];
  const row = (): CatalogFacetRow => ({ id: "one", facetVersion: "native-v1", catalogVersion: "approved", decision: "supported", status: "answered", probability: null,
    nativeResult: { questionId: "one", answer: { type: "choice", choice: "supported" }, untouched: true }, citations: [{ observationId: "obs", contentHash: "sha", url: observation.source_url, title: "Service", sourceKind: "website", eventDate: null, observedAt: "2026-10-01", start: 0, end: observation.evidence_text.length }] });
  it("uses exact UTF16 evidence and retains the original native payload", () => {
    const r = row(), topic = approvedCatalogTopic(r, [observation], catalog, { one: "native-v1" });
    expect(topic?.nativeResult).toBe(r.nativeResult);
    expect(topic?.sources[0].contextPreview).toBe(observation.evidence_text);
  });
  it("rejects changed native semantics, source hash, URL and any bad citation", () => {
    expect(approvedCatalogTopic(row(), [observation], catalog, { one: "native-v2" })).toBeNull();
    const wrong = row(); wrong.citations[0].contentHash = "old";
    expect(approvedCatalogTopic(wrong, [observation], catalog, { one: "native-v1" })).toBeNull();
    const foreign = row(); foreign.citations.push({ ...foreign.citations[0], url: "https://foreign.com" });
    expect(approvedCatalogTopic(foreign, [observation], catalog, { one: "native-v1" })).toBeNull();
  });
  it("preserves any/all explicit search without accepting group IDs or mixing old answers", () => {
    const raw = { enabled: true, topics: ["one", "two"], accounts: [{ ...candidate, observations: [observation], catalogFacets: [row()], coverage: { observations: 1, interpreted: 1 } }], hasMore: false, nextCursor: null };
    expect(buildApprovedTopicSearchResult({ ...raw, mode: "any" }, catalog, { one: "native-v1" }).accounts).toHaveLength(1);
    expect(buildApprovedTopicSearchResult({ ...raw, mode: "all" }, catalog, { one: "native-v1" }).accounts).toHaveLength(0);
    expect(() => buildApprovedTopicSearchResult({ ...raw, topics: ["family"] }, catalog, {})).toThrow();
  });
});
