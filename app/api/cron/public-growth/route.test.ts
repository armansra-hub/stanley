import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  usaspending: vi.fn(),
  subawards: vi.fn(),
  sam: vi.fn(),
  opportunities: vi.fn(),
  revenue: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/lib/publicGrowth/sweepState", () => {
  class PublicGrowthSweepBusyError extends Error {
    constructor(public readonly source: string, public readonly retryAt: string | null) {
      super(`busy ${source}`);
      this.name = "PublicGrowthSweepBusyError";
    }
  }
  class PublicGrowthSweepLeaseLostError extends Error {
    constructor(public readonly source: string) {
      super(`lost ${source}`);
      this.name = "PublicGrowthSweepLeaseLostError";
    }
  }
  return {
    beginPublicGrowthSweep: mocks.begin,
    completePublicGrowthSweep: mocks.complete,
    failPublicGrowthSweep: mocks.fail,
    PublicGrowthSweepBusyError,
    PublicGrowthSweepLeaseLostError,
  };
});
vi.mock("@/lib/publicGrowth/usaspendingSweep", () => ({
  sweepUsaspendingTamBatch: mocks.usaspending,
  sweepUsaspendingSubawardsTamBatch: mocks.subawards,
}));
vi.mock("@/lib/publicGrowth/samSweep", () => ({ sweepSamTamBatch: mocks.sam }));
vi.mock("@/lib/publicGrowth/opportunitySweep", () => ({ sweepSamOpportunities: mocks.opportunities }));
vi.mock("@/lib/publicGrowth/revenueSweep", () => ({ sweepRevenueTamBatch: mocks.revenue }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.logEvent }));

import { PublicGrowthSweepBusyError } from "@/lib/publicGrowth/sweepState";
import { GET } from "./route";

const lease = {
  source: "usaspending",
  offset: 0,
  batchSize: 10,
  managed: true,
  cursor: { offset: 0 },
  token: "11111111-1111-4111-8111-111111111111",
  leaseUntil: "2026-08-11T00:06:00.000Z",
};

describe("public-growth managed sweep route", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.begin.mockResolvedValue(lease);
    mocks.complete.mockResolvedValue(10);
    mocks.fail.mockResolvedValue(true);
    mocks.usaspending.mockResolvedValue({
      source: "usaspending",
      offset: 0,
      checked: 10,
      nextOffset: 10,
      done: false,
      matched: 2,
      triggers: 1,
      receipts: [],
    });
    mocks.logEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  const request = (query: string) => new NextRequest(
    `https://stanley.local/api/cron/public-growth?${query}`,
    { headers: { "x-cron-secret": "test-cron-secret" } },
  );

  it("returns a distinct conflict without starting work when the source is busy", async () => {
    mocks.begin.mockRejectedValue(new PublicGrowthSweepBusyError("usaspending", "2099-08-11T00:06:00.000Z"));
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: "source_busy",
      source: "usaspending",
      retryAt: "2099-08-11T00:06:00.000Z",
    }));
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(mocks.usaspending).not.toHaveBeenCalled();
  });

  it("fails closed when lease acquisition itself fails", async () => {
    mocks.begin.mockRejectedValue(new Error("RPC unavailable"));
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "lease_acquire_failed" }));
    expect(mocks.usaspending).not.toHaveBeenCalled();
  });

  it("runs the verified recurring set and completes before returning success", async () => {
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith("usaspending", 10, null);
    expect(mocks.usaspending).toHaveBeenCalledWith(10, 0, { scope: "verified" });
    expect(mocks.complete).toHaveBeenCalledWith(lease, expect.objectContaining({ checked: 10 }));
    expect(await response.json()).toEqual(expect.objectContaining({ nextCursor: 10 }));
  });

  it("keeps full-TAM scans explicit and recovery-only", async () => {
    const response = await GET(request("source=usaspending&scope=tam&n=10"));
    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.usaspending).not.toHaveBeenCalled();
  });
});
