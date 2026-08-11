import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const quarantine = vi.hoisted(() => vi.fn(async ({ apply }: { apply: boolean }) => ({
  mode: apply ? "apply" : "dry_run",
  batch: "signal-integrity-2026-08-10",
  scanned: 10,
  planned: 2,
  applied: apply ? 2 : 0,
  readbackVerified: apply ? 2 : 0,
  flagsCleared: apply ? 2 : 0,
  failures: [],
  reasonCounts: { finance_hire_record_dead: 2 },
  nextCursor: "00000000-0000-0000-0000-000000000001",
  hasMore: false,
})));
const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/triggers/quarantine", () => ({ quarantineInvalidTriggers: quarantine }));
vi.mock("@/lib/db/events", () => ({ logEvent }));

import { POST } from "./route";

describe("signal-quarantine mutation guard", () => {
  const priorSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    quarantine.mockClear();
    logEvent.mockReset();
    logEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (priorSecret == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorSecret;
  });

  const request = (body: Record<string, unknown>, secret = "test-cron-secret") => new NextRequest(
    "https://stanley.local/api/cron/quarantine-signals",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-cron-secret": secret },
      body: JSON.stringify(body),
    },
  );

  it("defaults to a non-mutating dry run", async () => {
    const response = await POST(request({ limit: 25 }));
    expect(response.status).toBe(200);
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({ apply: false, limit: 25 }));
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("requires explicit preservation confirmation before apply", async () => {
    const response = await POST(request({ apply: true }));
    expect(response.status).toBe(400);
    expect(quarantine).not.toHaveBeenCalled();
  });

  it("allows the confirmed authenticated quarantine operation", async () => {
    const response = await POST(request({ apply: true, confirm: "PRESERVE_ROWS_AND_QUARANTINE" }));
    expect(response.status).toBe(200);
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({ apply: true }));
    expect(logEvent).toHaveBeenCalledWith("headhunter", "signals.quarantined", expect.any(Object));
  });

  it("returns the committed receipt instead of a retryable 500 when timeline logging fails", async () => {
    logEvent.mockRejectedValueOnce(new Error("timeline unavailable"));
    const response = await POST(request({ apply: true, confirm: "PRESERVE_ROWS_AND_QUARANTINE" }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.failures).toContainEqual({
      id: "event:signals.quarantined",
      reason: "timeline unavailable",
    });
  });

  it("rejects an invalid secret", async () => {
    const response = await POST(request({}, "wrong"));
    expect(response.status).toBe(401);
    expect(quarantine).not.toHaveBeenCalled();
  });
});
