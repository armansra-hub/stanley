import { describe, expect, it, vi } from "vitest";
import { catalogFixture } from "../../test/customerCatalogFixture";
import { customerRuntimeCatalog, loadRuntimeCatalog, runtimeFacetRegistration } from "./customerCatalogRuntime";
import { catalogAnswerPlans, catalogNativeResult, catalogPackets } from "./operatingCoverage";
import { nativeJevBody } from "./nativeJev";

describe("immutable customer runtime catalog", () => {
  it("uses safe wire IDs while retaining all criteria and context, never families or descriptive fields", () => {
    const catalog = customerRuntimeCatalog(catalogFixture());
    expect(catalog.facets.filter(f => f.role === "criterion")).toHaveLength(2);
    expect(catalog.facets.filter(f => f.role === "industry_context")).toHaveLength(35);
    expect(() => catalog.question("navigation-family")).toThrow("unknown_catalog_facet");
    expect(() => catalog.question("description-field")).toThrow("unknown_catalog_facet");
    expect(runtimeFacetRegistration(catalog).every(f => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.wireId))).toBe(true);
    const packets = catalogPackets([{ id: "source", content_hash: "hash", source_url: "https://example.com", title: "Business",
      source_kind: "website", event_date: null, observed_at: "2026-09-30", evidence_text: "Source evidence about the target." }]);
    const { plans, blocked } = catalogAnswerPlans({ name: "Target", subindustry: null }, catalog.facets, packets, undefined, [], catalog);
    expect(blocked).toEqual([]);
    expect(plans.flatMap(p => p.facetIds)).toEqual(catalog.facets.map(f => f.id));
    expect(plans.some(p => p.facetIds.some(id => id.startsWith("industry_context_")) && p.facetIds.some(id => !id.startsWith("industry_context_")))).toBe(true);
    for (const plan of plans) expect(() => nativeJevBody(plan.input)).not.toThrow();
  });
  it("reuses actual semantics across snapshot, support, label and unrelated-rule changes", () => {
    const old = customerRuntimeCatalog(catalogFixture());
    const input = catalogFixture("approved-fixture-two", true);
    input.facets[0].label = "Updated display label";
    const newer = customerRuntimeCatalog({ ...input, cohortProof: { changedSupport: true } });
    const first = old.facets.find(f => f.id === "policy-owned-fleet")!;
    const second = old.facets.find(f => f.id === "inventory-project-service")!;
    expect(newer.facetVersion(first)).toBe(old.facetVersion(first));
    expect(newer.wireId(first.id)).toBe(old.wireId(first.id));
    expect(newer.facetVersion(second)).not.toBe(old.facetVersion(second));
    expect(newer.facetVersion(old.facets.at(-1)!)).toBe(old.facetVersion(old.facets.at(-1)!));
  });
  it("rejects stale semantic hashes and preserves the native unknown payload exactly", () => {
    const input = catalogFixture(); input.facets[0].predicate = "Different rule";
    expect(() => customerRuntimeCatalog(input)).toThrow("invalid_catalog_criterion_version");
    const catalog = customerRuntimeCatalog(catalogFixture()), facet = catalog.facets[0];
    const answer = { type: "choice" as const, choice: "unknown", opaque: { retained: true } };
    const stored = catalogNativeResult(facet, answer, [], "native", "fingerprint", "receipt", catalog);
    expect(stored.decision).toBe("insufficient_evidence");
    expect(stored.nativeResult).toMatchObject({ questionId: facet.id, wireQuestionId: catalog.wireId(facet.id) });
    expect((stored.nativeResult as any).answer).toBe(answer);
  });
  it("loads the exact leased version without consulting the selected pointer", async () => {
    const fixture = catalogFixture(), rpc = vi.fn().mockResolvedValue({ data: fixture, error: null });
    const catalog = await loadRuntimeCatalog(fixture.version, { rpc } as any);
    expect(catalog?.version).toBe(fixture.version);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("intelligence_catalog_dictionary_get", { p_version: fixture.version });
    rpc.mockResolvedValue({ data: { ...fixture, version: "different-current-version" }, error: null });
    await expect(loadRuntimeCatalog(fixture.version, { rpc } as any)).rejects.toThrow("catalog_dictionary_version_mismatch");
  });
});
