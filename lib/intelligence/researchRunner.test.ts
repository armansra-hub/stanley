import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), rank: vi.fn(), fetch: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }),
  withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("./researchRanking", () => ({ rankResearchCandidates: mocks.rank }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: mocks.enqueue }));
vi.mock("./sourceState", () => ({ readSourceState: vi.fn() }));
vi.mock("./atsLifecycle", () => ({ readAtsHiringContext: vi.fn() }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/publicPdf", () => ({ fetchPublicPdfEvidence: vi.fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
vi.mock("./researchExternal", () => ({ discoverExternalResearch: async () => ({sources:0}) }));
import { refreshAccountResearch, type ResearchProfile } from "./researchRunner";

const candidates = ["https://example.com/about", "https://example.com/team", "https://example.com/services", "https://example.com/billing"];
const profile = { company: { id: "company", name: "Synthetic Consulting", domain: "example.com" },
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

  it.each([
    ['<meta property="article:published_time" content="2026-09-17">', "2026-09-17T00:00:00.000Z", "page_publication"],
    ['<meta property="article:published_time" content="2026-09-17"><meta name="datePublished" content="2026-09-18">', null, "unknown"],
    ["", null, "unknown"],
  ])("uses the ordinary website date contract for identical deep-page evidence", async (dates, eventDate, basis) => {
    mocks.rank.mockResolvedValue({ candidates, providerUsed: false, scores: [], outcome: "ranked", rankingVersion: "current" });
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_research_claim"
      ? [{ source_url: candidates[0], lease_token: "lease" }] : true, error: null }));
    mocks.fetch.mockResolvedValue({ status: 200, finalUrl: candidates[0], body: `${dates}<main>The company delivers project services.</main>` });
    mocks.enqueue.mockResolvedValue({ id: "observation", queued: false });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(result).toMatchObject({ sources: 1, outcomes: ["unchanged"] });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ title: "Synthetic Consulting company website", eventDate,
      metadata: expect.objectContaining({ eventDateBasis: basis,
        researchCriteria: expect.arrayContaining(["project_delivery", "multi_entity", "multi_location", "project_billing"]) }) }));
  });
});
