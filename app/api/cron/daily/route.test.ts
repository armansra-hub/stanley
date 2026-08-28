import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/db/events", () => ({ logEvent }));

import { GET } from "./route";

describe("daily staged cron", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    logEvent.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  it("completes one independent five-worker stage without recursion", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=0&run=run-12345678", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completed: true, stage: 0, stageCount: 16, children: 5, ok: 5, failed: 0 });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls.every(([target]) => !String(target).includes("/api/cron/daily"))).toBe(true);
    expect(calls.every(([, init]) => (init?.headers as Record<string, string>)["x-cron-secret"] === "test-cron-secret")).toBe(true);
    expect(calls.every(([target]) => !String(target).includes("test-cron-secret"))).toBe(true);
  });

  it("derives the rotating stage and cycle id from the current UTC hour", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(5 * 3_600_000);
    try {
      const response = await GET(new NextRequest("https://stanley.local/api/cron/daily", {
        headers: { "x-cron-secret": "test-cron-secret" },
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stage: 5, runId: "hourly-0", children: 5 });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
    } finally {
      now.mockRestore();
    }
  });

  it("finishes the final stage without another dispatch", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=15&run=run-12345678", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
    expect(logEvent).toHaveBeenCalledWith("headhunter", "daily.done", expect.objectContaining({
      meta: expect.objectContaining({ status: "rotation_complete", total: 80, stageCount: 16 }),
    }));
  });

  it("rejects invalid stages", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=16", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(400);
  });

  it("accepts the separately scoped TAM sweep credential", async () => {
    process.env.TAM_GROWTH_SWEEP_SECRET = "test-tam-sweep-secret";
    try {
      const response = await GET(new NextRequest("https://stanley.local/api/cron/daily", {
        headers: { "x-cron-secret": "test-tam-sweep-secret" },
      }));
      expect(response.status).toBe(200);
    } finally {
      delete process.env.TAM_GROWTH_SWEEP_SECRET;
    }
  });
});
