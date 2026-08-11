import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  recompute: vi.fn<(id: string) => Promise<number>>(),
  reserve: vi.fn(),
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/triggers", () => ({
  recomputePriority: mocks.recompute,
  reservePriorityRecompute: mocks.reserve,
  utcDailyRotationEpoch: () => "2026-08-10T00:00:00.000Z",
}));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.logEvent }));

import { GET, POST } from "./route";

const priorSecret = process.env.CRON_SECRET;

describe("priority recompute rotation", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    mocks.recompute.mockReset();
    mocks.reserve.mockReset();
    mocks.logEvent.mockClear();
    mocks.recompute.mockResolvedValue(12);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  it("reserves zombie capacity and attempts the whole micro-batch before the timebox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    const rows = Array.from({ length: 10 }, (_, index) => ({
      company_id: `company-${index}`,
      reservation_kind: index < 2 ? "zombie" : "ghost",
    }));
    mocks.reserve.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    mocks.recompute.mockImplementation(async (id: string) => {
      if (id === "company-0") vi.setSystemTime(new Date("2026-08-10T12:00:51.000Z"));
      if (id === "company-1") throw new Error("isolated failure");
      return id === "company-2" ? 0 : 12;
    });

    const response = await GET(new NextRequest("https://stanley.local/api/cron/recompute?limit=20", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledWith(10, 2, "2026-08-10T00:00:00.000Z");
    expect(mocks.recompute).toHaveBeenCalledTimes(10);
    expect(body).toMatchObject({
      mode: "rotation",
      checked: 10,
      failed: 1,
      dropped: 1,
      kept: 8,
      ghosts_reserved: 8,
      zombies_reserved: 2,
    });
  });

  it("keeps explicit IDs manual, deduplicated, and outside the reservation cursor", async () => {
    const response = await POST(new NextRequest("https://stanley.local/api/cron/recompute?limit=10", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": "test-cron-secret",
      },
      body: JSON.stringify({ ids: ["a", "a", "b"] }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.recompute.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(body).toMatchObject({ mode: "explicit", checked: 2, of: 2 });
  });

  it("fails closed when the cron secret is absent", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(new NextRequest("https://stanley.local/api/cron/recompute"));
    expect(response.status).toBe(401);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
