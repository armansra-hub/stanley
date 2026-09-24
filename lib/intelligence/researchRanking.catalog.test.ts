import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativeJev", async original => ({ ...await original<typeof import("./nativeJev")>(), evaluateNativeCached: mocked.native }));
import { catalogResearchRankingInput, rankResearchCandidates } from "./researchRanking";
import { nativeJevBody, nativeJevFingerprint } from "./nativeJev";
import { OPERATING_FACETS, operatingCatalogSemanticContext } from "./operatingCatalog";

const input = { companyName: "Synthetic Services", companyDomain: "synthetic.test", companyId: "company", automaticResearch: true,
  catalogOwned: true, catalogFacetIds: OPERATING_FACETS.map(facet => facet.id), missingTopics: ["Unresolved public operating predicates"],
  candidates: Array.from({ length: 12 }, (_, i) => `https://synthetic.test/source-${i}`) };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key"); });
afterEach(() => vi.unstubAllEnvs());

describe("catalog research ranking with complete semantic context", () => {
  it("supplies every unresolved definition and boundary plus all industry guidance within the actual request cap", () => {
    const plan = catalogResearchRankingInput(input)!; const state = plan.input.state as any;
    expect(state.guidance).toEqual(operatingCatalogSemanticContext());
    expect(state.guidance.industries).toHaveLength(35);
    expect(state.unresolvedPredicates).toHaveLength(47);
    for (const facet of OPERATING_FACETS) expect(state.unresolvedPredicates.find((entry: any) => entry.id === facet.id))
      .toMatchObject({ definition: facet.definition, boundary: facet.boundary, kind: facet.kind });
    expect(plan.options).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(nativeJevBody(plan.input)))).toBeLessThanOrEqual(48000);
  });
  it("packs long options without removing any semantic guidance and keeps unknown IDs out of paid requests", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => `https://synthetic.test/${i}/` + "x".repeat(2000));
    const plan = catalogResearchRankingInput({ ...input, candidates })!;
    expect(plan).not.toBeNull(); expect(plan.options.length).toBeGreaterThanOrEqual(4);
    expect((plan.input.state as any).unresolvedPredicates).toHaveLength(47);
    expect((plan.input.state as any).guidance.industries).toHaveLength(35);
    expect(Buffer.byteLength(JSON.stringify(nativeJevBody(plan.input)))).toBeLessThanOrEqual(48000);
    expect(catalogResearchRankingInput({ ...input, catalogFacetIds: ["rr_o06"] })).toBeNull();
  });
  it("reuses the same native ranking contract for reordered identical gaps and source options", () => {
    const first = { ...input, candidates: input.candidates.slice(0, 8) };
    const second = { ...first, candidates: [...first.candidates].reverse(), catalogFacetIds: [...first.catalogFacetIds].reverse() };
    expect(nativeJevFingerprint(catalogResearchRankingInput(first)!.input))
      .toBe(nativeJevFingerprint(catalogResearchRankingInput(second)!.input));
  });
  it("makes one scoped native request, preserves native answers and keeps every unranked candidate", async () => {
    const answers: Record<string, any> = {};
    mocked.native.mockImplementation(async (request: any) => {
      Object.keys(request.questions).forEach((id, index) => { answers[id] = { type: "noul", noul: index / 10, confidence: .25 }; });
      return { status: "complete", reused: true, evaluation: { ok: true, usage: { inputTokens: 123, outputTokens: 0 },
        provider_result: { model: "jev-1.13.0", answers } } };
    });
    const result = await rankResearchCandidates(input);
    expect(result).toMatchObject({ outcome: "ranked", providerUsed: false, reused: true });
    expect(mocked.native).toHaveBeenCalledOnce();
    expect(mocked.native).toHaveBeenCalledWith(expect.any(Object), { purpose: "research_ranking", companyId: "company",
      sourceKind: "catalog_research_options", workload: "monitoring" });
    expect(new Set(result.candidates)).toEqual(new Set(input.candidates));
    expect(result.candidates.slice(8)).toEqual(input.candidates.slice(8));
    expect(result.scores[0].rawAnswer).toBe(answers.source_1);
  });
  it("retains the complete research worklist on a budget hold", async () => {
    mocked.native.mockResolvedValue({ status: "budget_deferred", reason: "daily_allowance", retryAt: "2026-09-25T07:00:00Z" });
    expect(await rankResearchCandidates(input)).toMatchObject({ outcome: "budget_deferred", candidates: input.candidates, providerUsed: false });
  });
});
