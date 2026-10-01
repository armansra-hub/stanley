import { z } from "zod";
import { catalogSha256 } from "./operatingCatalogHash";
import { customerCharacteristicVersion, customerResearchFactSchema, customerResearchCoverage,
  normalizeCustomerResearchProfile } from "./customerResearchProfiles";

/** Public code, private data. The generator writes outside the repository. A
 * field observation is not a positive criterion assignment. */
const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,160}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const at = z.string().datetime({ offset: true });
const states = z.enum(["supported", "not_supported", "unknown", "conflicting"]);
const author = z.object({ kind: z.literal("codex"), name: text, authoredAt: at }).strict();
const reference = z.object({ file: text, sha256: hash, pointer: text.optional() }).strict();
const example = z.object({ scenario: text, explanation: text }).strict();
export const approvedCustomerCriterionSchema = z.object({
  id, label: text, definitionVersion: text, familyId: id, sourceProposalKey: text,
  applicability: z.discriminatedUnion("scope", [z.object({ scope: z.literal("universal") }).strict(),
    z.object({ scope: z.literal("industry"), industryIds: z.array(id).min(1) }).strict()]),
  originalScope: text, predicate: text, evidenceRules: z.array(text).min(1), exclusions: z.array(text).min(1),
  positiveExamples: z.array(example).min(1), negativeExamples: z.array(example).min(1),
}).strict();
export type ApprovedCustomerCriterion = z.infer<typeof approvedCustomerCriterionSchema>;
const record = z.record(z.string(), z.unknown());
export const approvedCustomerCatalogSchema = z.object({
  schema: z.literal("customer-approved-catalog-v1"), version: text, status: z.literal("approved"), author,
  facets: z.array(approvedCustomerCriterionSchema).min(1),
  navigationFamilies: z.array(z.object({ id, label: text, selectableCategory: z.literal(false), facetIds: z.array(id),
    organizingQuestion: text, nonMergeBoundaries: z.array(text) }).strict()),
  evidenceFields: z.array(record),
  industryContextDefinitions: z.array(z.object({ id, label:text, predicate:text, evidenceRules:z.array(text).min(1), exclusions:z.array(text).min(1) }).strict()).length(35),
  proposalAliases: z.array(z.object({ sourceProposalKey: text, criterionId: id }).strict()),
  equivalentQuestions: z.array(z.object({ criterionIds: z.array(id).min(2), normalizedSemanticSha256: hash,
    reason: text }).strict()),
  sourceManifest: z.array(reference), cohortProof: record,
}).strict();
export type ApprovedCustomerCatalog = z.infer<typeof approvedCustomerCatalogSchema>;

export function canonicalCustomerJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCustomerJson).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonicalCustomerJson(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
export const customerProofHash = (value: unknown) => catalogSha256(canonicalCustomerJson(value));
export function approvedCustomerCriterionVersion(value: Omit<ApprovedCustomerCriterion, "definitionVersion"> | ApprovedCustomerCriterion) {
  return customerCharacteristicVersion({ id: value.id, label: value.label, applicability: value.applicability,
    predicate: value.predicate, evidenceRules: value.evidenceRules, exclusions: value.exclusions,
    positiveExamples: value.positiveExamples.map(example => ({ ...example, kind: "illustrative" as const })),
    negativeExamples: value.negativeExamples.map(example => ({ ...example, kind: "illustrative" as const })),
    customerSupport: [],
  } as Parameters<typeof customerCharacteristicVersion>[0]);
}
function assert(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`invalid_customer_catalog:${reason}`); }
export function normalizeApprovedCustomerCatalog(input: unknown): ApprovedCustomerCatalog {
  const value = approvedCustomerCatalogSchema.parse(input);
  assert(new Set(value.facets.map(x => x.id)).size === value.facets.length, "duplicate_criterion");
  assert(new Set(value.proposalAliases.map(x => x.sourceProposalKey)).size === value.proposalAliases.length, "duplicate_alias");
  assert(value.proposalAliases.length === value.facets.length, "alias_coverage");
  for (const facet of value.facets) {
    assert(facet.definitionVersion === approvedCustomerCriterionVersion(facet), `definition_version:${facet.id}`);
    assert(value.navigationFamilies.some(f => f.id === facet.familyId), `family:${facet.id}`);
    assert(value.proposalAliases.some(a => a.sourceProposalKey === facet.sourceProposalKey && a.criterionId === facet.id), `alias:${facet.id}`);
  }
  // Reuse across aliases is deliberately off until exact semantic equivalence
  // has its own reviewed contract. Similar labels are not an equivalence proof.
  assert(value.equivalentQuestions.length === 0, "equivalence_not_registered");
  const expected = approvedCustomerCatalogVersion(value);
  assert(value.version === expected, "catalog_version");
  return value;
}
/** Snapshot identity binds the private cohort revision. Individual criterion
 * versions above remain independent of that revision for paid answer reuse. */
export function approvedCustomerCatalogVersion(value: Pick<ApprovedCustomerCatalog,"facets"|"cohortProof"> & Partial<Pick<ApprovedCustomerCatalog,"industryContextDefinitions">>): string {
  return "customer-catalog-v1-" + customerProofHash({ criteria: value.facets.map(f => ({ id:f.id,definitionVersion:f.definitionVersion })).sort((a,b)=>a.id.localeCompare(b.id,"en")), cohortProof:value.cohortProof, industryContextDefinitions:value.industryContextDefinitions??[] });
}

export const customerCriterionBindingSchema = z.object({
  criterionId: id, definitionVersion: text, customerId: id, profileSha256: hash, state: states,
  factIds: z.array(id), offeringScope: text, whyMatches: text, authoredAt: at, author: z.literal("codex"),
  source: z.enum(["explicit_authored_predicate", "proposal_anchor"]),
}).strict();
export type CustomerCriterionBinding = z.infer<typeof customerCriterionBindingSchema>;
const sourceManifestSchema = z.object({ id, url: text, resolvedUrl: text, title: text,
  kind: z.enum(["company_website", "linkedin", "public_source"]), observedAt: at, textSha256: hash,
  readAt: at.nullable(), capture: z.literal("full_observed_text"), textCharacters: z.number().int().nonnegative() }).strict();
const enrichedCitation = z.object({ sourceId: id, textSha256: hash, start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: text, role: z.enum(["supporting", "contradicting", "context"]), url: text, resolvedUrl: text, title: text, observedAt: at, readAt: at.nullable() }).strict();
const rawStatus = z.enum(["draft", "in_progress", "complete", "complete_with_gaps", "unresolved"]);
const fact = customerResearchFactSchema.extend({ author, origin: z.literal("codex_research"), customerId: id,
  researchStatus: rawStatus, citations: z.array(enrichedCitation) }).strict();
export const customerBusinessScopeProofSchema = z.object({
  schema: z.literal("customer-research-proof-v2"), customerId: id, name: text, website: text.nullable(), announcementIds: z.array(text),
  author, observedAt: at, completedAt: at.nullable(), status: rawStatus, summary: text.nullable(), sourceGaps: z.array(text),
  sourceStorage: z.literal("private_local_full_text"), fullProfileSha256: hash, normalizedProfileSha256: hash,
  coverage: z.object({ discovered: z.number().int().nonnegative(), captured: z.number().int().nonnegative(), read: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(), unread: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(), discoveryComplete: z.boolean() }).strict(),
  sources: z.array(sourceManifestSchema), facts: z.array(fact),
  businessScope: z.object({ status: z.enum(["scope_complete", "scope_complete_with_gaps", "identity_or_source_gap"]),
    acceptedScope: text, closedAt: at, receipt: reference, profileSha256: hash,
    wholeSiteStatus: rawStatus, wholeSiteDiscoveryStatus: z.enum(["pending", "in_progress", "complete"]),
  }).strict(),
  mapping: record, criterionBindings: z.array(customerCriterionBindingSchema),
  validation: z.object({ kind: z.literal("local_full_text_hash_and_utf16_validation"), validatedAt: at, sourceManifestSha256: hash }).strict(),
  proofSha256: hash,
}).strict();
export type CustomerBusinessScopeProof = z.infer<typeof customerBusinessScopeProofSchema>;

/** Server validation checks the admitted compact projection. It does not claim
 * to have re-read the private full text; that exact check ran in the generator. */
export function normalizeCustomerBusinessScopeProof(input: unknown): CustomerBusinessScopeProof {
  const value = customerBusinessScopeProofSchema.parse(input), { proofSha256, ...payload } = value;
  assert(customerProofHash(payload) === proofSha256, "proof_hash");
  assert(value.businessScope.profileSha256 === value.fullProfileSha256 && value.businessScope.wholeSiteStatus === value.status, "scope_profile");
  assert(value.validation.sourceManifestSha256 === customerProofHash(value.sources), "manifest_hash");
  assert(value.mapping.customerId === value.customerId && value.mapping.profileSha256 === value.fullProfileSha256, "mapping_profile");
  const originalScopeNames:Record<string,string>={business_scope_review_closed:"scope_complete",business_scope_review_closed_with_source_gaps:"scope_complete_with_gaps",identity_unresolved:"identity_or_source_gap",identity_or_source_unresolved:"identity_or_source_gap"};
  assert((originalScopeNames[String(value.mapping.scopeStatus)]??value.mapping.scopeStatus) === value.businessScope.status, "mapping_scope");
  const sources = new Map(value.sources.map(s => [s.id, s])), facts = new Map(value.facts.map(f => [f.id, f]));
  assert(sources.size === value.sources.length && facts.size === value.facts.length, "duplicate_source_or_fact");
  for (const f of value.facts) {
    assert(f.customerId === value.customerId && f.researchStatus === value.status, `fact_profile:${f.id}`);
    const supports = f.citations.some(c => c.role === "supporting"), contradicts = f.citations.some(c => c.role === "contradicting");
    assert(f.state === "supported" ? supports && !contradicts : f.state === "not_supported" ? contradicts && !supports
      : f.state === "conflicting" ? supports && (contradicts || new Set(f.citations.filter(c=>c.role==="supporting").map(c=>`${c.sourceId}:${c.start}:${c.end}`)).size>=2) : !supports && !contradicts, `decision:${f.id}`);
    for (const c of f.citations) {
      const s = sources.get(c.sourceId);
      assert(s?.readAt && c.textSha256 === s.textSha256 && c.url === s.url && c.resolvedUrl === s.resolvedUrl
        && c.start < c.end && c.end <= s.textCharacters && c.quote.length === c.end - c.start, `citation:${f.id}`);
    }
  }
  const keys = new Set<string>();
  for (const b of value.criterionBindings) {
    const key = `${b.criterionId}:${b.offeringScope}`;
    assert(!keys.has(key), `duplicate_binding:${key}`); keys.add(key);
    assert(b.customerId === value.customerId && b.profileSha256 === value.fullProfileSha256, `binding_profile:${b.criterionId}`);
    assert(b.factIds.every(id => facts.has(id)), `binding_fact:${b.criterionId}`);
    if (b.state === "supported") assert(value.businessScope.status !== "identity_or_source_gap" && Array.isArray(value.mapping.matches) && value.mapping.matches.length && b.factIds.length
      && b.factIds.every(id => facts.get(id)?.state === "supported" && facts.get(id)?.subject.kind === "customer"), `binding_positive:${b.criterionId}`);
    if (b.state === "not_supported") assert(b.factIds.some(id => facts.get(id)?.state === "not_supported"), `binding_negative:${b.criterionId}`);
    if (b.state === "conflicting") assert(b.factIds.some(id => facts.get(id)?.state === "conflicting")
      || b.factIds.some(id => facts.get(id)?.state === "supported") && b.factIds.some(id => facts.get(id)?.state === "not_supported"), `binding_conflict:${b.criterionId}`);
  }
  return value;
}

/** The local generator validates full captured text and UTF-16 citation offsets
 * mechanically, reusing prior authored reads. It never changes raw completion. */
export function projectCustomerBusinessScopeProof(input: {
  profileJson: string; profileSha256: string; businessScope: CustomerBusinessScopeProof["businessScope"];
  mapping: Record<string, unknown>; bindings: CustomerCriterionBinding[]; validatedAt: string;
}): CustomerBusinessScopeProof {
  assert(catalogSha256(input.profileJson) === input.profileSha256, "original_profile_hash");
  const profile = normalizeCustomerResearchProfile(JSON.parse(input.profileJson),{preserveAuthoredConflictCitationRoles:true});
  const sources = profile.sources.map(({text:body,...manifest})=>({...manifest,textCharacters:body.length}));
  const sourceById=new Map(profile.sources.map(s=>[s.id,s]));
  const facts=profile.facts.map(f=>({...f,author:profile.author,origin:"codex_research" as const,customerId:profile.customerId,researchStatus:profile.status,
    citations:f.citations.map(c=>{const s=sourceById.get(c.sourceId)!;return {...c,url:s.url,resolvedUrl:s.resolvedUrl,title:s.title,observedAt:s.observedAt,readAt:s.readAt};})}));
  const payload = { schema: "customer-research-proof-v2" as const, customerId: profile.customerId, name: profile.name,
    website: profile.website, announcementIds: profile.announcementIds, author: profile.author, observedAt: profile.observedAt,
    completedAt: profile.completedAt, status: profile.status, summary: profile.summary, sourceGaps: profile.sourceGaps,
    sourceStorage: "private_local_full_text" as const, fullProfileSha256: input.profileSha256, normalizedProfileSha256: customerProofHash(profile),
    coverage: customerResearchCoverage(profile), sources, facts, businessScope: input.businessScope,
    mapping: input.mapping, criterionBindings: input.bindings,
    validation: { kind: "local_full_text_hash_and_utf16_validation" as const, validatedAt: input.validatedAt, sourceManifestSha256: customerProofHash(sources) } };
  return normalizeCustomerBusinessScopeProof({ ...payload, proofSha256: customerProofHash(payload) });
}
