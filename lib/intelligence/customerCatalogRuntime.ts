import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { JEV_MODEL } from "./jev";
import type { NativeQuestion } from "./nativeJev";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, operatingFacetQuestion, operatingCatalogSemanticContext,
  catalogResearchQueries } from "./operatingCatalog";
import { buildCustomerCharacteristicQuestion, customerCharacteristicVersion, type CustomerCharacteristicDefinition } from "./customerResearchProfiles";
export { providerIndustryContextDefinitions } from "./customerIndustryContext";

export type RuntimeFacet = { id: string; label: string; definition: string; boundary: string; definitionHash: string;
  role?: "criterion" | "industry_context"; industryId?: string };
export type RuntimeCatalog = {
  version: string; kind: "legacy" | "customer"; facets: readonly RuntimeFacet[];
  question: (id: string) => NativeQuestion;
  wireId: (id: string) => string;
  facetVersion: (facet: RuntimeFacet) => string;
  semanticContext: (ids?: readonly string[]) => unknown;
  researchQueries: (ids: readonly string[]) => string[];
};
export type CustomerCatalogSnapshot = {
  version: string; status: "approved";
  facets: (Omit<CustomerCharacteristicDefinition, "customerSupport"> & { customerSupport?: CustomerCharacteristicDefinition["customerSupport"]; researchQueries?: string[] })[];
  [key: string]: unknown;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const legacyContext = operatingCatalogSemanticContext();
// Preserve existing paid semantic versions byte for byte.
export const legacyRuntimeCatalog: RuntimeCatalog = {
  version: OPERATING_CATALOG_VERSION, kind: "legacy", facets: OPERATING_FACETS,
  question: id => { const q = operatingFacetQuestion(id); if (!q) throw new Error("catalog_public_question_missing"); return q; },
  wireId: id => { if (!OPERATING_FACETS.some(f => f.id === id)) throw new Error("unknown_catalog_facet"); return id; },
  facetVersion: facet => hash(["account-operating-coverage-v2", JEV_MODEL, operatingFacetQuestion(facet.id), legacyContext, facet.definitionHash]),
  semanticContext: () => legacyContext,
  researchQueries: catalogResearchQueries,
};

/** A dictionary's descriptive fields/navigation families are never questions.
 * Every positive criterion is retained; an unknown industry is not an exclusion.
 * Display/support changes and unrelated criteria do not enter a facet version. */
export function customerRuntimeCatalog(input: unknown): RuntimeCatalog {
  if (!object(input) || input.status !== "approved" || typeof input.version !== "string" || !input.version.length
    || input.version.length > 120 || !Array.isArray(input.facets) || !input.facets.length) throw new Error("invalid_approved_catalog");
  const questions = new Map<string, NativeQuestion>(), versions = new Map<string, string>(), wires = new Map<string, string>();
  const queries = new Map<string, string[]>();
  const context = { policy: "Evaluate every requested criterion from source-backed evidence about the target. Industry applicability is part of each rule. An uncertain or mixed industry does not justify omitting a requested criterion. Preserve identity, ownership, counterparties, dates and unknowns. No TAM grading or inferred financial pain." };
  const facets: RuntimeFacet[] = input.facets.map(raw => {
    if (!object(raw)) throw new Error("invalid_catalog_criterion");
    const definition = { id: raw.id, label: raw.label, definitionVersion: raw.definitionVersion,
      applicability: raw.applicability, predicate: raw.predicate, evidenceRules: raw.evidenceRules, exclusions: raw.exclusions,
      positiveExamples: Array.isArray(raw.positiveExamples) ? raw.positiveExamples.map(e => object(e) ? { scenario: e.scenario, explanation: e.explanation, kind: "illustrative" } : e) : raw.positiveExamples,
      negativeExamples: Array.isArray(raw.negativeExamples) ? raw.negativeExamples.map(e => object(e) ? { scenario: e.scenario, explanation: e.explanation, kind: "illustrative" } : e) : raw.negativeExamples,
      customerSupport: [] } as unknown as CustomerCharacteristicDefinition;
    // The schema/version function validates every substantive rule field.
    const definitionVersion = customerCharacteristicVersion(definition);
    if (definition.definitionVersion !== definitionVersion || questions.has(definition.id)) throw new Error("invalid_catalog_criterion_version");
    const q = buildCustomerCharacteristicQuestion(definition);
    questions.set(definition.id, q);
    wires.set(definition.id, "cf_" + hash(definition.id).slice(0, 60));
    versions.set(definition.id, hash(["customer-catalog-native-v1", JEV_MODEL, definitionVersion, q, context]));
    const terms = raw.researchQueries;
    if (terms !== undefined && (!Array.isArray(terms) || terms.some(t => typeof t !== "string" || !t.trim()))) throw new Error("invalid_catalog_research_queries");
    queries.set(definition.id, (terms as string[] | undefined) ?? []);
    return { id: definition.id, label: definition.label, definition: definition.predicate,
      boundary: definition.exclusions.join(" "), definitionHash: definitionVersion, role: "criterion" as const };
  }).sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (input.industryContextDefinitions !== undefined && !Array.isArray(input.industryContextDefinitions)) throw new Error("invalid_industry_context");
  for (const raw of (input.industryContextDefinitions ?? []) as unknown[]) {
    if (!object(raw) || typeof raw.id !== "string" || !/^G[0-9]{2}$/.test(raw.id) || typeof raw.label !== "string"
      || typeof raw.predicate !== "string" || !Array.isArray(raw.evidenceRules) || !Array.isArray(raw.exclusions)
      || [...raw.evidenceRules, ...raw.exclusions].some(v => typeof v !== "string")) throw new Error("invalid_industry_context");
    const id = "industry_context_" + raw.id;
    if (questions.has(id)) throw new Error("duplicate_industry_context");
    const q: NativeQuestion = { type: "choice", instructions: JSON.stringify({ predicate: raw.predicate,
      evidenceRules: raw.evidenceRules, exclusions: raw.exclusions, policy: context.policy }), criteria: {
      supported: "Source evidence establishes this industry as the provider's own operating business.",
      not_supported: "Explicit source evidence contradicts this provider-industry predicate.",
      unknown: "Evidence is missing, ambiguous, incomplete or concerns a customer/partner rather than this provider.",
      conflicting: "Unresolved source evidence supports and contradicts this provider-industry predicate.",
    } };
    const definitionHash = hash(["provider-industry-context-v1", raw.id, q]);
    questions.set(id, q);wires.set(id, id);versions.set(id, hash(["customer-catalog-native-v1", JEV_MODEL, definitionHash, q, context]));
    queries.set(id, []);
    facets.push({ id, label: raw.label, definition: raw.predicate, boundary: raw.exclusions.join(" "), definitionHash,
      role: "industry_context", industryId: raw.id });
  }
  if (new Set(wires.values()).size !== wires.size) throw new Error("catalog_wire_id_collision");
  const requireId = <T>(map: Map<string, T>, id: string): T => { if (!map.has(id)) throw new Error("unknown_catalog_facet:" + id); return map.get(id)!; };
  return { version: input.version, kind: "customer", facets,
    question: id => requireId(questions, id), wireId: id => requireId(wires, id),
    facetVersion: facet => requireId(versions, facet.id), semanticContext: () => context,
    researchQueries: ids => [...new Set(ids.flatMap(id => requireId(queries, id)))],
  };
}

/** Resolve the lease's immutable version, never the current selection midflight. */
export async function loadRuntimeCatalog(version: string, db = serviceClient()): Promise<RuntimeCatalog | null> {
  if (version === OPERATING_CATALOG_VERSION) return legacyRuntimeCatalog;
  const result = await db.rpc("intelligence_catalog_dictionary_get", { p_version: version });
  if (result.error) throw new Error("catalog_dictionary_unavailable");
  if (!result.data) return null;
  const catalog = customerRuntimeCatalog(result.data);
  if (catalog.version !== version) throw new Error("catalog_dictionary_version_mismatch");
  return catalog;
}
/** Read-only selection: a null pointer does not activate the legacy or new lane. */
export async function loadSelectedCatalog(db = serviceClient()): Promise<RuntimeCatalog | null> {
  const result = await db.rpc("intelligence_catalog_dictionary_get", { p_version: null });
  if (result.error) throw new Error("catalog_dictionary_unavailable");
  return result.data ? customerRuntimeCatalog(result.data) : null;
}
export function runtimeFacetVersions(catalog: RuntimeCatalog): Record<string, string> {
  return Object.fromEntries(catalog.facets.map(f => [f.id, catalog.facetVersion(f)]));
}
export function runtimeFacetRegistration(catalog: RuntimeCatalog) {
  return catalog.facets.map(f => ({ facetId: f.id, facetVersion: catalog.facetVersion(f), wireId: catalog.wireId(f.id), kind: f.role ?? "criterion" }));
}
