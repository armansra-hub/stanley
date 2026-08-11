import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/db/events", () => ({ logEvent }));

import { GET } from "./route";

describe("daily cron terminal receipt", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "test-cron-secret";
    logEvent.mockClear();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  it("emits daily.done even when children exceed the parent observation window", async () => {
    const responsePromise = GET(new NextRequest("https://stanley.local/api/cron/daily", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    await vi.advanceTimersByTimeAsync(50_000);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(logEvent).toHaveBeenCalledWith("headhunter", "daily.done", expect.objectContaining({
      meta: expect.objectContaining({ status: "deadline", total: 52 }),
    }));
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(52);
    expect(calls.every(([target]) => !String(target).includes("test-cron-secret"))).toBe(true);
    expect(calls.every(([, init]) => (init?.headers as Record<string, string>)?.["x-cron-secret"] === "test-cron-secret")).toBe(true);
  });
});
