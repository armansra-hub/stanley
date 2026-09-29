import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/triggers/talSweep", () => ({ sweepTalNews: mocks.sweep }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.log }));
import { GET, maxDuration } from "./route";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  mocks.sweep.mockReset(); mocks.log.mockReset();
  mocks.log.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new NextRequest("https://stanley.local/api/cron/tal-news", { headers: { "x-cron-secret": "test-cron-secret" } });

describe("TAL news scheduled route", () => {
  it("provides the source budget headroom and reports an incomplete bounded pass honestly", async () => {
    expect(maxDuration).toBe(300);
    const result = { checked: 20, attempted: 20, eligible: 60, remaining: 40,
      succeeded: 15, partial: 3, unavailable: 1, failed: 1, alerted: 2, complete: false };
    mocks.sweep.mockResolvedValue(result);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.log).toHaveBeenCalledWith("headhunter", "tal.news_sweep", expect.objectContaining({ meta: result }));
  });

  it("returns a safe failure receipt when loading/checkpointing is unavailable", async () => {
    mocks.sweep.mockRejectedValue(new Error("private provider response"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "tal_news_sweep_unavailable", complete: false });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private provider response");
  });

  it("rejects an unauthenticated request without dispatching", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/tal-news"));
    expect(response.status).toBe(401);
    expect(mocks.sweep).not.toHaveBeenCalled();
  });
});
