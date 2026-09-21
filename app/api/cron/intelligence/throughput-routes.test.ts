import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  worker: vi.fn(), research: vi.fn(), stories: vi.fn(), review: vi.fn(), log: vi.fn(),
  enabled: vi.fn(), config: vi.fn(), base: vi.fn(), websites: vi.fn(), ats: vi.fn(), shared: vi.fn(),
  after: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(),
  after: (callback: () => Promise<void>) => mocks.after.push(callback),
}));
vi.mock("@/lib/intelligence/worker", () => ({ runIntelligenceWorker: mocks.worker }));
vi.mock("@/lib/intelligence/researchRunner", () => ({ runDirectedResearchWorker: mocks.research }));
vi.mock("@/lib/intelligence/narratives", () => ({ runAccountStoryWorker: mocks.stories }));
vi.mock("@/lib/triggers/candidateReview", () => ({ reviewPendingCandidates: mocks.review }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.log }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: mocks.config }) }) }) }) }));
vi.mock("@/lib/triggers/sweep", () => ({ sweepBase: mocks.base }));
vi.mock("@/lib/triggers/websiteSweep", () => ({ sweepWebsites: mocks.websites }));
vi.mock("@/lib/triggers/atsSweep", () => ({ sweepAts: mocks.ats }));
vi.mock("@/lib/intelligence/sharedSources", () => ({ runSharedSources: mocks.shared }));

import { GET as processing } from "./route";
import { GET as collection } from "../intelligence-collect/route";
import { GET as research } from "../intelligence-research/route";
import { GET as shared } from "../intelligence-sources/route";

const request = () => new Request("https://stanley.test/api/cron/intelligence", { headers: { "x-cron-secret": "test-secret" } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.after.length = 0;
  vi.stubEnv("CRON_SECRET", "test-secret");
  mocks.enabled.mockReturnValue(true);
  mocks.config.mockResolvedValue({ data: { enabled: true }, error: null });
  mocks.worker.mockResolvedValue({ enabled: true, processed: 300, outcomes: { complete: 300 }, mode: "drain", stoppedBy: "deadline" });
  mocks.research.mockResolvedValue({ enabled: true, processed: 20, outcomes: { refreshed: 20 }, mode: "drain", stoppedBy: "deadline" });
  mocks.stories.mockResolvedValue({ processed: 0 }); mocks.review.mockResolvedValue({ reviewed: 0 });
  mocks.shared.mockResolvedValue({ claimed: 1, fetched: 1, observations: 2, failed: 0 });
  mocks.log.mockResolvedValue(undefined);
});

describe("scheduled intelligence throughput", () => {
  it("uses remaining runtime at every scheduled interpretation entry point", async () => {
    const start = Date.now();
    expect((await processing(request())).status).toBe(200);
    expect(mocks.worker).toHaveBeenLastCalledWith({ mode: "drain", concurrency: 6 }, expect.any(Number));
    expect(mocks.worker.mock.calls[0][1]).toBeGreaterThanOrEqual(start + 280000);
    expect(mocks.stories).toHaveBeenCalledWith(2, expect.any(Number));
    expect(mocks.review).toHaveBeenCalledWith(8, expect.any(Object));
    for (const route of [collection, shared]) {
      expect((await route(request())).status).toBe(200);
      await mocks.after.pop()!();
      expect(mocks.worker).toHaveBeenLastCalledWith({ mode: "drain", concurrency: 6 }, expect.any(Number));
    }
    expect(mocks.worker).toHaveBeenCalledTimes(3);
  });
  it("runs independent story/review work alongside interpretation and preserves its receipt on auxiliary failure", async () => {
    let finish!: (value: object) => void;
    mocks.worker.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mocks.stories.mockRejectedValue(new Error("writer unavailable"));
    mocks.review.mockRejectedValue(new Error("review unavailable"));
    const pending = processing(request());
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    finish({ enabled: true, processed: 250, stoppedBy: "deadline" });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 250, stories: { error: "story_worker_unavailable" }, review: { error: "legacy_review_unavailable" } });
    expect(mocks.log).toHaveBeenCalledWith("headhunter", "intelligence.processed", expect.objectContaining({ meta: expect.objectContaining({ processed: 250 }) }));
  });
  it("keeps disabled processing and auxiliaries disabled", async () => {
    mocks.config.mockResolvedValue({ data: { enabled: false }, error: null });
    expect(await (await processing(request())).json()).toMatchObject({ enabled: false, processed: 0 });
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.stories).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });
  it("runs two-account research until its runtime boundary rather than stopping after eight", async () => {
    const start = Date.now();
    expect(await (await research(request())).json()).toMatchObject({ processed: 20 });
    expect(mocks.research).toHaveBeenCalledWith({ mode: "drain", concurrency: 2 }, expect.any(Number));
    expect(mocks.research.mock.calls[0][1]).toBeGreaterThanOrEqual(start + 280000);
  });
  it("rejects unauthorized requests before any source or model worker", async () => {
    for (const route of [processing, collection, research, shared]) expect((await route(new Request("https://stanley.test"))).status).toBe(401);
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.research).not.toHaveBeenCalled(); expect(mocks.base).not.toHaveBeenCalled();
  });
});
