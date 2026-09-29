import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), estimate: vi.fn(), fingerprint: vi.fn(), durable: vi.fn(), native: vi.fn() }));
vi.mock("./jev", () => ({ evaluateResearchRanking: mocks.evaluate, estimateResearchRankingInputTokens: mocks.estimate, researchRankingRequestFingerprint: mocks.fingerprint }));
vi.mock("./jevRequests", () => ({ durableJevRequest: mocks.durable }));
vi.mock("./nativeJev", async original => ({ ...await original<typeof import("./nativeJev")>(), evaluateNativeCached: mocks.native }));
import { rankResearchCandidates, researchRankingInput } from "./researchRanking";
const input = { companyName: "Synthetic Services", companyDomain: "example.test", companyId: "company-id", automaticResearch: true,
  missingTopics: ["project_billing", "multi_location"], candidates: ["https://example.test/about", "https://example.test/locations",
    "https://example.test/services/project-billing", "https://example.test/our-company"] };
beforeEach(() => { vi.clearAllMocks(); mocks.estimate.mockReturnValue(12000); });
describe("free directed source order", () => {
  it.each([false, true])("preserves the whole supplied worklist without ranking or cache calls (catalog=%s)", async catalogOwned => {
    const candidates = Array.from({ length: 30 }, (_, i) => `https://example.test/page-${i}`);
    const result = await rankResearchCandidates({ ...input, catalogOwned, candidates });
    expect(result).toEqual({ candidates, providerUsed: false, scores: [], outcome: "deterministic_order", rankingVersion: "source-discovery-order-v1" });
    expect(result.candidates).not.toBe(candidates);
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3])("does not spend on %s options", async count => {
    const candidates = input.candidates.slice(0, count);
    expect(await rankResearchCandidates({ ...input, candidates })).toMatchObject({ outcome: "not_needed", candidates, providerUsed: false });
    expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
  it("keeps source discovery intact even without research gaps or model configuration", async () => {
    expect(await rankResearchCandidates({ ...input, missingTopics: [] })).toMatchObject({ candidates: input.candidates, outcome: "not_needed" });
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.estimate).not.toHaveBeenCalled();
  });
  it("retains canonical legacy request reconstruction for saved provenance only", () => {
    expect(researchRankingInput({ ...input, candidates: [...input.candidates].reverse(), missingTopics: [...input.missingTopics].reverse() }))
      .toEqual(researchRankingInput(input));
    expect(researchRankingInput({ ...input, missingTopics: [...input.missingTopics, "inventory"] })).not.toEqual(researchRankingInput(input));
    expect(mocks.durable).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("keeps invalid URLs and oversized input out of legacy request reconstruction", () => {
    expect(researchRankingInput({ ...input, missingTopics: ["文".repeat(200)] })).toBeNull();
    expect(researchRankingInput({ ...input, companyName: "x".repeat(601) })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "javascript:alert(1)"] })).toBeNull();
    expect(researchRankingInput({ ...input, candidates: [input.candidates[0], "https://username:password@example.test"] })).toBeNull();
  });
});