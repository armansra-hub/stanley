import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { normalizeApprovedCustomerCatalog, normalizeCustomerBusinessScopeProof, type CustomerBusinessScopeProof } from "./customerApprovedCatalog";
import { customerRuntimeCatalog, runtimeFacetVersions } from "./customerCatalogRuntime";
import { OPERATING_INDUSTRY_GUIDES } from "./operatingCatalog";
import { criterionCustomerExamples, matchCustomerCriteria, projectCustomerCriteriaCatalog, type CustomerCriteriaCandidate } from "./customerCriteria";
import { approvedCatalogTopic, type TopicSearchAccountRow } from "./topicSearch";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const proofCache = new Map<string, CustomerBusinessScopeProof>();
/** Every selected cohort row is read, including honest identity gaps. A missing
 * or stale import fails as unavailable; it never becomes a zero denominator. */
export async function loadApprovedCustomerCriteria(db = serviceClient()) {
  const selected = await db.rpc("intelligence_catalog_dictionary_get", { p_version: null });
  if (selected.error) throw new Error("customer_criteria_unavailable");
  if (!selected.data) return null;
  const catalog = normalizeApprovedCustomerCatalog(selected.data);
  const manifest = catalog.cohortProof.customers;
  if (!Array.isArray(manifest) || !manifest.length || manifest.some(r => !object(r) || typeof r.customerId !== "string"
    || typeof r.profileSha256 !== "string" || typeof r.proofSha256 !== "string")) throw new Error("customer_criteria_manifest_unavailable");
  const expected = new Map(manifest.map(r => [(r as Record<string, string>).customerId, r as Record<string, string>]));
  if (expected.size !== manifest.length) throw new Error("customer_criteria_manifest_duplicate");
  const proofs: CustomerBusinessScopeProof[] = [], missing: string[] = [];
  let after: string | null = null;
  for (;;) {
    // Recheck the compact current identities on every read. Full proofs are
    // immutable cached objects, loaded only when that exact identity is absent.
    let query = db.from("intelligence_customer_research_profiles").select("customer_id,full_profile_sha256,proof_sha256:profile->>proofSha256").order("customer_id").limit(1000);
    if (after) query = query.gt("customer_id", after);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error("customer_criteria_proofs_unavailable");
    for (const row of data) {
      const item = expected.get(row.customer_id);
      if (!item) continue;
      if (item.profileSha256 !== row.full_profile_sha256 || item.proofSha256 !== row.proof_sha256)
        throw new Error("customer_criteria_proof_changed");
      const cached = proofCache.get(row.customer_id);
      if (cached?.proofSha256 === item.proofSha256) proofs.push(cached);
      else missing.push(row.customer_id);
    }
    if (data.length < 1000) break;
    after = data[data.length - 1].customer_id;
  }
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
  const loaded = await Promise.all(batches.map(async ids => {
    const { data, error } = await db.from("intelligence_customer_research_profiles").select("customer_id,full_profile_sha256,profile").in("customer_id", ids);
    if (error || !Array.isArray(data) || data.length !== ids.length) throw new Error("customer_criteria_proofs_unavailable");
    return data.map(row => {
      const item = expected.get(row.customer_id)!, proof = normalizeCustomerBusinessScopeProof(row.profile);
      if (proof.customerId !== row.customer_id || proof.fullProfileSha256 !== item.profileSha256 || proof.proofSha256 !== item.proofSha256
        || row.full_profile_sha256 !== item.profileSha256) throw new Error("customer_criteria_proof_identity");
      proofCache.set(proof.customerId, proof); return proof;
    });
  }));
  proofs.push(...loaded.flat());
  if (proofs.length !== expected.size) throw new Error("customer_criteria_cohort_incomplete");
  return { catalog, proofs, runtime: customerRuntimeCatalog(catalog) };
}
const JEV_BUDGET_POLICY_ID = "jev-rollout-2026-09-24";
export async function loadCustomerCriteriaProcessing(db = serviceClient()) {
  const [config, paid] = await Promise.all([
    db.from("intelligence_config").select("enabled").eq("id", 1).single(),
    db.from("intelligence_jev_budget_policy").select("enabled").eq("id", JEV_BUDGET_POLICY_ID).single(),
  ]);
  if (config.error || paid.error || typeof config.data?.enabled !== "boolean" || typeof paid.data?.enabled !== "boolean") return "unavailable" as const;
  return config.data.enabled && paid.data.enabled ? "enabled" as const : "paused" as const;
}
export async function loadCustomerCriteriaCatalog() {
  const db = serviceClient(), bundle = await loadApprovedCustomerCriteria(db);
  if (!bundle) return { available: false as const, reason: "not_selected" as const };
  const processing = await loadCustomerCriteriaProcessing(db);
  return projectCustomerCriteriaCatalog(bundle.catalog, bundle.proofs, OPERATING_INDUSTRY_GUIDES.map(g => ({ id: g.id, label: g.label })), processing);
}
export async function loadCustomerCriterionExamples(input: { version: string; criterion: string; industry: string; page: number }) {
  const bundle = await loadApprovedCustomerCriteria();
  if (!bundle || bundle.catalog.version !== input.version) throw new Error("customer_criteria_version_changed");
  const criterion = bundle.catalog.facets.find(f => f.id === input.criterion);
  if (!criterion) throw new Error("invalid_customer_criteria_selection");
  const rows = criterionCustomerExamples(criterion, bundle.proofs, input.industry), offset = (input.page - 1) * 10;
  return { version: input.version, criterion, industry: input.industry, page: input.page, total: rows.length,
    hasMore: offset + 10 < rows.length, examples: rows.slice(offset, offset + 10) };
}
export async function loadCustomerCriteriaMatches(input: { version: string; criterion: string; industry: string; page: number; showHidden: boolean }) {
  const db = serviceClient(), bundle = await loadApprovedCustomerCriteria(db);
  if (!bundle || bundle.catalog.version !== input.version) throw new Error("customer_criteria_version_changed");
  const versions = runtimeFacetVersions(bundle.runtime);
  const snapshot = await db.rpc("intelligence_customer_match_candidates", { p_catalog_version: bundle.runtime.version,
    p_facet_versions: versions, p_show_hidden: input.showHidden });
  if (snapshot.error || !Array.isArray(snapshot.data?.accounts)) throw new Error("customer_criteria_matches_unavailable");
  const candidates: CustomerCriteriaCandidate[] = snapshot.data.accounts.map((row: CustomerCriteriaCandidate) => ({ ...row,
    industryIds: Array.isArray(row.industryIds) ? row.industryIds : null }));
  const result = matchCustomerCriteria({ ...input, catalog: bundle.catalog, proofs: bundle.proofs, candidates });
  if (!result.accounts.length) return result;
  const hydrated = await db.rpc("intelligence_customer_match_evidence", { p_catalog_version: bundle.runtime.version, p_facet_versions: versions,
    p_selection: result.accounts.map(a => ({ companyId: a.companyId, facets: a.sharedCriteria.map(c => c.id) })) });
  if (hydrated.error || !Array.isArray(hydrated.data)) throw new Error("customer_criteria_evidence_unavailable");
  const evidence = new Map((hydrated.data as TopicSearchAccountRow[]).map(row => [row.companyId, row]));
  result.accounts = result.accounts.flatMap(account => {
    const row = evidence.get(account.companyId);
    if (!row) return [];
    const topics = (row.catalogFacets ?? []).flatMap(facet => {
      const topic = approvedCatalogTopic(facet, row.observations, bundle.catalog, versions); return topic ? [topic] : [];
    });
    // Source changes between the compact read and hydration never survive as fit tags.
    if (account.sharedCriteria.some(c => !topics.some(t => t.id === c.id))) return [];
    return [{ ...account, topics }];
  });
  return result;
}
