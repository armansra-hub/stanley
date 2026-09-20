import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), rank: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }),
  withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("./researchRanking", () => ({ rankResearchCandidates: mocks.rank }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: vi.fn() }));
vi.mock("./sourceState", () => ({ readSourceState: vi.fn() }));
vi.mock("./atsLifecycle", () => ({ readAtsHiringContext: vi.fn() }));
vi.mock("@/lib/triggers/urlSafety", () => ({ fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/publicPdf", () => ({ fetchPublicPdfEvidence: vi.fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
import { refreshAccountResearch, type ResearchProfile } from "./researchRunner";

const candidates = ["https://example.test/about", "https://example.test/team", "https://example.test/services", "https://example.test/billing"];
const profile = { company: { id: "company", name: "Synthetic Consulting", domain: "example.test" },
  missingTopics: ["project_billing"], candidates, candidateTitles: {}, researchFocus: "Investigate explicit project billing processes.",
  nextAttemptAt: "2026-09-20T00:00:00Z" } as unknown as ResearchProfile;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});

describe("concurrent next-source research", () => {
  it("defers a duplicate refresh until its active native ranking is ready, then claims in the cached order", async () => {
    mocks.rank.mockResolvedValueOnce({ candidates, providerUsed: false, scores: [], outcome: "busy", rankingVersion: "current" });
    const started = Date.now();
    const waiting = await refreshAccountResearch("company", { deadlineMs: started + 90_000, automatic: true, profile });
    expect(waiting).toMatchObject({ sources: 0, outcome: "ranking_pending", remainingSources: candidates.length,
      ranking: { outcome: "busy" } });
    expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThanOrEqual(started + 60_000);
    expect(Date.parse(waiting.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();

    const ranked = [candidates[3], candidates[2], candidates[0], candidates[1]];
    mocks.rank.mockResolvedValueOnce({ candidates: ranked, providerUsed: false, reused: true, scores: [], outcome: "ranked", rankingVersion: "current" });
    const resumed = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(resumed.outcome).toBe("sources_leased");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: "company", p_urls: ranked });
    expect(mocks.rank).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "company", automaticResearch: true }));
  });

  it.each(["provider_unavailable", "budget_deferred"])("preserves existing source coverage fallback on %s", async outcome => {
    mocks.rank.mockResolvedValue({ candidates, providerUsed: false, scores: [], outcome, rankingVersion: "current" });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(result.outcome).toBe("sources_leased");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: "company", p_urls: candidates });
  });
});
