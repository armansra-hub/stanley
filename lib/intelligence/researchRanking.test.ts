import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), estimate: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("./jev", () => ({ evaluateEvidence: mocks.evaluate, estimateEvidenceInputTokens: mocks.estimate }));
vi.mock("./budget", () => ({ reserveJev: mocks.reserve, settleJev: mocks.settle }));
import { rankResearchCandidates, researchRankingInput } from "./researchRanking";
const input = { companyName: "Synthetic Services", companyDomain: "example.test", missingTopics: ["project_billing", "multi_location"],
  candidates: ["https://example.test/about", "https://example.test/locations", "https://example.test/services/project-billing"] };
const raw = { type: "noul", noul: .92, confidence: .61 };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
  mocks.estimate.mockReturnValue(12000); mocks.reserve.mockResolvedValue("reservation"); mocks.settle.mockResolvedValue(undefined);
  mocks.evaluate.mockResolvedValue({ ok: true, model: "jev-1.13.0", questionVersion: "stanley-evidence-v2",
    usage: { inputTokens: 2300, outputTokens: 0 }, attributes: { signalType: "none" },
    criteria: { source_1: .2, source_2: .92, source_3: .8 }, metadata: { rawAnswers: { criterion_source_2: raw } } });
});
afterEach(() => vi.unstubAllEnvs());
describe("directed source selection", () => {
  it("ranks supplied URLs once with explicit gaps, preserves native scores, and settles actual usage", async () => {
    const result = await rankResearchCandidates(input);
    expect(result.outcome).toBe("ranked"); expect(result.providerUsed).toBe(true);
    expect(result.candidates).toEqual([input.candidates[1], input.candidates[2], input.candidates[0]]);
    expect(result.scores[1]).toEqual({ url: input.candidates[1], optionId: "source_2", score: .92, rawAnswer: raw });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.evaluate.mock.invocationCallOrder[0]);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ companyName: input.companyName,
      companyContext: expect.stringContaining("project_billing"), privacy: "public", criteria: expect.any(Array) }));
    expect(mocks.settle).toHaveBeenCalledWith("reservation", 2300);
  });
  it("only ranks the first eight options and retains the untouched candidate tail", async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => `https://example.test/source-${i}`);
    mocks.evaluate.mockResolvedValue({ ok: true, model: "jev-1.13.0", questionVersion: "version", usage: null,
      metadata: {}, criteria: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`source_${i + 1}`, i / 10])) });
    const result = await rankResearchCandidates({ ...input, candidates });
    expect(result.candidates).toEqual([...candidates.slice(0, 8).reverse(), ...candidates.slice(8)]);
    expect(mocks.evaluate.mock.calls[0][0].criteria).toHaveLength(8);
    expect(mocks.settle).toHaveBeenCalledWith("reservation", null);
  });
  it("uses stable original order for equal Jev scores without a confidence gate", async () => {
    mocks.evaluate.mockResolvedValue({ ok: true, model: "jev-1.13.0", questionVersion: "version", usage: null,
      metadata: { rawAnswers: { criterion_source_1: { type: "noul", noul: .5, confidence: .01 } } },
      criteria: { source_1: .5, source_2: .5, source_3: .5 } });
    expect((await rankResearchCandidates(input)).candidates).toEqual(input.candidates);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
  });
  it("does not spend when one option or no research gap needs a choice", async () => {
    expect((await rankResearchCandidates({ ...input, candidates: input.candidates.slice(0, 1) })).outcome).toBe("not_needed");
    expect((await rankResearchCandidates({ ...input, missingTopics: [] })).outcome).toBe("not_needed");
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("retains every original candidate on budget depletion, missing configuration, or reservation failure", async () => {
    mocks.reserve.mockResolvedValue(null);
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "budget_deferred", providerUsed: false });
    mocks.reserve.mockRejectedValue(new Error("private database failure"));
    expect((await rankResearchCandidates(input)).outcome).toBe("budget_unavailable");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect((await rankResearchCandidates(input)).outcome).toBe("provider_unconfigured");
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("keeps fallback ordering on provider failure and retains uncertain spend", async () => {
    mocks.evaluate.mockRejectedValue(new Error("provider timeout"));
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "provider_unavailable", providerUsed: true });
    expect(mocks.settle).toHaveBeenCalledWith("reservation", null);
    mocks.evaluate.mockResolvedValue({ ok: false, model: "jev-1.13.0", questionVersion: "version", usage: { inputTokens: 200, outputTokens: null }, error: { kind: "rate_limit" } });
    expect((await rankResearchCandidates(input)).outcome).toBe("rate_limit");
    expect(mocks.settle).toHaveBeenLastCalledWith("reservation", 200);
  });
  it("keeps returned native answers when settlement fails but does not alter source order", async () => {
    mocks.settle.mockRejectedValue(new Error("database unavailable"));
    const result = await rankResearchCandidates(input);
    expect(result.outcome).toBe("settlement_unavailable"); expect(result.candidates).toEqual(input.candidates);
    expect(result.scores[1].rawAnswer).toEqual(raw);
  });
  it("rejects oversized context or unsafe/malformed options before any budget reservation", async () => {
    expect(researchRankingInput({ ...input, missingTopics: ["文".repeat(200)] })).toBeNull();
    expect(researchRankingInput({ ...input, companyName: "x".repeat(601) })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "javascript:alert(1)"] })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "https://username:password@example.test"] })).toBeNull();
    mocks.estimate.mockReturnValue(null);
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "invalid_input" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("does not turn an omitted option score into a negative judgment", async () => {
    mocks.evaluate.mockResolvedValue({ ok: true, model: "jev-1.13.0", questionVersion: "version", usage: null,
      metadata: {}, criteria: { source_1: .5 } });
    expect(await rankResearchCandidates(input)).toMatchObject({ candidates: input.candidates, outcome: "invalid_response" });
  });
});
