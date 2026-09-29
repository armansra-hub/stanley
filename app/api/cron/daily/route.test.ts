import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logEvent = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock("@/lib/db/events", () => ({ logEvent }));

import { GET } from "./route";

describe("daily staged cron", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    logEvent.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ checked: 6, errors: 0 })));
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

  it("does not claim rotation completion when only the final stage was observed", async () => {
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=15&run=run-12345678", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    expect(response.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
    expect(logEvent).toHaveBeenCalledWith("headhunter", "daily.rotation_reached_end", expect.objectContaining({
      meta: expect.objectContaining({ status: "completeness_unverified", total: 80, stageCount: 16, coverageVerified: false }),
    }));
    expect(logEvent.mock.calls.some(([, kind]) => kind === "daily.done")).toBe(false);
  });

  it("preserves source failures, pending work and counts instead of treating HTTP 200 as success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ checked: 6, errors: 6, errorDetails: "private provider detail" }))
      .mockResolvedValueOnce(Response.json({ checked: 25, deferred: 4, promoted: 2 }))
      .mockResolvedValueOnce(Response.json({ checked: 6, errors: 0, historiesIncomplete: 1, retryRemaining: 1 }))
      .mockResolvedValueOnce(Response.json({ checked: 200, news_triggers: 3 }))
      .mockResolvedValueOnce(Response.json({ checked: 6, errors: 0 }));
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=0", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    const receipt = await response.json();
    expect(receipt).toMatchObject({ children: 5, httpOk: 5, ok: 1, failed: 1, partial: 2, unverified: 1, coverageVerified: false });
    expect(receipt.results[0]).toMatchObject({ status: 200, outcome: "failed", counts: { checked: 6, errors: 6 } });
    expect(receipt.results[2]).toMatchObject({ outcome: "partial", counts: { historiesIncomplete: 1, retryRemaining: 1 } });
    expect(receipt.results[3]).toMatchObject({ outcome: "unverified", counts: { checked: 200, news_triggers: 3 } });
    expect(logEvent).toHaveBeenCalledWith("headhunter", "daily.stage", expect.objectContaining({
      meta: expect.objectContaining({ ok: 1, failed: 1, partial: 2, unverified: 1, results: receipt.results }),
    }));
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("private provider detail");
  });

  it("reports an empty response as unverified and redacts request errors", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("secret/private provider URL"));
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=0", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    const receipt = await response.json();
    expect(receipt).toMatchObject({ httpOk: 4, ok: 3, failed: 1, partial: 0, unverified: 1 });
    expect(receipt.results[1]).toMatchObject({ outcome: "failed", issue: "request_failed" });
    expect(JSON.stringify([receipt, logEvent.mock.calls])).not.toContain("secret/private provider URL");
  });

  it("reports partitioned collector failures even when errors is a bounded array", async () => {
    const batch = { checked: 10, attempted: 10, succeeded: 10, partial: 0, unavailable: 0,
      failed: 0, unsupported: 0, skipped: 0, error_count: 0, errors: [] };
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ...batch, succeeded: 0, failed: 10, error_count: 10,
        errors: [{ companyId: "private-id", code: "provider_unavailable" }] }))
      .mockResolvedValueOnce(Response.json({ ...batch, succeeded: 9, unavailable: 1 }))
      .mockResolvedValueOnce(Response.json({ ...batch, succeeded: 0, unsupported: 10 }))
      .mockResolvedValueOnce(Response.json({ ...batch, error_count: 1 }))
      .mockResolvedValueOnce(Response.json(batch));
    const response = await GET(new NextRequest("https://stanley.local/api/cron/daily?stage=0", {
      headers: { "x-cron-secret": "test-cron-secret" },
    }));
    const receipt = await response.json();
    expect(receipt).toMatchObject({ httpOk: 5, ok: 1, failed: 1, partial: 2, unverified: 1 });
    expect(receipt.results[0]).toMatchObject({ outcome: "failed", counts: { failed: 10, error_count: 10, errorSamples: 1 } });
    expect(JSON.stringify([receipt, logEvent.mock.calls])).not.toContain("private-id");
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
