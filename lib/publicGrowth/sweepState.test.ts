import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  applyPublicGrowthRetryOutcomes,
  beginPublicGrowthSweep,
  beginPublicGrowthRecoverySweep,
  collectPublicGrowthKeysetPages,
  completePublicGrowthSweep,
  failPublicGrowthSweep,
  matchesFrozenPublicGrowthRecipient,
  pendingPublicGrowthRetries,
  PUBLIC_GROWTH_LEASE_SECONDS,
  PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS,
  PublicGrowthSweepBusyError,
  PublicGrowthSweepLeaseLostError,
  queuePublicGrowthMainFailures,
  readPublicGrowthRetryState,
  stableIdPageDecision,
  shouldServicePublicGrowthRetry,
  takeRecurringBatch,
} from "./sweepState";

const token = "11111111-1111-4111-8111-111111111111";
const awardContinuation = (overrides: Record<string, unknown> = {}) => ({
  version: 1 as const,
  recipientName: "Example Company",
  searchEndDate: "2026-12-09",
  searchPage: 1,
  searchPassFoundNew: true,
  seenAwardIds: ["award-1"],
  entityId: "11111111-1111-4111-8111-111111111119",
  uei: "EXAMPLEUEI",
  recipientId: "recipient-hash-1",
  pendingAwardId: null,
  transactionPage: 1,
  transactionPassFoundNew: false,
  seenTransactionIds: [],
  ...overrides,
});

describe("public-growth sweep lease", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("atomically acquires the cursor and opaque fencing token", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        acquired: true,
        lease_token: token,
        lease_until: "2026-08-11T00:06:00.000Z",
        cursor: { offset: 250, version: 1 },
      },
      error: null,
    });
    const lease = await beginPublicGrowthSweep("revenue", 250, null);
    expect(mocks.rpc).toHaveBeenCalledWith("acquire_public_growth_sweep_lease", {
      p_source: "revenue",
      p_lease_seconds: PUBLIC_GROWTH_LEASE_SECONDS,
    });
    expect(lease).toEqual(expect.objectContaining({
      source: "revenue",
      offset: 250,
      managed: true,
      token,
      cursor: { offset: 250, version: 1 },
    }));
  });

  it("reports an overlapping source as busy without starting work", async () => {
    mocks.rpc.mockResolvedValue({
      data: { acquired: false, lease_until: "2026-08-11T00:06:00.000Z" },
      error: null,
    });
    await expect(beginPublicGrowthSweep("sam-entity", 10, null)).rejects.toEqual(
      expect.objectContaining({
        name: "PublicGrowthSweepBusyError",
        source: "sam-entity",
        retryAt: "2026-08-11T00:06:00.000Z",
      }),
    );
  });

  it("persists completion only through the matching fencing token", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const next = await completePublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250, version: 1 },
      token,
      leaseUntil: "2026-08-11T00:06:00.000Z",
    }, { checked: 250, nextOffset: 500, done: false, observed: 200, triggers: 3 });
    expect(next).toBe(500);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_public_growth_sweep_lease", expect.objectContaining({
      p_source: "revenue",
      p_lease_token: token,
      p_cursor: { offset: 500, version: 1 },
      p_receipt: expect.objectContaining({ checked: 250, nextOffset: 500, matched: 200, triggers: 3 }),
    }));
  });

  it("rejects a stale completion instead of rewinding a newer cursor", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(completePublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250 },
      token,
      leaseUntil: null,
    }, { checked: 250, nextOffset: 500 })).rejects.toBeInstanceOf(PublicGrowthSweepLeaseLostError);
  });

  it("records failures only for the matching token", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const recorded = await failPublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250 },
      token,
      leaseUntil: null,
    }, new Error("upstream timed out"));
    expect(recorded).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith("fail_public_growth_sweep_lease", {
      p_source: "revenue",
      p_lease_token: token,
      p_error: "upstream timed out",
    });
  });

  it("keeps explicit manual offsets outside managed state", async () => {
    const lease = await beginPublicGrowthSweep("revenue", 250, 750);
    const next = await completePublicGrowthSweep(lease, { checked: 250, nextOffset: 1000 });
    expect(next).toBe(750);
    expect(lease).toEqual(expect.objectContaining({ managed: false, token: null, offset: 750 }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates an isolated managed cursor for resumable explicit recovery", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        acquired: true,
        lease_token: token,
        lease_until: "2026-08-11T00:06:00.000Z",
        cursor: { offset: 0 },
      },
      error: null,
    });
    const lease = await beginPublicGrowthRecoverySweep("usaspending", 1, 50);
    expect(lease).toEqual(expect.objectContaining({
      source: "usaspending-recovery-50",
      offset: 50,
      managed: true,
      cursor: { offset: 50, recoveryBaseOffset: 50 },
    }));
  });

  it("exports distinct typed lease errors", () => {
    expect(new PublicGrowthSweepBusyError("revenue", null).name).toBe("PublicGrowthSweepBusyError");
    expect(new PublicGrowthSweepLeaseLostError("revenue").name).toBe("PublicGrowthSweepLeaseLostError");
  });

  it("ends an exact-multiple recurring cycle without an empty extra day", () => {
    expect(takeRecurringBatch(Array.from({ length: 10 }, (_, i) => i), 10)).toEqual({
      rows: Array.from({ length: 10 }, (_, i) => i),
      done: true,
    });
    expect(takeRecurringBatch(Array.from({ length: 11 }, (_, i) => i), 10)).toEqual({
      rows: Array.from({ length: 10 }, (_, i) => i),
      done: false,
    });
  });

  it("reconciles page drift until a full frozen-result pass finds no unseen ID", () => {
    const drifted = stableIdPageDecision({
      page: 2,
      passFoundNew: true,
      seenIds: ["award-b"],
      pageIds: ["award-new", "award-b"],
      hasNext: false,
    });
    expect(drifted).toEqual({ nextId: "award-new", page: 2, passFoundNew: true, done: false });
    const restart = stableIdPageDecision({
      page: 2,
      passFoundNew: true,
      seenIds: ["award-new", "award-b"],
      pageIds: ["award-new", "award-b"],
      hasNext: false,
    });
    expect(restart).toEqual({ nextId: null, page: 1, passFoundNew: false, done: false });
    const shiftedEarlier = stableIdPageDecision({
      page: 1,
      passFoundNew: false,
      seenIds: ["award-new", "award-b"],
      pageIds: ["award-new", "award-b", "award-a"],
      hasNext: false,
    });
    expect(shiftedEarlier.nextId).toBe("award-a");
  });

  it("never rebinds a continuation to a different same-name recipient", () => {
    expect(matchesFrozenPublicGrowthRecipient(
      { uei: "UEI-ONE", recipientId: "recipient-1" },
      { uei: "UEI-ONE", recipientId: "recipient-2" },
    )).toBe(true);
    expect(matchesFrozenPublicGrowthRecipient(
      { uei: "UEI-ONE", recipientId: "recipient-1" },
      { uei: "UEI-TWO", recipientId: "recipient-1" },
    )).toBe(false);
    expect(matchesFrozenPublicGrowthRecipient(
      { uei: null, recipientId: "recipient-1" },
      { uei: null, recipientId: "recipient-2" },
    )).toBe(false);
  });

  it("paginates stored metric rows beyond 5000 without silent truncation", async () => {
    const source = Array.from({ length: 6001 }, (_, index) => ({ id: String(index).padStart(8, "0") }));
    const loadPage = async (afterId: string | null, limit: number) => source
      .filter((row) => afterId == null || row.id > afterId)
      .slice(0, limit);
    const rows = await collectPublicGrowthKeysetPages(loadPage, { pageSize: 1000, maxRows: 10_000 });
    expect(rows).toHaveLength(6001);
    expect(rows.at(-1)?.id).toBe("00006000");
  });

  it("fails closed instead of truncating stored metric rows above the supported bound", async () => {
    const source = Array.from({ length: 6001 }, (_, index) => ({ id: String(index).padStart(8, "0") }));
    await expect(collectPublicGrowthKeysetPages(
      async (afterId, limit) => source.filter((row) => afterId == null || row.id > afterId).slice(0, limit),
      { pageSize: 1000, maxRows: 5000 },
    )).rejects.toThrow(/exceeded the supported 5000-row bound/);
  });

  it("binds a main-page error to one exact retry while allowing cursor advance", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const queued = queuePublicGrowthMainFailures(
      { offset: 40 },
      [
        { companyId, status: "error", error: "upstream timeout" },
        { companyId: "11111111-1111-4111-8111-111111111113", status: "matched" },
      ],
      1,
      "2026-08-11T00:00:00.000Z",
    );
    expect(queued.queued).toBe(1);
    expect(queued.cursorPatch.retryQueue).toEqual([expect.objectContaining({
      companyId,
      failureAttempts: 1,
      lastError: "upstream timeout",
    })]);
    expect(pendingPublicGrowthRetries(queued.cursorPatch, 10)).toHaveLength(1);
  });

  it("removes a transient success before any new main work", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const cursor = queuePublicGrowthMainFailures(
      {},
      [{ companyId, status: "error", error: "temporary" }],
      1,
      "2026-08-11T00:00:00.000Z",
    ).cursorPatch;
    const planned = pendingPublicGrowthRetries(cursor, 10);
    const applied = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "matched" }],
      "2026-08-11T00:05:00.000Z",
    );
    expect(applied.errors).toBe(0);
    expect(applied.deadLettered).toEqual([]);
    expect(applied.cursorPatch.retryQueue).toEqual([]);
  });

  it("dead-letters a permanent failure after three bounded invocations", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    let cursor = queuePublicGrowthMainFailures(
      {},
      [{ companyId, status: "error", error: "failure 1" }],
      1,
      "2026-08-11T00:00:00.000Z",
    ).cursorPatch;
    let planned = pendingPublicGrowthRetries(cursor, 10);
    let applied = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "error", error: "failure 2" }],
      "2026-08-11T00:05:00.000Z",
    );
    expect(applied.cursorPatch.retryQueue[0].failureAttempts).toBe(2);
    cursor = applied.cursorPatch;
    planned = pendingPublicGrowthRetries(cursor, 10);
    applied = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "error", error: "failure 3" }],
      "2026-08-11T00:10:00.000Z",
    );
    expect(PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS).toBe(3);
    expect(applied.cursorPatch.retryQueue).toEqual([]);
    expect(applied.deadLettered).toEqual([companyId]);
    expect(applied.cursorPatch.deadLetters).toEqual([expect.objectContaining({
      companyId,
      totalFailures: 3,
      occurrences: 1,
      resolvedAt: null,
    })]);
  });

  it("fails closed when an aggregate error cannot be bound to an exact receipt", () => {
    expect(() => queuePublicGrowthMainFailures(
      {},
      [{ companyId: "11111111-1111-4111-8111-111111111112", status: "matched" }],
      1,
      "2026-08-11T00:00:00.000Z",
    )).toThrow(/reported 1 errors but bound 0/);
    expect(() => readPublicGrowthRetryState({ retryQueue: "corrupt" })).toThrow(/must be arrays/);
  });

  it("truncates a long exact-company failure instead of wedging the source", () => {
    const queued = queuePublicGrowthMainFailures(
      {},
      [{
        companyId: "11111111-1111-4111-8111-111111111112",
        status: "error",
        error: "x".repeat(5000),
      }],
      1,
      "2026-08-11T00:00:00.000Z",
    );
    expect(queued.cursorPatch.retryQueue[0].lastError).toHaveLength(1000);
  });

  it("checkpoints a frozen-search continuation before advancing to new companies", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const first = awardContinuation();
    let cursor = queuePublicGrowthMainFailures(
      {},
      [{ companyId, status: "matched", awardDone: false, awardContinuation: first }],
      0,
      "2026-08-11T00:00:00.000Z",
    ).cursorPatch;
    expect(cursor.retryQueue).toEqual([expect.objectContaining({
      companyId,
      failureAttempts: 0,
      awardContinuation: first,
      lastError: null,
    })]);
    let planned = pendingPublicGrowthRetries(cursor, 1);
    const second = awardContinuation({ searchPage: 2, seenAwardIds: ["award-1", "award-2"] });
    let applied = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "matched", awardDone: false, awardContinuation: second }],
      "2026-08-11T00:05:00.000Z",
    );
    expect(applied.cursorPatch.retryQueue[0].awardContinuation).toEqual(second);
    cursor = applied.cursorPatch;
    planned = pendingPublicGrowthRetries(cursor, 1);
    applied = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "matched", awardDone: true }],
      "2026-08-11T00:10:00.000Z",
    );
    expect(applied.cursorPatch.retryQueue).toEqual([]);
  });

  it("retains the exact frozen-search continuation in a dead letter", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const continuation = awardContinuation({ pendingAwardId: "award-2", transactionPage: 3 });
    let cursor = queuePublicGrowthMainFailures(
      {},
      [{ companyId, status: "error", error: "failure 1", awardContinuation: continuation }],
      1,
      "2026-08-11T00:00:00.000Z",
    ).cursorPatch;
    for (let attempt = 2; attempt <= 3; attempt++) {
      const planned = pendingPublicGrowthRetries(cursor, 1);
      const applied = applyPublicGrowthRetryOutcomes(
        cursor,
        planned,
        [{ companyId, status: "error", error: `failure ${attempt}` }],
        `2026-08-11T00:${attempt === 2 ? "05" : "10"}:00.000Z`,
      );
      cursor = applied.cursorPatch;
    }
    expect(cursor.deadLetters[0]).toEqual(expect.objectContaining({
      companyId,
      awardContinuation: continuation,
    }));
  });

  it("alternates an unresolved retry with main work without losing the exact queue", () => {
    const companyId = "11111111-1111-4111-8111-111111111112";
    const continuation = awardContinuation();
    let cursor = queuePublicGrowthMainFailures(
      {},
      [{ companyId, status: "matched", awardDone: false, awardContinuation: continuation }],
      0,
      "2026-08-11T00:00:00.000Z",
    ).cursorPatch;
    expect(shouldServicePublicGrowthRetry(cursor)).toBe(true);
    const planned = pendingPublicGrowthRetries(cursor, 1);
    cursor = applyPublicGrowthRetryOutcomes(
      cursor,
      planned,
      [{ companyId, status: "matched", awardDone: false, awardContinuation: continuation }],
      "2026-08-11T00:05:00.000Z",
    ).cursorPatch;
    expect(shouldServicePublicGrowthRetry(cursor)).toBe(false);
    cursor = queuePublicGrowthMainFailures(
      cursor,
      [{ companyId: "11111111-1111-4111-8111-111111111113", status: "matched" }],
      0,
      "2026-08-11T00:10:00.000Z",
    ).cursorPatch;
    expect(cursor.retryQueue).toHaveLength(1);
    expect(cursor.retryQueue[0].companyId).toBe(companyId);
    expect(shouldServicePublicGrowthRetry(cursor)).toBe(true);
  });

  it("persists retry state under the fencing token without moving the main offset", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const next = await completePublicGrowthSweep({
      source: "usaspending",
      offset: 40,
      batchSize: 10,
      managed: true,
      cursor: { offset: 40, version: 1 },
      token,
      leaseUntil: null,
    }, {
      checked: 1,
      nextOffset: 40,
      errors: 1,
      advanceCursor: false,
      mode: "retry",
      cursorPatch: {
        retryQueue: [],
        deadLetters: [{
          companyId: "11111111-1111-4111-8111-111111111112",
          totalFailures: 3,
          firstFailedAt: "2026-08-11T00:00:00.000Z",
          lastFailedAt: "2026-08-11T00:10:00.000Z",
          lastError: "permanent",
          deadLetteredAt: "2026-08-11T00:10:00.000Z",
          resolvedAt: null,
          occurrences: 1,
          awardContinuation: null,
        }],
      },
    });
    expect(next).toBe(40);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_public_growth_sweep_lease", expect.objectContaining({
      p_cursor: expect.objectContaining({ offset: 40, retryQueue: [] }),
      p_receipt: expect.objectContaining({ nextOffset: 40, errors: 1, mode: "retry" }),
    }));
  });
});
