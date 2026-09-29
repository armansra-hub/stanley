import { describe, expect, it } from "vitest";
import { DAILY_RECEIPT_BYTE_LIMIT, readDailyChildReceipt, summarizeDailyChild } from "./dailyOutcome";

const collectorReceipt = (overrides: Record<string, unknown> = {}) => ({
  checked: 10, attempted: 10, succeeded: 10, partial: 0, unavailable: 0,
  failed: 0, unsupported: 0, skipped: 0, error_count: 0, errors: [], ...overrides,
});

describe("daily child receipts", () => {
  it.each([
    [{ error: "private upstream error" }, "failed"],
    [{ checked: 5, failed: 2 }, "partial"],
    [{ checked: 5, errors: 5 }, "failed"],
    [{ checked: 5, errors: 0, historiesIncomplete: 1 }, "partial"],
    [{ checked: 5, errors: 0, retryDeadLettered: [{ companyId: "private" }] }, "partial"],
    [{ status: "partial", checked: 1 }, "partial"],
    [{ status: "unavailable", checked: 0 }, "failed"],
    [{ recoveryBlocked: true, errors: 0 }, "failed"],
    [{ enabled: false, checked: 0, errors: 0 }, "unverified"],
    [{ checked: 5, errors: 0 }, "reported_success"],
    [{ checked: 0, errors: 0 }, "reported_success"],
    [{ checked: 5, news_triggers: 0 }, "unverified"],
    [{ checked: 5, errors: "5", ok: true }, "unverified"],
    [{ status: "unexpected_status", errors: 0 }, "unverified"],
    [null, "unverified"],
  ])("classifies reported source outcomes for %j", (body, outcome) => {
    expect(summarizeDailyChild(200, body).outcome).toBe(outcome);
  });

  it.each([
    [collectorReceipt(), "reported_success"],
    [collectorReceipt({ checked: 0, attempted: 0, succeeded: 0 }), "reported_success"],
    [collectorReceipt({ succeeded: 0, failed: 10 }), "failed"],
    [collectorReceipt({ succeeded: 0, unavailable: 10 }), "failed"],
    [collectorReceipt({ succeeded: 9, failed: 1 }), "partial"],
    [collectorReceipt({ succeeded: 9, unavailable: 1 }), "partial"],
    [collectorReceipt({ succeeded: 0, partial: 10 }), "partial"],
    [collectorReceipt({ error_count: 1 }), "partial"],
    [collectorReceipt({ errors: [{ companyId: "private", code: "provider_unavailable" }] }), "partial"],
    [collectorReceipt({ succeeded: 0, failed: 10, errors: [{ code: "failed" }] }), "failed"],
    [collectorReceipt({ succeeded: 9, unsupported: 1 }), "partial"],
    [collectorReceipt({ succeeded: 0, unsupported: 10 }), "unverified"],
    [collectorReceipt({ succeeded: 9, skipped: 1 }), "partial"],
    [collectorReceipt({ succeeded: 0, skipped: 10 }), "unverified"],
    [collectorReceipt({ attempted: 11 }), "unverified"],
    [collectorReceipt({ failed: "0" }), "unverified"],
    [collectorReceipt({ error_count: "0" }), "unverified"],
    [{ attempted: 10, succeeded: 10, errors: [] }, "unverified"],
  ])("classifies partitioned collector outcomes for %j", (body, outcome) => {
    expect(summarizeDailyChild(200, body).outcome).toBe(outcome);
  });

  it("retains collector counts but only the size of its diagnostic sample", () => {
    const result = summarizeDailyChild(200, collectorReceipt({ succeeded: 9, failed: 1, error_count: 11,
      errors: [{ companyId: "private-id", source: "website", stage: "fetch", code: "provider_unavailable" }],
    }));
    expect(result).toMatchObject({ outcome: "partial", counts: { attempted: 10, succeeded: 9, failed: 1, error_count: 11, errorSamples: 1 } });
    expect(JSON.stringify(result)).not.toContain("private-id");
    expect(JSON.stringify(result)).not.toContain("provider_unavailable");
    expect(result.counts.errors).toBeUndefined();
  });

  it("retains only allowlisted bounded counts and flags, never raw evidence or errors", () => {
    const result = summarizeDailyChild(200, {
      checked: 12, errors: 0, done: false, historiesCompleted: 2, historiesIncomplete: 1,
      retryDeadLettered: [{ companyId: "private-id", error: "secret" }],
      source: "secret", receipts: [{ private: true }], nextCursor: { token: "secret" },
      triggers: "secret", matched: -1, stored: Number.MAX_VALUE, status: "secret",
    });
    expect(result).toEqual({ outcome: "partial", counts: {
      checked: 12, errors: 0, historiesCompleted: 2, historiesIncomplete: 1, retryDeadLettered: 1,
    }, flags: { done: false } });
  });

  it("does not turn an HTTP failure into success because its body says OK", async () => {
    expect(await readDailyChildReceipt(Response.json({ ok: true, checked: 0 }, { status: 503 })))
      .toMatchObject({ outcome: "failed", issue: "http_error" });
  });

  it("reads JSON and fails closed on non-JSON or missing receipts", async () => {
    expect(await readDailyChildReceipt(Response.json({ checked: 6, errors: 0, receipts: ["private"] })))
      .toEqual({ outcome: "reported_success", counts: { checked: 6, errors: 0 }, flags: {} });
    expect(await readDailyChildReceipt(new Response("<html>upstream failed</html>")))
      .toMatchObject({ outcome: "unverified", issue: "receipt_unavailable" });
    expect(await readDailyChildReceipt(Response.json(["unexpected array"])))
      .toMatchObject({ outcome: "unverified", issue: "invalid_receipt" });
  });

  it("cancels an oversized response without retaining its body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(DAILY_RECEIPT_BYTE_LIMIT + 1)); },
      cancel() { cancelled = true; },
    }));
    expect(await readDailyChildReceipt(response)).toEqual({
      outcome: "unverified", issue: "receipt_too_large", counts: {}, flags: {},
    });
    expect(cancelled).toBe(true);
  });
});
