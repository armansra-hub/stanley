import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
const tasks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("@/lib/db/events", () => ({ logEvent }));
vi.mock("@/lib/cron/scheduleAfter", () => ({ scheduleAfter: (task: () => Promise<void>) => tasks.push(task) }));

import { GET } from "./route";

describe("daily staged cron", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    tasks.length = 0;
    logEvent.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (target: string | URL) => new Response(null, {
      status: String(target).includes("/api/cron/daily?") ? 202 : 200,
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  it("accepts immediately and chains the next five-worker stage", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, stage: 0, stageCount: 13, children: 5 });
    expect(tasks).toHaveLength(1);

    await tasks[0]();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).every(([target]) => !String(target).includes("/api/cron/daily?"))).toBe(true);
    expect(String(calls[5][0])).toContain("stage=1");
    expect(calls.every(([, init]) => (init?.headers as Record<string, string>)["x-cron-secret"] === "test-cron-secret")).toBe(true);
    expect(calls.every(([target]) => !String(target).includes("test-cron-secret"))).toBe(true);
  });

  it("finishes the final stage without another dispatch", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=12&run=run-12345678", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(202);
    await tasks[0]();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
    expect(logEvent).toHaveBeenCalledWith("headhunter", "daily.done", expect.objectContaining({
      meta: expect.objectContaining({ status: "complete", total: 65, stageCount: 13 }),
    }));
  });

  it("rejects invalid stages", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=13", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(400);
    expect(tasks).toHaveLength(0);
  });

  it("accepts the separately scoped TAM sweep credential", async () => {
    process.env.TAM_GROWTH_SWEEP_SECRET = "test-tam-sweep-secret";
    try {
      const response = await GET(new NextRequest("https://stanley.local/api/cron/daily", {
        headers: { "x-cron-secret": "test-tam-sweep-secret" },
      }));
      expect(response.status).toBe(202);
      expect(tasks).toHaveLength(1);
    } finally {
      delete process.env.TAM_GROWTH_SWEEP_SECRET;
    }
  });
});
