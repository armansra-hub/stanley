import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), estimate: vi.fn(), fingerprint: vi.fn(), durable: vi.fn() }));
vi.mock("./jev", () => ({ evaluateResearchRanking: mocks.evaluate, estimateResearchRankingInputTokens: mocks.estimate, researchRankingRequestFingerprint: mocks.fingerprint }));
vi.mock("./jevRequests", () => ({ durableJevRequest: mocks.durable }));
import { rankResearchCandidates, researchRankingInput } from "./researchRanking";
const input = { companyName: "Synthetic Services", companyDomain: "example.test", companyId: "company-id", automaticResearch: true,
  missingTopics: ["project_billing", "multi_location"], candidates: ["https://example.test/about", "https://example.test/locations",
    "https://example.test/services/project-billing", "https://example.test/our-company"] };
const raw = { type: "noul", noul: .92, confidence: .61 };
const evaluation = () => ({ ok: true, model: "jev-1.13.0", questionVersion: "stanley-research-ranking-v1",
  usage: { inputTokens: 2300, outputTokens: 0 }, criteria: { source_1: .2, source_2: .92, source_3: .8, source_4: .1 },
  metadata: { rawAnswers: { criterion_source_2: raw } } });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
  mocks.estimate.mockReturnValue(12000); mocks.fingerprint.mockReturnValue("exact-request-hash");
  mocks.evaluate.mockResolvedValue(evaluation());
  mocks.durable.mockImplementation(async ({ execute }) => ({ status: "complete", evaluation: await execute(), reused: false }));
});
afterEach(() => vi.unstubAllEnvs());
describe("directed source selection", () => {
  it("ranks supplied URLs using the dedicated pack and durable exact-request receipt", async () => {
    const result = await rankResearchCandidates(input);
    expect(result).toMatchObject({ outcome: "ranked", providerUsed: true, reused: false });
    expect(result.candidates).toEqual([input.candidates[1], input.candidates[2], input.candidates[0], input.candidates[3]]);
    expect(result.scores[1]).toEqual({ url: input.candidates[1], optionId: "source_2", score: .92, rawAnswer: raw });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ companyName: input.companyName,
      companyContext: expect.stringContaining("project_billing"), privacy: "public", criteria: expect.any(Array) }));
    expect(mocks.durable).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: "exact-request-hash",
      context: { purpose: "research_ranking", companyId: "company-id", sourceKind: "discovered_research_options", workload: "monitoring" } }));
  });
  it("reuses an identical saved ranking without another provider request or changed native answer", async () => {
    mocks.durable.mockResolvedValue({ status: "complete", evaluation: evaluation(), reused: true });
    const result = await rankResearchCandidates(input);
    expect(result).toMatchObject({ outcome: "ranked", providerUsed: false, reused: true });
    expect(result.scores[1].rawAnswer).toEqual(raw);
    expect(result.candidates[0]).toBe(input.candidates[1]);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("only ranks the first eight options and retains the untouched candidate tail", async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => `https://example.test/source-${i}`);
    mocks.evaluate.mockResolvedValue({ ok: true, model: "jev-1.13.0", questionVersion: "version", usage: null,
      metadata: {}, criteria: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`source_${i + 1}`, i / 10])) });
    const result = await rankResearchCandidates({ ...input, candidates });
    expect(result.candidates).toEqual([...candidates.slice(0, 8).reverse(), ...candidates.slice(8)]);
    expect(mocks.evaluate.mock.calls[0][0].criteria).toHaveLength(8);
  });
  it("uses stable original order for equal native scores without a confidence gate", async () => {
    mocks.evaluate.mockResolvedValue({ ...evaluation(), criteria: { source_1: .5, source_2: .5, source_3: .5, source_4: .5 } });
    expect((await rankResearchCandidates(input)).candidates).toEqual(input.candidates);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
  });
  it.each([0, 1, 2, 3])("does not spend on %s options because they all fit the concurrent read batch", async count => {
    const candidates = input.candidates.slice(0, count);
    expect(await rankResearchCandidates({ ...input, candidates })).toMatchObject({ outcome: "not_needed", candidates });
    expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("does not spend when no research gap needs a choice", async () => {
    expect((await rankResearchCandidates({ ...input, missingTopics: [] })).outcome).toBe("not_needed");
    expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each(["budget_deferred", "busy"])("retains every candidate on %s", async status => {
    mocks.durable.mockResolvedValue({ status });
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: status, providerUsed: false });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("does not dispatch on a storage failure or missing provider configuration", async () => {
    mocks.durable.mockRejectedValue(new Error("private database failure"));
    expect((await rankResearchCandidates(input)).outcome).toBe("request_persistence_unavailable");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect((await rankResearchCandidates(input)).outcome).toBe("provider_unconfigured");
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("keeps fallback ordering and usage on a native provider failure", async () => {
    mocks.evaluate.mockResolvedValue({ ok: false, model: "jev-1.13.0", questionVersion: "version", usage: { inputTokens: 200, outputTokens: null }, error: { kind: "rate_limit" } });
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "rate_limit", providerUsed: true,
      usage: { inputTokens: 200, outputTokens: null } });
  });
  it("rejects oversized context or unsafe options before claiming any paid request", async () => {
    expect(researchRankingInput({ ...input, missingTopics: ["文".repeat(200)] })).toBeNull();
    expect(researchRankingInput({ ...input, companyName: "x".repeat(601) })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "javascript:alert(1)"] })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "https://username:password@example.test"] })).toBeNull();
    mocks.estimate.mockReturnValue(null);
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "invalid_input" });
    expect(mocks.durable).not.toHaveBeenCalled();
  });
  it("does not turn an omitted option score into a negative judgment", async () => {
    mocks.evaluate.mockResolvedValue({ ...evaluation(), criteria: { source_1: .5 } });
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "invalid_response" });
  });
});
