vi.mock("@/lib/publicGrowth/federalCoverageStore", () => ({ saveFederalCoverageReceipts: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  beginRecovery: vi.fn(),
  beginCompanyRecovery: vi.fn(),
  inspectCompanyRecovery: vi.fn(),
  complete: vi.fn(),
  checkpoint: vi.fn(),
  fail: vi.fn(),
  pending: vi.fn(),
  queueMain: vi.fn(),
  applyRetry: vi.fn(),
  afterCompanyId: vi.fn(),
  shouldRetry: vi.fn(),
  loadExact: vi.fn(),
  usaspending: vi.fn(),
  usaspendingCompany: vi.fn(),
  subawards: vi.fn(),
  subawardsCompany: vi.fn(),
  sam: vi.fn(),
  samCompany: vi.fn(),
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
    beginPublicGrowthRecoverySweep: mocks.beginRecovery,
    beginPublicGrowthCompanyRecoverySweep: mocks.beginCompanyRecovery,
    inspectPublicGrowthCompanyRecovery: mocks.inspectCompanyRecovery,
    completePublicGrowthSweep: mocks.complete,
    checkpointPublicGrowthSweep: mocks.checkpoint,
    failPublicGrowthSweep: mocks.fail,
    pendingPublicGrowthRetries: mocks.pending,
    queuePublicGrowthMainFailures: mocks.queueMain,
    applyPublicGrowthRetryOutcomes: mocks.applyRetry,
    publicGrowthAfterCompanyId: mocks.afterCompanyId,
    shouldServicePublicGrowthRetry: mocks.shouldRetry,
    PublicGrowthSweepBusyError,
    PublicGrowthSweepLeaseLostError,
  };
});
vi.mock("@/lib/publicGrowth/usaspendingSweep", () => ({
  loadTamCompaniesByIds: mocks.loadExact,
  sweepUsaspendingTamBatch: mocks.usaspending,
  sweepUsaspendingCompany: mocks.usaspendingCompany,
  sweepUsaspendingCompanySteps: mocks.usaspendingCompany,
  sweepUsaspendingSubawardsTamBatch: mocks.subawards,
  sweepUsaspendingSubawardsCompany: mocks.subawardsCompany,
}));
vi.mock("@/lib/publicGrowth/samSweep", () => ({
  sweepSamTamBatch: mocks.sam,
  sweepSamCompany: mocks.samCompany,
}));
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
    mocks.beginRecovery.mockResolvedValue({
      ...lease,
      source: "usaspending-recovery-50",
      offset: 50,
      cursor: { offset: 50, recoveryBaseOffset: 50 },
    });
    mocks.beginCompanyRecovery.mockImplementation(async (source, companyId) => ({
      ...lease, source: `${source}-company-${companyId}`,
      cursor: { offset: 0, recoveryCompanyId: companyId, recoverySource: source },
    }));
    mocks.complete.mockResolvedValue(10);
    mocks.fail.mockResolvedValue(true);
    mocks.pending.mockReturnValue([]);
    mocks.afterCompanyId.mockReturnValue(null);
    mocks.shouldRetry.mockImplementation(() => mocks.pending.mock.results.at(-1)?.value?.length > 0);
    mocks.queueMain.mockReturnValue({
      cursorPatch: { retryQueue: [], deadLetters: [] },
      queued: 0,
      continuations: 0,
    });
    mocks.applyRetry.mockReturnValue({
      cursorPatch: { retryQueue: [], deadLetters: [] },
      deadLettered: [],
      errors: 0,
    });
    mocks.loadExact.mockResolvedValue([]);
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

  it("rejects legacy SAM opportunity offsets before taking a lease", async () => {
    const response = await GET(request("source=sam-opportunities&offset=0"));
    expect(response.status).toBe(400); expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.opportunities).not.toHaveBeenCalled();
  });

  it("passes the managed SAM source checkpoint, deadline and fenced progress callback", async () => {
    const sourceCursor = { version: 1, source: "frozen-source" };
    const managed = { ...lease, source: "sam-opportunities", offset: 777, cursor: { offset: 777, samOpportunityCursor: sourceCursor } };
    mocks.begin.mockResolvedValue(managed); mocks.complete.mockResolvedValue(777); mocks.checkpoint.mockResolvedValue(undefined);
    mocks.opportunities.mockImplementation(async (_days, _offset, _limit, options) => {
      expect(options.cursor).toEqual(sourceCursor); expect(options.deadlineMs).toBeGreaterThan(Date.now());
      await options.checkpoint({ ...sourceCursor, nextByte: 50 });
      return { checked: 1, done: false, errors: 0, advanceCursor: false, opportunityProgress: { sourceSnapshotComplete: false, nextByte: 50 } };
    });
    const response = await GET(request("source=sam-opportunities&limit=1000")); expect(response.status).toBe(200);
    expect(mocks.opportunities).toHaveBeenCalledWith(31, 777, 1000, expect.any(Object));
    expect(mocks.checkpoint).toHaveBeenCalledWith(managed, { samOpportunityCursor: { ...sourceCursor, nextByte: 50 } });
    expect(mocks.complete).toHaveBeenCalledWith(managed, expect.objectContaining({ opportunityProgress: { sourceSnapshotComplete: false, nextByte: 50 } }));
  });

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
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ error: "lease_acquire_failed" }));
    expect(JSON.stringify(body)).not.toContain("RPC unavailable");
    expect(mocks.usaspending).not.toHaveBeenCalled();
  });

  it("runs the verified recurring set and completes before returning success", async () => {
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith("usaspending", 10, null);
    expect(mocks.usaspending).toHaveBeenCalledWith(6, 0, { scope: "verified", afterCompanyId: null, deadlineMs: expect.any(Number) });
    expect(mocks.complete).toHaveBeenCalledWith(lease, expect.objectContaining({ checked: 10 }));
    expect(await response.json()).toEqual(expect.objectContaining({ nextCursor: 10 }));
  });

  it("advances the main cursor while durably queueing each exact company error", async () => {
    mocks.queueMain.mockReturnValueOnce({
      cursorPatch: {
        retryQueue: [{ companyId: "retry-me", failureAttempts: 1 }],
        deadLetters: [],
      },
      queued: 1,
      continuations: 0,
    });
    mocks.usaspending.mockResolvedValueOnce({
      source: "usaspending",
      offset: 0,
      checked: 10,
      nextOffset: 10,
      done: false,
      matched: 2,
      errors: 1,
      triggers: 1,
      receipts: [{ companyId: "retry-me", status: "error" }],
    });
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(200);
    expect(mocks.queueMain).toHaveBeenCalledWith(
      lease.cursor,
      [{ companyId: "retry-me", status: "error" }],
      1,
    );
    expect(mocks.complete).toHaveBeenCalledWith(lease, expect.objectContaining({
      retryQueued: 1,
      retryRemaining: 1,
      mode: "main+retry",
    }));
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(expect.objectContaining({ retryQueued: 1, retryRemaining: 1 }));
  });

  it("services the durable retry queue while still advancing the fresh main page", async () => {
    const entry = {
      companyId: "11111111-1111-4111-8111-111111111112",
      failureAttempts: 1,
      queuedAt: "2026-08-11T00:00:00.000Z",
      lastAttemptedAt: "2026-08-11T00:00:00.000Z",
      firstFailedAt: "2026-08-11T00:00:00.000Z",
      lastError: "temporary upstream error",
      awardContinuation: null,
    };
    mocks.pending.mockReturnValueOnce([entry]);
    mocks.loadExact.mockResolvedValueOnce([{
      id: entry.companyId,
      name: "Retry Co",
      domain: "retry.example",
    }]);
    mocks.usaspendingCompany.mockResolvedValueOnce({
      companyId: entry.companyId,
      status: "matched",
      triggers: 1,
    });
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(200);
    expect(mocks.usaspending).toHaveBeenCalledWith(6, 0, { scope: "verified", afterCompanyId: null, deadlineMs: expect.any(Number) });
    expect(mocks.usaspendingCompany).toHaveBeenCalledTimes(1);
    expect(mocks.applyRetry).toHaveBeenCalledWith(
      lease.cursor,
      [entry],
      [expect.objectContaining({ companyId: entry.companyId, status: "matched" })],
    );
    expect(mocks.complete).toHaveBeenCalledWith(lease, expect.objectContaining({
      advanceCursor: false,
      mode: "main+retry",
      mainChecked: 10,
      retryChecked: 1,
    }));
  });

  it("keeps full-TAM scans explicit and recovery-only", async () => {
    const response = await GET(request("source=usaspending&scope=tam&n=10"));
    expect(response.status).toBe(400);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.usaspending).not.toHaveBeenCalled();
  });

  it("persists explicit full-TAM USAspending continuation in a durable recovery lease", async () => {
    const continuation = {
      version: 1, recipientName: "Recovery Co", searchEndDate: "2026-12-09",
      searchPage: 1, searchPassFoundNew: true, seenAwardIds: [],
      entityId: null, uei: null, recipientId: null, pendingAwardId: "award-1",
      transactionPage: 1, transactionPassFoundNew: false, seenTransactionIds: [],
    };
    mocks.usaspending.mockResolvedValueOnce({
      source: "usaspending", offset: 50, checked: 1, nextOffset: 51, done: false,
      matched: 1, errors: 0, triggers: 0,
      receipts: [{ companyId: "11111111-1111-4111-8111-111111111112", status: "matched", awardDone: false, awardContinuation: continuation }],
    });
    mocks.queueMain.mockReturnValueOnce({
      cursorPatch: {
        retryQueue: [{ companyId: "11111111-1111-4111-8111-111111111112", failureAttempts: 0, awardContinuation: continuation }],
        deadLetters: [], retryServedLast: false,
      },
      queued: 1,
      continuations: 1,
    });
    const response = await GET(request("source=usaspending&scope=tam&n=1&offset=50"));
    expect(response.status).toBe(200);
    expect(mocks.beginRecovery).toHaveBeenCalledWith("usaspending", 1, 50);
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      source: "usaspending-recovery-50",
      offset: 50,
    }), expect.objectContaining({ retryRemaining: 1, awardContinuationsQueued: 1 }));
    expect(await response.json()).toEqual(expect.objectContaining({ retryRemaining: 1 }));
  });

  it("readbacks a completed explicit recovery without advancing to another company", async () => {
    mocks.beginRecovery.mockResolvedValueOnce({
      ...lease,
      source: "usaspending-recovery-50",
      offset: 50,
      cursor: { offset: 50, recoveryBaseOffset: 50, recoveryComplete: true },
    });
    const response = await GET(request("source=usaspending&scope=tam&n=1&offset=50"));
    expect(response.status).toBe(200);
    expect(mocks.usaspending).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      recoveryComplete: true,
      advanceCursor: false,
      retryRemaining: 0,
    }));
    expect(await response.json()).toEqual(expect.objectContaining({ recoveryComplete: true }));
  });

  it("persists a dead-lettered explicit recovery as blocked, never complete", async () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const entry = {
      companyId, failureAttempts: 2,
      queuedAt: "2026-08-11T00:00:00.000Z", lastAttemptedAt: "2026-08-11T00:05:00.000Z",
      firstFailedAt: "2026-08-11T00:00:00.000Z", lastError: "still failing", awardContinuation: null,
    };
    mocks.pending.mockReturnValueOnce([entry]);
    mocks.loadExact.mockResolvedValueOnce([{ id: companyId, name: "Blocked Co" }]);
    mocks.usaspendingCompany.mockResolvedValueOnce({ companyId, status: "error", error: "permanent", triggers: 0 });
    mocks.applyRetry.mockReturnValueOnce({
      cursorPatch: { retryQueue: [], deadLetters: [], retryServedLast: true },
      deadLettered: [companyId], errors: 1,
    });
    const response = await GET(request("source=usaspending&scope=tam&n=1&offset=50"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({
      recoveryBlocked: true,
      retryDeadLettered: [companyId],
      errors: 1,
    }));
    expect(body.recoveryComplete).not.toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      recoveryBlocked: true,
      advanceCursor: false,
    }));
  });

  it("does not accept a cron secret from the URL query string", async () => {
    const response = await GET(new NextRequest(
      "https://stanley.local/api/cron/public-growth?source=usaspending&scope=verified&secret=test-cron-secret",
    ));
    expect(response.status).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("keeps subaward main coverage advancing when an exact retry remains queued", async () => {
    const retryId = "11111111-1111-4111-8111-111111111112";
    const nextId = "11111111-1111-4111-8111-111111111113";
    const retryEntry = { companyId: retryId, failureAttempts: 1 };
    const subawardLease = { ...lease, source: "usaspending-subawards", cursor: { retryQueue: [retryEntry], retryServedLast: false } };
    mocks.begin.mockResolvedValueOnce(subawardLease);
    mocks.pending.mockReturnValueOnce([retryEntry]);
    mocks.shouldRetry.mockReturnValueOnce(true);
    mocks.loadExact.mockResolvedValueOnce([{ id: retryId, name: "Retry Co" }]);
    mocks.subawardsCompany.mockResolvedValueOnce({ companyId: retryId, status: "error", triggers: 0, stored: 2 });
    mocks.applyRetry.mockReturnValueOnce({
      cursorPatch: { retryQueue: [{ ...retryEntry, failureAttempts: 2 }], deadLetters: [], retryServedLast: true },
      deadLettered: [], errors: 1,
    });
    mocks.subawards.mockResolvedValueOnce({
      source: "usaspending-subawards", offset: 0, checked: 125, nextOffset: 125, done: false,
      matched: 123, errors: 0, stored: 3, triggers: 1, receipts: [],
      advanceCursor: false, cursorPatch: { afterCompanyId: nextId },
    });
    mocks.queueMain.mockImplementationOnce((cursor) => ({ cursorPatch: cursor, queued: 0, continuations: 0 }));
    const response = await GET(request("source=usaspending-subawards&scope=verified&n=125"));
    expect(response.status).toBe(200);
    expect(mocks.pending).toHaveBeenCalledWith(subawardLease.cursor, 10);
    expect(mocks.subawards).toHaveBeenCalledWith(125, 0, "verified", null, { deadlineMs: expect.any(Number) });
    expect(mocks.complete).toHaveBeenCalledWith(subawardLease, expect.objectContaining({
      mode: "main+retry", mainChecked: 125, retryChecked: 1, checked: 126, stored: 5,
      cursorPatch: expect.objectContaining({ afterCompanyId: nextId, retryQueue: [{ ...retryEntry, failureAttempts: 2 }] }),
    }));
  });

  it("allows a 4,000-row revenue page but clamps larger requested budgets", async () => {
    mocks.revenue.mockResolvedValue({ source: "revenue", offset: 0, checked: 4000, nextOffset: 4000, done: false, observed: 4000, triggers: 0 });
    const response = await GET(request("source=revenue&limit=9000"));
    expect(response.status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith("revenue", 4000, null);
    expect(mocks.revenue).toHaveBeenCalledWith(4000, 0);
  });

  it("checkpoints only the attempted retry prefix when its time budget expires", async () => {
    const ids = ["11111111-1111-4111-8111-111111111112", "11111111-1111-4111-8111-111111111113"];
    const entries = ids.map((companyId) => ({ companyId, failureAttempts: 1 }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      mocks.pending.mockReturnValueOnce(entries);
      mocks.loadExact.mockResolvedValueOnce(ids.map((id) => ({ id, name: id })));
      mocks.subawardsCompany.mockImplementationOnce(async () => {
        clock.mockReturnValue(61_000);
        return { companyId: ids[0], status: "linked", subawardDone: true, triggers: 0, stored: 0 };
      });
      mocks.applyRetry.mockReturnValueOnce({ cursorPatch: { retryQueue: [entries[1]], deadLetters: [] }, deadLettered: [], errors: 0 });
      mocks.queueMain.mockImplementationOnce((cursor) => ({ cursorPatch: cursor, queued: 0, continuations: 0 }));
      mocks.subawards.mockResolvedValueOnce({ source: "usaspending-subawards", checked: 125, matched: 125, errors: 0, triggers: 0, stored: 0, receipts: [] });
      const response = await GET(request("source=usaspending-subawards&scope=verified&n=125"));
      expect(response.status).toBe(200);
      expect(mocks.subawardsCompany).toHaveBeenCalledTimes(1);
      expect(mocks.applyRetry).toHaveBeenCalledWith(expect.anything(), [entries[0]], [expect.objectContaining({ companyId: ids[0] })]);
      expect(mocks.subawards).toHaveBeenCalledWith(125, 0, "verified", null, { deadlineMs: 240_000 });
      expect(await response.json()).toEqual(expect.objectContaining({ mainChecked: 125, retryChecked: 1, retryRemaining: 1 }));
    } finally { clock.mockRestore(); }
  });

  it("starts an exact current company foundation without touching historical offset recovery", async () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const company = { id: companyId, name: "New TAM Co" };
    mocks.loadExact.mockResolvedValueOnce([company]);
    mocks.usaspendingCompany.mockResolvedValueOnce({ companyId, status: "no_awards", awards: 0, transactions: 0, triggers: 0, awardDone: true });
    const response = await GET(request(`source=usaspending&companyId=${companyId}`));
    expect(response.status).toBe(200);
    expect(mocks.beginCompanyRecovery).toHaveBeenCalledWith("usaspending", companyId);
    expect(mocks.beginRecovery).not.toHaveBeenCalled();
    expect(mocks.usaspending).not.toHaveBeenCalled();
    expect(mocks.usaspendingCompany).toHaveBeenCalledWith(company, { deadlineMs: expect.any(Number) }, 3);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      source: `usaspending-company-${companyId}`,
      cursor: expect.objectContaining({ recoveryCompanyId: companyId }),
    }), expect.objectContaining({ recoveryComplete: true, checked: 1, advanceCursor: false }));
  });

  it("rejects removed exact foundation companies before acquiring or trusting completion state", async () => {
    const response = await GET(request("source=usaspending&companyId=11111111-1111-4111-8111-111111111112"));
    expect(response.status).toBe(404);
    expect(mocks.beginCompanyRecovery).not.toHaveBeenCalled();
    expect(mocks.usaspendingCompany).not.toHaveBeenCalled();
  });

  it("does not allow an exact company foundation to mix numeric offsets or multi-company batches", async () => {
    for (const extra of ["offset=0", "n=2", "scope=verified"]) {
      const response = await GET(request(`source=usaspending&companyId=11111111-1111-4111-8111-111111111112&${extra}`));
      expect(response.status).toBe(400);
    }
    expect(mocks.loadExact).not.toHaveBeenCalled();
    expect(mocks.beginCompanyRecovery).not.toHaveBeenCalled();
  });

  it("reads uncertain exact foundation state without a lease or source invocation", async () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    mocks.loadExact.mockResolvedValueOnce([{ id: companyId, name: "New TAM Co" }]);
    mocks.inspectCompanyRecovery.mockResolvedValueOnce({ readOnly: true, found: true, recoveryComplete: true, companyId });
    const response = await GET(request(`source=usaspending&companyId=${companyId}&inspect=1`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ readOnly: true, recoveryComplete: true }));
    expect(mocks.beginCompanyRecovery).not.toHaveBeenCalled();
    expect(mocks.usaspendingCompany).not.toHaveBeenCalled();
  });

  it("does not return raw sweep exception details", async () => {
    mocks.usaspending.mockRejectedValueOnce(new Error("database host and table detail"));
    const response = await GET(request("source=usaspending&scope=verified&n=10"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("sweep_failed");
    expect(JSON.stringify(body)).not.toContain("database host and table detail");
  });
});
