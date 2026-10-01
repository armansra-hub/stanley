import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { serviceClient } from "@/lib/supabase/server";
import { customerResearchProgress, getCustomerResearchProof, getApprovedCustomerCatalogStatus, loadCustomerResearchProofs, loadCustomerResearchSavedSources, saveCustomerResearchProfile, saveCustomerBusinessScopeProof } from "./customerResearchServer";
import { normalizeCustomerResearchProfile, projectCustomerResearchProfile } from "./customerResearchProfiles";
import { projectCustomerBusinessScopeProof, approvedCustomerCatalogVersion, approvedCustomerCriterionVersion, customerProofHash } from "./customerApprovedCatalog";
import { providerIndustryContextDefinitions } from "./customerIndustryContext";
import { customerResearchTextHash } from "./customerResearchProfiles";
const time = "2026-09-29T12:00:00Z";
const draft = () => normalizeCustomerResearchProfile({ schema: "customer-research-v1", customerId: "customer-1", name: "Example", website: "https://example.com/",
  announcementIds: ["announcement-1"], author: { kind: "codex", name: "Codex", authoredAt: time }, observedAt: time, completedAt: null,
  discovery: { status: "pending", methods: [], pages: [], notes: [] }, sources: [], facts: [], summary: null, sourceGaps: [] });
const row = (customerId = "customer-1") => {
  const profile = projectCustomerResearchProfile({ ...draft(), customerId });
  return { customer_id: customerId, full_profile_sha256: profile.fullProfileSha256, research_status: profile.status, profile, updated_at: time };
};
function database(results: { data: unknown; error?: unknown }[], rpc: {data:unknown;error:unknown} = { data: {}, error: null }) {
  const calls: string[] = [];
  const from = vi.fn((table: string) => {
    calls.push(table);
    const result = results.shift() ?? { data: null, error: "unexpected query" };
    const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(), then: vi.fn() };
    for (const name of ["select", "eq", "order", "limit", "gt"] as const) query[name].mockReturnValue(query);
    query.maybeSingle.mockResolvedValue(result);
    query.then.mockImplementation((resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve));
    return query;
  });
  const db = { from, rpc: vi.fn().mockResolvedValue(rpc) };
  vi.mocked(serviceClient).mockReturnValue(db as unknown as ReturnType<typeof serviceClient>);
  return { db, calls };
}
beforeEach(() => vi.clearAllMocks());
describe("read-only catalog recovery status",()=>{
  function dictionary() {
    const criterion={id:"synthetic-service",label:"Service",familyId:"delivery",sourceProposalKey:"synthetic#service",originalScope:"universal",
      applicability:{scope:"universal" as const},predicate:"Own staff perform continuing service.",evidenceRules:["Own operating evidence."],exclusions:["Client activity is insufficient."],
      positiveExamples:[{scenario:"Our staff perform the service.",explanation:"Own delivery."}],negativeExamples:[{scenario:"Customers perform it.",explanation:"Client activity."}]};
    const value={schema:"customer-approved-catalog-v1" as const,version:"pending",status:"approved" as const,author:{kind:"codex" as const,name:"Codex",authoredAt:time},
      facets:[{...criterion,definitionVersion:approvedCustomerCriterionVersion(criterion)}],
      navigationFamilies:[{id:"delivery",label:"Delivery",selectableCategory:false as const,facetIds:[criterion.id],organizingQuestion:"Who delivers?",nonMergeBoundaries:[]}],
      evidenceFields:[],industryContextDefinitions:providerIndustryContextDefinitions(),proposalAliases:[{sourceProposalKey:criterion.sourceProposalKey,criterionId:criterion.id}],equivalentQuestions:[],sourceManifest:[],
      cohortProof:{cohortCount:1,accountedForCount:1,customers:[{customerId:"synthetic-1",profileSha256:"a".repeat(64),proofSha256:"b".repeat(64)}]}};
    value.version=approvedCustomerCatalogVersion(value);return value;
  }
  it("hashes the exact registered dictionary and reads paid/selection flags without mutation",async()=>{
    const catalog=dictionary();const {db,calls}=database([{data:{selected_catalog_version:catalog.version,enabled:true}},{data:{enabled:false,updated_at:time}}],{data:catalog,error:null});
    expect(await getApprovedCustomerCatalogStatus(catalog.version)).toMatchObject({version:catalog.version,dictionarySha256:customerProofHash(catalog),registered:true,selected:true,
      selectedVersion:catalog.version,paidEnabled:false,processingEnabled:true,criteria:1,industryContexts:35,cohortCount:1,manifestCount:1,providerCalls:0,readOnly:true});
    expect(calls).toEqual(["intelligence_config","intelligence_jev_budget_policy"]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("intelligence_catalog_dictionary_get",{p_version:catalog.version});
  });
  it("reports absent registration separately from a corrupt selected pointer",async()=>{
    const version=dictionary().version;
    database([{data:{selected_catalog_version:null,enabled:true}},{data:{enabled:false}}],{data:null as unknown,error:null});
    expect(await getApprovedCustomerCatalogStatus(version)).toMatchObject({requestedVersion:version,version:null,registered:false,selectedVersion:null,dictionarySha256:null});
    database([{data:{selected_catalog_version:version,enabled:true}},{data:{enabled:false}}],{data:null as unknown,error:null});
    await expect(getApprovedCustomerCatalogStatus()).rejects.toMatchObject({code:"customer_catalog_selection_invalid"});
  });
  it("does not imply paused when the policy read is unavailable or malformed",async()=>{
    const {db}=database([{data:{selected_catalog_version:null,enabled:true}},{data:{enabled:null}}]);
    await expect(getApprovedCustomerCatalogStatus()).rejects.toMatchObject({code:"customer_catalog_status_unavailable"});expect(db.rpc).not.toHaveBeenCalled();
    await expect(getApprovedCustomerCatalogStatus("v1")).rejects.toMatchObject({status:400});
  });
});
describe("customer research storage boundary", () => {
  it("admits a locally validated finite-scope proof without rewriting raw status, with exact compact readback", async()=>{
    const input=JSON.stringify({...draft(),sourceGaps:["Identity remains unresolved."]}),hash=customerResearchTextHash(input);
    const proof=projectCustomerBusinessScopeProof({profileJson:input,profileSha256:hash,validatedAt:time,
      businessScope:{status:"identity_or_source_gap",acceptedScope:"Exact company identification attempted; unresolved.",closedAt:time,receipt:{file:"scope.json",sha256:"a".repeat(64)},profileSha256:hash,wholeSiteStatus:"draft",wholeSiteDiscoveryStatus:"pending"},
      mapping:{customerId:"customer-1",profileSha256:hash,scopeStatus:"identity_or_source_gap",matches:[]},bindings:[]});
    const stored={customer_id:proof.customerId,full_profile_sha256:hash,research_status:proof.status,profile:proof,updated_at:time};
    const {db}=database([{data:{id:"customer-1",name:"Example",announcements:[{id:"announcement-1"}],updated_at:time}},{data:stored}]);
    expect(await saveCustomerBusinessScopeProof(proof)).toMatchObject({saved:true,status:"draft",businessScope:"identity_or_source_gap",proofSha256:proof.proofSha256,providerCalls:0});
    expect(db.rpc).toHaveBeenCalledWith("intelligence_customer_research_scope_put",{p_profile:proof,p_expected_proof_hash:null,p_registry_updated_at:time});
  });
  it("keeps unresolved accounting separate from completed research and refuses an ambiguous old summary", async () => {
    const progress = { total: 3, started: 2, notStarted: 1, draft: 0, inProgress: 0, complete: 1, completeWithGaps: 0, unresolved: 1,
      facts: 2, readPages: 3, pendingPages: 0, unreadPages: 0, unavailablePages: 0, latestUpdatedAt: time, origin: "codex_research", providerCalls: 0 };
    database([], { data: progress, error: null });
    expect(await customerResearchProgress()).toEqual(progress);
    const { unresolved: _unresolved, ...old } = progress; void _unresolved;
    database([], { data: old, error: null });
    await expect(customerResearchProgress()).rejects.toMatchObject({ code: "customer_research_progress_invalid" });
  });
  it("pages every compact profile with no total-cohort cap", async () => {
    const first = Array.from({ length: 101 }, (_, i) => row(`customer-${String(i).padStart(3, "0")}`));
    const { db } = database([{ data: first }, { data: [first[100]] }]);
    const proofs = await loadCustomerResearchProofs();
    expect(proofs).toHaveLength(101); expect(db.from).toHaveBeenCalledTimes(2);
    expect(proofs.every(proof => proof.sourceStorage === "private_local_full_text")).toBe(true);
  });
  it("validates identity and saves only the compact projection with exact readback", async () => {
    const stored = row(), { db, calls } = database([{ data: { id: "customer-1", name: "Example", announcements: [{ id: "announcement-1" }], active: true, updated_at: time } }, { data: stored }]);
    const receipt = await saveCustomerResearchProfile(draft());
    expect(receipt).toMatchObject({ saved: true, providerCalls: 0, fullProfileSha256: stored.full_profile_sha256, status: "draft" });
    expect(db.rpc).toHaveBeenCalledWith("intelligence_customer_research_put", { p_profile: stored.profile, p_expected_hash: null, p_registry_updated_at: time });
    expect(calls).toEqual(["intelligence_customer_reference_registry", "intelligence_customer_research_profiles"]);
  });
  it("rejects a stale/missing announcement before any storage mutation", async () => {
    const { db } = database([{ data: { id: "customer-1", name: "Example", announcements: [{ id: "new-announcement" }], updated_at: time } }]);
    await expect(saveCustomerResearchProfile(draft())).rejects.toMatchObject({ code: "customer_registry_identity_changed", status: 409 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects corrupt citations before even looking up the registry", async () => {
    const { db } = database([]);
    await expect(saveCustomerResearchProfile({ ...draft(), nativeResult: {} })).rejects.toMatchObject({ status: 400 });
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("reports uncertain readback without retrying the write", async () => {
    const { db } = database([{ data: { id: "customer-1", name: "Example", announcements: [{ id: "announcement-1" }], updated_at: time } }, { data: null }]);
    await expect(saveCustomerResearchProfile(draft())).rejects.toMatchObject({ code: "customer_research_readback_uncertain" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("does not return malformed or full-body cloud storage as a valid compact proof", async () => {
    const stored = row(); Object.assign(stored.profile, { customerId: "different" });
    database([{ data: stored }]);
    await expect(getCustomerResearchProof("customer-1")).rejects.toMatchObject({ code: "customer_research_proof_invalid" });
  });
});
describe("already-collected source reuse", () => {
  const captured = { id: "source-1", url: "https://example.com/services", title: "Services", text: "The full saved source text.", contentHash: "wrong-hash", observedAt: time };
  const registry = () => ({ id: "customer-1", name: "Example", website: "https://example.com/", announcements: [{ id: "announcement-1" }], updated_at: time,
    sources: [captured], source_checkpoint: { sources: [{ ...captured, id: "source-2", text: "Second full saved text." }], secret: "never export arbitrary checkpoint keys",
      attempts: { "https://example.com/": { outcome: "success", at: time } }, queue: [{ url: "https://example.com/" }], sourceGaps: [] } });
  it("exports exact complete text without interpreting, paying, or marking it read", async () => {
    const { db } = database([{ data: registry() }]);
    const result = await loadCustomerResearchSavedSources({ customerId: "customer-1", limit: 1 });
    expect(result.sources[0]).toMatchObject({ text: captured.text, integrity: "hash_mismatch", origin: "registry" });
    expect(result).toMatchObject({ providerCalls: 0, researchStatusChanged: false, totalSources: 2, nextOffset: 1 });
    expect(result.checkpoint).not.toHaveProperty("secret"); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("requires an unchanged registry checkpoint on later source pages", async () => {
    database([{ data: registry() }]);
    await expect(loadCustomerResearchSavedSources({ customerId: "customer-1", offset: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(loadCustomerResearchSavedSources({ customerId: "customer-1", offset: 1, registryUpdatedAt: "2025-01-01" })).rejects.toMatchObject({ code: "customer_sources_changed", status: 409 });
  });
  it("reports invalid source records explicitly instead of silently presenting full coverage", async () => {
    const value = registry(); value.sources.push({ ...captured, id: "source-private", url: "https://user:password@example.com/" });
    database([{ data: value }]);
    const result = await loadCustomerResearchSavedSources({ customerId: "customer-1" });
    expect(result.unexportedSources).toBe(1); expect(JSON.stringify(result)).not.toContain("password");
  });
});
