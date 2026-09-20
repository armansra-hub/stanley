vi.mock("@/lib/publicGrowth/federalCoverageStore", () => ({ saveFederalCoverageReceipts: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), checkpoint: vi.fn(), complete: vi.fn(), fail: vi.fn(), rpc: vi.fn(), worker: vi.fn(), event: vi.fn(), inspect: vi.fn(), journal: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc,
  from: (table: string) => { if (table === "public_growth_sweep_state") return {
      select: (columns: string) => ({ eq: (key: string, value: string) => ({ maybeSingle: () => mocks.inspect(columns, key, value) }) }),
    };
    if (table !== "app_events") throw new Error("Unexpected table");
    return {
      insert: (record: unknown) => ({ select: () => ({ single: () => mocks.event(record) }) }),
      select: (columns: string) => ({ eq: (key: string, value: string) => ({ maybeSingle: () => mocks.journal(columns, key, value) }) }),
    }; },
}) }));
vi.mock("@/lib/publicGrowth/federalDiscovery", () => ({ discoverFederalCompany: mocks.worker }));
vi.mock("@/lib/publicGrowth/sweepState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/publicGrowth/sweepState")>();
  return { ...actual, beginPublicGrowthSweep: mocks.begin, checkpointPublicGrowthSweep: mocks.checkpoint,
    completePublicGrowthSweep: mocks.complete, failPublicGrowthSweep: mocks.fail };
});
import { GET } from "./route";
import { PublicGrowthSweepBusyError } from "@/lib/publicGrowth/sweepState";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, status = "no_candidate", httpStatus: number | null = null) => ({
  companyId: id(n), status, reason: status === "error" ? "provider_error" : "bounded_search", stage: "initial_award_search",
  elapsedMs: 10, sourceRequests: 1, verified: status === "matched", historyComplete: false, exhaustive: false, httpStatus, mayHaveWritten: false,
});
const request = (query = "", headers: Record<string, string> = { "x-cron-secret": "test-secret" }) =>
  new NextRequest(`https://example.test/api/cron/federal-discovery${query}`, { headers });
const retry = (n: number) => ({ companyId: id(n), failureAttempts: 1, queuedAt: "2026-09-15T00:00:00Z",
  lastAttemptedAt: "2026-09-15T00:00:00Z", firstFailedAt: "2026-09-15T00:00:00Z", lastError: "provider_error", awardContinuation: null });
const timeoutRow = (n: number) => ({ ...row(n, "error"), reason: "request_timeout", stage: "award_search" });
const timeoutState = (n: number, count = 2, strategy = "name-only-v1", stage = "award_search") => ({
  companyId: id(n), strategy, stage, timeoutCount: count, firstObservedAt: "2026-09-14T00:00:00Z",
  lastObservedAt: "2026-09-14T00:05:00Z", heldAt: count === 2 ? "2026-09-14T00:05:00Z" : null,
});

const readbackHold = (ids = [id(1)]) => ({
  version: 1, status: "unresolved", reason: "interrupted_wave_outcome_unknown",
  originalEventId: id(900), companyIds: ids, evidenceSha256: "a".repeat(64),
  observedAt: "2026-09-14T10:00:00.123456Z", heldAt: "2026-09-14T10:01:00.000000Z",
});
const searchContinuation = (n: number, page = 2) => ({ version: 1, companyId: id(n), companyIdentity: "frozen-company",
  searchEndDate: "2026-09-15", targets: [{ query: "Acme", identity: null }], targetIndex: 0, page,
  candidate: null, lastPageHash: "a".repeat(64) });
const retryJournal = (ns = [2, 3], hold = readbackHold([id(1)])) => ({
  id: id(901), module: "headhunter", kind: "federal.discovery.attempts", entity_type: "cron",
  meta: { source: "federal-discovery", requestStrategy: "name-only-v1", attemptedAt: "2026-09-15T00:00:00Z",
    attemptedCompanies: ns.map((n) => ({ ...row(n, "in_progress"), reason: "candidate_search_continues", stage: "award_search", continuation: searchContinuation(n) })),
    newStrategyHeldCompanyIds: [], heldStrategyCompanies: 0, strategyHoldReason: "second_identical_request_timeout",
    unresolvedReadbackCompanyIds: hold.companyIds, unresolvedReadbackCompanies: hold.companyIds.length,
    readbackHoldStatus: hold.status, readbackHoldReason: hold.reason, coverageVerified: false, historyComplete: false },
});

describe("federal discovery managed admission", () => {
  let lease: { source: string; offset: number; batchSize: number; managed: boolean; token: string; leaseUntil: string; cursor: Record<string, unknown> };
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-secret"); vi.stubEnv("TAM_GROWTH_SWEEP_SECRET", "growth-secret");
    vi.useFakeTimers(); vi.setSystemTime("2026-09-15T00:00:00Z");
    vi.clearAllMocks();
    lease = { source: "federal-discovery", offset: 0, batchSize: 20, managed: true, token: id(999),
      leaseUntil: "2026-09-15T00:06:00Z", cursor: {} };
    mocks.begin.mockResolvedValue(lease);
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch }; });
    mocks.complete.mockResolvedValue(0); mocks.fail.mockResolvedValue(true);
    mocks.event.mockImplementation(async (record) => ({ data: { id: record.id, meta: record.meta }, error: null }));
    mocks.rpc.mockResolvedValue({ data: Array.from({ length: 21 }, (_, n) => ({ id: id(n + 1) })), error: null });
    mocks.inspect.mockResolvedValue({ data: { cursor: {}, last_started_at: null, last_succeeded_at: null, last_error: null, lease_until: null }, error: null });
    mocks.journal.mockResolvedValue({ data: null, error: null });
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12))));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("journals and checkpoints unfinished search pages before resuming their exact query", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const state = searchContinuation(1);
    mocks.worker.mockResolvedValueOnce({ ...row(1, "in_progress"), continuation: state });
    const first = await (await GET(request())).json();
    expect(first).toMatchObject({ inProgress: 1, pendingSearches: 1, attemptCycleComplete: false });
    expect(lease.cursor.discoveryContinuations).toEqual({ [id(1)]: state });
    expect(lease.cursor.retryQueue).toEqual([]);
    expect(mocks.event.mock.calls[0][0].meta.attemptedCompanies[0].continuation).toEqual(state);
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const final = await (await GET(request())).json();
    expect(mocks.worker.mock.calls[1][1].continuation).toEqual(state);
    expect(final.pendingSearches).toBe(0); expect(lease.cursor.discoveryContinuations).toEqual({});
  });

  it("keeps remaining recipients after the first verified enrollment", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const state = searchContinuation(1);
    mocks.worker.mockResolvedValueOnce({ ...row(1, "matched"), mayHaveWritten: true, continuation: state });
    const result = await (await GET(request())).json();
    expect(result.pendingSearches).toBe(1);
    expect(lease.cursor.discoveryContinuations).toEqual({ [id(1)]: state });
  });

  it("does not advance when the saved candidate answer differs", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    mocks.worker.mockResolvedValue({ ...row(1, "in_progress"), continuation: searchContinuation(1), candidateDecision: { outcome: "insufficient_evidence" } });
    mocks.event.mockImplementation(async (record) => {
      const meta = structuredClone(record.meta); meta.attemptedCompanies[0].candidateDecision = { outcome: "same_company" };
      return { data: { id: record.id, meta }, error: null };
    });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryContinuations).toBeUndefined();
  });

  it("does not advance a page when its exact continuation journal readback differs", async () => {
    const before = searchContinuation(1), next = searchContinuation(1, 3);
    lease.cursor = { discoveryContinuations: { [id(1)]: before } };
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.worker.mockResolvedValue({ ...row(1, "in_progress"), continuation: next });
    mocks.event.mockImplementation(async (record) => {
      const meta = structuredClone(record.meta); meta.attemptedCompanies[0].continuation.page = 9;
      return { data: { id: record.id, meta }, error: null };
    });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryContinuations).toEqual({ [id(1)]: before });
    expect(lease.cursor.discoveryInFlight).toEqual([id(1)]);
  });

  it("accepts the same exact continuation after JSONB reorders nested object keys", async () => {
    const state = searchContinuation(1);
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    mocks.worker.mockResolvedValue({ ...row(1, "in_progress"), continuation: state });
    const reorder = (value: unknown): unknown => Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => b.localeCompare(a))
          .map(([key, child]) => [key, reorder(child)]))
        : value;
    mocks.event.mockImplementation(async (record) => ({
      data: { id: record.id, meta: reorder(record.meta) }, error: null,
    }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inProgress: 1, pendingSearches: 1, attemptCycleComplete: false });
    expect(lease.cursor.discoveryContinuations).toEqual({ [id(1)]: state });
    expect(lease.cursor.discoveryInFlight).toEqual([]);
  });

  it("resumes an exact saved no-write retry wave once without provider replay or changing the original hold", async () => {
    const hold = readbackHold([id(1)]), heldRetry = { ...retry(1), extraEvidence: { unchanged: true } };
    const journal = retryJournal([2, 3, 4, 5], hold);
    const unrelatedDead = { companyId: id(8), totalFailures: 3, firstFailedAt: "2026-09-13T00:00:00Z",
      lastFailedAt: "2026-09-14T00:00:00Z", lastError: "prior_error", deadLetteredAt: "2026-09-14T00:00:00Z",
      resolvedAt: null, occurrences: 1, awardContinuation: null, extraEvidence: { preserve: [1, 2] } };
    lease.cursor = { discoveryReadbackHold: hold, discoveryInFlight: [2, 3, 4, 5].map(id), discoveryInFlightEventId: journal.id,
      retryQueue: [heldRetry, ...[2, 3, 4, 5].map(retry), { ...retry(6), extraEvidence: { keep: true } }],
      deadLetters: [unrelatedDead], discoveryAttemptsTotal: 77, afterCompanyId: id(20), historicalField: { untouched: true } };
    mocks.journal.mockResolvedValue({ data: journal, error: null });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "journaled_retry_search_resumed", checked: 0, resumedAttempts: 4,
      sourceRequests: 0, journaledSourceRequests: 4, providerReplay: false, pendingSearches: 4,
      afterCompanyId: id(20), historyComplete: false, attemptCycleComplete: false });
    expect(mocks.journal).toHaveBeenCalledWith("id,module,kind,entity_type,meta", "id", journal.id);
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.checkpoint).toHaveBeenCalledTimes(1); expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(lease.cursor.discoveryAttemptsTotal).toBe(81); expect(lease.cursor.discoveryInFlight).toEqual([]);
    expect(lease.cursor.discoveryInFlightEventId).toBeNull(); expect(lease.cursor.afterCompanyId).toBe(id(20));
    expect(lease.cursor.discoveryReadbackHold).toEqual(hold); expect(lease.cursor.deadLetters).toEqual([unrelatedDead]);
    expect(lease.cursor.retryQueue).toEqual([heldRetry, { ...retry(6), extraEvidence: { keep: true } }]);
    expect(lease.cursor.historicalField).toEqual({ untouched: true });
    expect(lease.cursor.discoveryLastJournalResume).toMatchObject({ eventId: journal.id, companyIds: [2, 3, 4, 5].map(id) });
    for (const n of [2, 3, 4, 5]) expect((lease.cursor.discoveryContinuations as any)[id(n)]).toEqual(searchContinuation(n));
    // A later normal invocation resumes those saved pages and credits only its
    // own fresh outcomes; it never consumes the old journal for a second time.
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await GET(request("?limit=4"));
    expect(mocks.journal).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([2, 3, 4, 5].map(id));
    expect(mocks.worker.mock.calls[0][1].continuation).toEqual(searchContinuation(2));
    expect(lease.cursor.discoveryAttemptsTotal).toBe(85);
    expect(lease.cursor.discoveryReadbackHold).toEqual(hold);
  });

  it.each(["missing", "wrong-kind", "different-id", "array-order", "mixed-outcome", "possible-write", "bad-continuation", "changed-hold",
    "not-retry", "held-id", "already-resumed", "uncertain", "future-journal"])("retains the fence for unsupported journal resume: %s", async (failure) => {
    const hold = readbackHold([id(1)]), journal = retryJournal();
    lease.cursor = { discoveryReadbackHold: hold, discoveryInFlight: [id(2), id(3)], discoveryInFlightEventId: journal.id,
      retryQueue: [retry(2), retry(3)], discoveryAttemptsTotal: 77, afterCompanyId: id(20) };
    if (failure === "wrong-kind") journal.kind = "unrelated";
    if (failure === "different-id") journal.meta.attemptedCompanies[0].companyId = id(4);
    if (failure === "array-order") journal.meta.attemptedCompanies.reverse();
    if (failure === "mixed-outcome") journal.meta.attemptedCompanies[0].status = "matched";
    if (failure === "possible-write") journal.meta.attemptedCompanies[0].mayHaveWritten = true;
    if (failure === "bad-continuation") journal.meta.attemptedCompanies[0].continuation.page = -1;
    if (failure === "changed-hold") journal.meta.unresolvedReadbackCompanyIds = [];
    if (failure === "not-retry") lease.cursor.retryQueue = [retry(2)];
    if (failure === "held-id") lease.cursor.discoveryReadbackHold = readbackHold([id(2)]);
    if (failure === "already-resumed") lease.cursor.discoveryLastJournalResume = { eventId: journal.id };
    if (failure === "uncertain") lease.cursor.discoveryUncertainOutcomes = [{ companyId: id(2), mayHaveWritten: true }];
    if (failure === "future-journal") journal.meta.attemptedAt = "2026-09-16T00:00:00Z";
    mocks.journal.mockResolvedValue({ data: failure === "missing" ? null : journal, error: null });
    const before = structuredClone(lease.cursor);
    expect((await GET(request())).status).toBe(409);
    expect(lease.cursor).toEqual(before); expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.checkpoint).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });

  it("keeps journal resume atomic when its fenced checkpoint fails", async () => {
    const hold = readbackHold([id(1)]), journal = retryJournal();
    lease.cursor = { discoveryReadbackHold: hold, discoveryInFlight: [id(2), id(3)], discoveryInFlightEventId: journal.id,
      retryQueue: [retry(2), retry(3)], discoveryAttemptsTotal: 77, afterCompanyId: id(20) };
    const before = structuredClone(lease.cursor);
    mocks.journal.mockResolvedValue({ data: journal, error: null });
    mocks.checkpoint.mockRejectedValue(new Error("lost lease"));
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor).toEqual(before); expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("does not consume or credit the saved journal again after completion fails beyond the atomic checkpoint", async () => {
    const hold = readbackHold([id(1)]), journal = retryJournal();
    lease.cursor = { discoveryReadbackHold: hold, discoveryInFlight: [id(2), id(3)], discoveryInFlightEventId: journal.id,
      retryQueue: [retry(2), retry(3)], discoveryAttemptsTotal: 77, afterCompanyId: id(20) };
    mocks.journal.mockResolvedValue({ data: journal, error: null });
    mocks.complete.mockRejectedValueOnce(new Error("completion unavailable"));
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryAttemptsTotal).toBe(79); expect(lease.cursor.discoveryInFlight).toEqual([]);
    expect(lease.cursor.discoveryLastJournalResume).toMatchObject({ eventId: journal.id });
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await GET(request("?limit=2"))).status).toBe(200);
    expect(mocks.journal).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(2), id(3)]);
    expect(lease.cursor.discoveryAttemptsTotal).toBe(81); expect(lease.cursor.discoveryReadbackHold).toEqual(hold);
  });

  it("retains held search continuations without admitting them or clearing their debt", async () => {
    const state = searchContinuation(1), hold = readbackHold([id(1)]);
    lease.cursor = { discoveryContinuations: { [id(1)]: state }, discoveryReadbackHold: hold, retryQueue: [retry(1)] };
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const result = await (await GET(request())).json();
    expect(result.pendingSearches).toBe(1); expect(result.attemptCycleComplete).toBe(false);
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(lease.cursor.discoveryContinuations).toEqual({ [id(1)]: state });
    expect(lease.cursor.discoveryReadbackHold).toEqual(hold); expect(lease.cursor.retryQueue).toEqual([retry(1)]);
  });

  it("keeps a failed page under retry/dead-letter admission instead of repeatedly draining pending searches", async () => {
    const state = searchContinuation(1);
    lease.cursor = { discoveryContinuations: { [id(1)]: state }, retryQueue: [retry(1)] };
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.worker.mockResolvedValue({ ...row(1, "error"), continuation: state });
    const result = await (await GET(request())).json();
    expect(result.retryChecked).toBe(1); expect(result.pendingSearches).toBe(1);
    expect((lease.cursor.retryQueue as any[])[0].failureAttempts).toBe(2);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
  });

  it("readback holds exclude retry and main IDs while other retry outcomes preserve held debt and evidence", async () => {
    const hold = readbackHold([id(1), id(3)]);
    const heldRetry = { ...retry(1), retainedEvidence: { requestUnknown: true } };
    const dead = { companyId: id(3), totalFailures: 3, firstFailedAt: "2026-09-13T00:00:00Z",
      lastFailedAt: "2026-09-14T00:00:00Z", lastError: "prior_error", deadLetteredAt: "2026-09-14T00:00:00Z",
      resolvedAt: null, occurrences: 1, awardContinuation: null, retainedEvidence: { immutable: [1, 2] } };
    lease.cursor = { discoveryReadbackHold: hold, retryQueue: [heldRetry, retry(2)], deadLetters: [dead],
      discoveryAttemptsTotal: 120, lastHistoricalEvidence: { exact: ["preserved"] } };
    mocks.rpc.mockResolvedValue({ data: [1, 2, 3, 4].map((n) => ({ id: id(n) })), error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(2), id(4)]);
    expect(body.retryChecked).toBe(1); expect(body.mainChecked).toBe(1); expect(body.sourceRequests).toBe(2);
    expect(body.checked).toBe(2); expect(body.retryRemaining).toBe(1);
    expect(body.readbackHeldRetryExcluded).toBe(1); expect(body.heldRetryExcluded).toBe(0);
    expect(body.skippedUncertainCompanyIds).toEqual([id(1), id(3)]); expect(body.skippedHeldCount).toBe(0);
    expect(body.selectionCycleComplete).toBe(true); expect(body.attemptCycleComplete).toBe(false);
    expect(mocks.complete.mock.calls[0][1].done).toBe(false);
    expect(lease.cursor.retryQueue).toEqual([heldRetry]); expect(lease.cursor.deadLetters).toEqual([dead]);
    expect(lease.cursor.discoveryReadbackHold).toEqual(hold); expect(lease.cursor.lastHistoricalEvidence).toEqual({ exact: ["preserved"] });
    expect(lease.cursor.discoveryAttemptsTotal).toBe(122);
    expect(mocks.event.mock.calls.flatMap(([e]) => e.meta.attemptedCompanies.map((r: { companyId: string }) => r.companyId))).toEqual([id(2), id(4)]);
    expect(mocks.event.mock.calls[0][0].meta.skippedUncertainCount).toBe(2);
  });

  it("an uppercase strategy-held retry stays excluded with exact evidence while healthy work continues", async () => {
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const strategy = { ...timeoutState(1), companyId: upper };
    const debt = { ...retry(1), companyId: upper, retainedEvidence: { preserve: ["exact"] } };
    lease.cursor = { discoveryStrategyTimeouts: [strategy], retryQueue: [debt], discoveryAttemptsTotal: 41 };
    // The selector uses canonical UUID spelling; both admissions must agree.
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }, { id: upper.toLowerCase() }], error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(2)]);
    expect(body.checked).toBe(1); expect(body.mainChecked).toBe(1); expect(body.retryChecked).toBe(0);
    expect(body.heldRetryExcluded).toBe(1); expect(body.skippedHeldCompanyIds).toEqual([upper.toLowerCase()]);
    expect(body.readbackHeldRetryExcluded).toBe(0); expect(body.unresolvedReadbackCompanies).toBe(0);
    expect(body.skippedUncertainCompanyIds).toEqual([]); expect(body.attemptCycleComplete).toBe(false);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([strategy]); expect(lease.cursor.retryQueue).toEqual([debt]);
    expect(lease.cursor.discoveryAttemptsTotal).toBe(42);
    expect(mocks.event.mock.calls.flatMap(([event]) => event.meta.attemptedCompanies.map((r: { companyId: string }) => r.companyId))).toEqual([id(2)]);
    mocks.inspect.mockResolvedValue({ data: { cursor: lease.cursor }, error: null });
    const inspected = await (await GET(request("?inspect=1"))).json();
    expect(inspected.heldCompanyIds).toEqual([upper]);
    expect(inspected.strategyTimeoutCounts[0].companyId).toBe(upper);
  });

  it("a legacy uppercase retry UUID cannot bypass the lowercase exact readback hold", async () => {
    const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const originalRetry = { ...retry(1), companyId: lower.toUpperCase() };
    lease.cursor = { discoveryReadbackHold: readbackHold([lower]), retryQueue: [originalRetry] };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }], error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(2)]);
    expect(body.readbackHeldRetryExcluded).toBe(1); expect(lease.cursor.retryQueue).toEqual([originalRetry]);
  });

  it("an all-readback-held page advances only its selected prefix with no attempts, journal, or debt change", async () => {
    const hold = readbackHold([id(1), id(2), id(3), id(4)]);
    lease.cursor = { discoveryReadbackHold: hold, retryQueue: [retry(1)], discoveryAttemptsTotal: 51 };
    mocks.rpc.mockResolvedValue({ data: [1, 2, 3, 4, 5].map((n) => ({ id: id(n) })), error: null });
    const before = structuredClone(lease.cursor);
    const body = await (await GET(request("?limit=4"))).json();
    expect(body.afterCompanyId).toBe(id(4)); expect(body.selectionCycleComplete).toBe(false);
    expect(body.skippedUncertainCompanyIds).toEqual(hold.companyIds); expect(body.skippedUncertainCount).toBe(4);
    expect(body.checked).toBe(0); expect(body.sourceRequests).toBe(0); expect(body.skippedUncertainAreAttempts).toBe(false);
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    expect(lease.cursor.discoveryAttemptsTotal).toBe(51); expect(lease.cursor.retryQueue).toEqual(before.retryQueue);
    expect(lease.cursor.discoveryReadbackHold).toEqual(hold); expect(mocks.complete.mock.calls[0][1].done).toBe(false);
    expect(lease.cursor.discoverySkippedUncertainCompanyIds).not.toContain(id(5));
  });

  it("a mixed readback-held prefix never jumps an unattempted eligible ID or lookahead", async () => {
    lease.cursor = { discoveryReadbackHold: readbackHold([id(1), id(3)]) };
    mocks.rpc.mockResolvedValue({ data: [1, 2, 3, 4].map((n) => ({ id: id(n) })), error: null });
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch };
      if (patch.discoveryInFlight?.length) vi.setSystemTime(Date.now() + 240_000); });
    const body = await (await GET(request("?limit=3"))).json();
    expect(body.checked).toBe(0); expect(body.afterCompanyId).toBe(id(1));
    expect(body.notAttemptedCompanyIds).toEqual([id(2)]); expect(body.skippedUncertainCompanyIds).toEqual([id(1), id(3)]);
    expect(body.selectionCycleComplete).toBe(false); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("readback and strategy categories remain distinct even when the same ID has both holds", async () => {
    const strategies = [timeoutState(1), timeoutState(2)];
    lease.cursor = { discoveryReadbackHold: readbackHold([id(1)]), discoveryStrategyTimeouts: strategies,
      retryQueue: [retry(1), retry(2)] };
    mocks.rpc.mockResolvedValue({ data: [1, 2, 3].map((n) => ({ id: id(n) })), error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(3)]);
    expect(body.skippedUncertainCompanyIds).toEqual([id(1)]); expect(body.skippedHeldCompanyIds).toEqual([id(2)]);
    expect(body.readbackHeldRetryExcluded).toBe(1); expect(body.heldRetryExcluded).toBe(1);
    expect(body.heldStrategyCompanies).toBe(2); expect(body.unresolvedReadbackCompanies).toBe(1);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual(strategies); expect(lease.cursor.retryQueue).toEqual([retry(1), retry(2)]);
  });

  it("unrelated-page completion and later wraps cannot resolve a readback hold by time, success or strategy", async () => {
    const hold = readbackHold([id(1)]);
    lease.cursor = { discoveryReadbackHold: hold, discoveryStrategyTimeouts: [timeoutState(1, 2, "older-strategy")] };
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: id(2) }], error: null })
      .mockResolvedValueOnce({ data: [{ id: id(1) }], error: null });
    const first = await (await GET(request())).json();
    expect(first.selectionCycleComplete).toBe(true); expect(first.attemptCycleComplete).toBe(false);
    expect(first.coverageVerified).toBe(false); expect(first.historyComplete).toBe(false);
    expect(mocks.complete.mock.calls[0][1].done).toBe(false);
    // Model the real helper's persisted wrap (the test complete stub is read-only).
    lease.cursor.afterCompanyId = first.afterCompanyId;
    vi.setSystemTime("2030-09-15T00:00:00Z"); mocks.worker.mockClear();
    const second = await (await GET(request())).json();
    expect(second.checked).toBe(0); expect(second.skippedUncertainCompanyIds).toEqual([id(1)]);
    expect(second.attemptCycleComplete).toBe(false); expect(lease.cursor.discoveryReadbackHold).toEqual(hold);
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { ...readbackHold(), version: 2 }, { ...readbackHold(), status: "resolved" },
    { ...readbackHold(), reason: "timeout" }, { ...readbackHold(), companyIds: [] },
    { ...readbackHold(), companyIds: [id(1), id(1)] }, { ...readbackHold(), companyIds: [1, 2, 3, 4, 5].map(id) },
    { ...readbackHold(), companyIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] },
    { ...readbackHold(), originalEventId: "invalid" }, { ...readbackHold(), evidenceSha256: "a".repeat(63) },
    { ...readbackHold(), observedAt: "2026-02-30T00:00:00Z" },
    { ...readbackHold(), heldAt: "2026-09-14T10:00:00.123455Z" },
    { ...readbackHold(), observedAt: "2026-09-14T10:00:00.1234567Z" },
    { ...readbackHold(), heldAt: "2026-09-14T10:01:00+00:00" },
    { ...readbackHold(), extra: "https://private.example" },
  ])("rejects malformed readback hold before selection/provider work and in inspection: %j", async (bad) => {
    lease.cursor.discoveryReadbackHold = bad;
    expect((await GET(request())).status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.checkpoint).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    mocks.inspect.mockResolvedValue({ data: { cursor: { discoveryReadbackHold: bad } }, error: null });
    const response = await GET(request("?inspect=1")); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private.example");
  });

  it("inspection returns only bounded readback hold IDs/status/counts without its private evidence fields", async () => {
    const hold = readbackHold([id(1), id(2)]);
    mocks.inspect.mockResolvedValue({ data: { cursor: { discoveryReadbackHold: hold }, last_error: "secret", lease_token: "private" }, error: null });
    const body = await (await GET(request("?inspect=1"))).json();
    expect(body.unresolvedReadbackCompanyIds).toEqual(hold.companyIds); expect(body.unresolvedReadbackCompanies).toBe(2);
    expect(body.readbackHoldStatus).toBe("unresolved"); expect(body.readbackHoldReason).toBe(hold.reason);
    expect(body.heldStrategyCompanies).toBe(0); expect(body.historyComplete).toBe(false); expect(body.attemptCycleComplete).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/secret|private|originalEventId|evidenceSha256/);
    for (const f of [mocks.begin, mocks.checkpoint, mocks.complete, mocks.fail, mocks.worker, mocks.event]) expect(f).not.toHaveBeenCalled();
  });

  it.each([id(1), id(4)])("a fresh in-flight fence remains a global stop even with existing hold: %s", async (freshId) => {
    const hold = readbackHold([id(1)]);
    lease.cursor = { discoveryReadbackHold: hold, discoveryInFlight: [freshId], discoveryInFlightEventId: id(901), discoveryAttemptsTotal: 77 };
    const before = structuredClone(lease.cursor);
    expect((await GET(request())).status).toBe(409);
    expect(lease.cursor).toEqual(before); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.checkpoint).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["journal", "checkpoint", "readback-metadata"])("failed %s verification preserves a fresh fence and the old hold", async (failure) => {
    const hold = readbackHold([id(1)]);
    lease.cursor = { discoveryReadbackHold: hold, discoveryAttemptsTotal: 77 };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }], error: null });
    if (failure === "journal") mocks.event.mockResolvedValue({ data: null, error: { message: "unknown" } });
    if (failure === "readback-metadata") mocks.event.mockImplementation(async (record) => ({ data: { id: record.id,
      meta: { ...record.meta, unresolvedReadbackCompanyIds: [] } }, error: null }));
    if (failure === "checkpoint") mocks.checkpoint.mockImplementation(async (_lease, patch) => {
      if (patch.afterCompanyId) throw new Error("unknown"); lease.cursor = { ...lease.cursor, ...patch };
    });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryInFlight).toEqual([id(2)]); expect(lease.cursor.discoveryReadbackHold).toEqual(hold);
    expect(lease.cursor.discoveryAttemptsTotal).toBe(77); expect(mocks.complete).not.toHaveBeenCalled();
    mocks.worker.mockClear(); expect((await GET(request())).status).toBe(409); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("an uncertain new write remains fenced without replacing or enlarging the existing manual hold", async () => {
    const hold = readbackHold([id(1)]);
    lease.cursor = { discoveryReadbackHold: hold };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }], error: null });
    mocks.worker.mockResolvedValue({ ...row(2, "error"), mayHaveWritten: true });
    const response = await GET(request()); expect(response.status).toBe(409);
    expect(lease.cursor.discoveryInFlight).toEqual([id(2)]); expect(lease.cursor.discoveryReadbackHold).toEqual(hold);
    expect(lease.cursor.retryQueue).toBeUndefined(); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("rejects absent/query credentials and accepts only configured header or bearer secrets", async () => {
    expect((await GET(request("", {}))).status).toBe(401);
    expect((await GET(request("?secret=test-secret", {}))).status).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await GET(request("", { authorization: "Bearer growth-secret" }))).status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith("federal-discovery", 20, null);
  });

  it("refuses cursor resets, explicit IDs, invalid limits and oversized selection", async () => {
    for (const q of ["?offset=0", "?companyId="+id(1), "?limit=0", "?limit=21", "?limit=1.5", "?limit=no"]) {
      expect((await GET(request(q))).status).toBe(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: Array.from({ length: 22 }, (_, n) => ({ id: id(n + 1) })), error: null });
    expect((await GET(request())).status).toBe(500); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("uses one lookahead without attempting or checkpointing it", async () => {
    const body = await (await GET(request())).json();
    expect(mocks.rpc).toHaveBeenCalledWith("list_federal_discovery_tam_batch", { p_limit: 21, p_after_company_id: null });
    expect(body.checked).toBe(20); expect(body.afterCompanyId).toBe(id(20)); expect(body.attemptCycleComplete).toBe(false);
    expect(body.noCandidate).toBe(20); expect(body.coverageVerified).toBe(false); expect(body.historyComplete).toBe(false);
    expect(mocks.worker.mock.calls.some(([n]) => n === id(21))).toBe(false);
    expect(mocks.complete.mock.calls[0][1].advanceCursor).toBe(false);
  });

  it("wraps only an exhausted attempted page and labels it attempt completion", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const body = await (await GET(request())).json();
    expect(body.attemptCycleComplete).toBe(true); expect(body.afterCompanyId).toBeNull(); expect(body.coverageVerified).toBe(false);
  });

  it("persists exact error and ambiguous debt with keyset in the same fenced checkpoint", async () => {
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12)), companyId === id(2) ? "ambiguous" : companyId === id(1) ? "error" : "matched"));
    const body = await (await GET(request())).json();
    expect(body.errors).toBe(1); expect(body.ambiguous).toBe(1); expect(body.matched).toBe(18);
    expect(body.retryRemaining).toBe(2);
    const checkpoint = mocks.checkpoint.mock.calls.find(([, p]) => p.afterCompanyId === id(4))?.[1];
    expect(checkpoint.retryQueue.map((r: { companyId: string }) => r.companyId)).toEqual([id(1), id(2)]);
    expect(checkpoint.discoveryInFlight).toEqual([]);
  });

  it("serves exact retry debt first and does not duplicate an ID on its main page", async () => {
    lease.cursor = { retryQueue: [retry(1)], deadLetters: [] };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }, { id: id(2) }], error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([n]) => n)).toEqual([id(1), id(2)]);
    expect(body.retryChecked).toBe(1); expect(body.mainChecked).toBe(1); expect(body.retryRemaining).toBe(0);
  });

  it("holds the second identical timeout and continues healthy main companies", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [1, 2, 3].map((n) => ({ id: id(n) })), error: null })
      .mockResolvedValueOnce({ data: [3, 4].map((n) => ({ id: id(n) })), error: null })
      .mockResolvedValueOnce({ data: [4, 5, 6].map((n) => ({ id: id(n) })), error: null });
    mocks.worker.mockImplementation(async (companyId) => companyId === id(1) ? timeoutRow(1) : row(Number(companyId.slice(-12))));
    const first = await (await GET(request("?limit=2"))).json();
    expect(first.heldStrategyCompanies).toBe(0);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([expect.objectContaining({ companyId: id(1), timeoutCount: 1, heldAt: null })]);
    vi.setSystemTime("2026-09-15T00:05:00Z");
    const second = await (await GET(request("?limit=2"))).json();
    expect(second.heldStrategyCompanies).toBe(1); expect(second.mainChecked).toBe(1); expect(second.retryChecked).toBe(1);
    expect(lease.cursor.retryQueue).toEqual([expect.objectContaining({ companyId: id(1), failureAttempts: 2 })]);
    const event = mocks.event.mock.calls[1][0];
    expect(event.meta.requestStrategy).toBe("name-only-v1"); expect(event.meta.newStrategyHeldCompanyIds).toEqual([id(1)]);
    expect(event.meta.strategyHoldReason).toBe("second_identical_request_timeout");
    mocks.worker.mockClear(); vi.setSystemTime("2027-09-15T00:00:00Z");
    const third = await (await GET(request("?limit=2"))).json();
    expect(mocks.worker.mock.calls.map(([companyId]) => companyId)).toEqual([id(4), id(5)]);
    expect(third.heldRetryExcluded).toBe(1); expect(third.checked).toBe(2); expect(third.heldStrategyCompanies).toBe(1);
  });

  it.each(["no_candidate", "matched"])("a completed %s result resets an unheld timeout streak", async (status) => {
    lease.cursor = { retryQueue: [retry(1)], discoveryStrategyTimeouts: [timeoutState(1, 1)] };
    mocks.worker.mockResolvedValueOnce({ ...row(1, status), stage: "award_search" }).mockResolvedValueOnce(timeoutRow(1));
    await GET(request("?limit=1"));
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([expect.objectContaining({ timeoutCount: 0, heldAt: null, lastResetAt: expect.any(String) })]);
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }, { id: id(2) }], error: null });
    const next = await (await GET(request("?limit=1"))).json();
    expect(next.heldStrategyCompanies).toBe(0);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([expect.objectContaining({ timeoutCount: 1, heldAt: null })]);
  });

  it("does not seed named strategy counts from untagged legacy failures or a different stage", async () => {
    lease.cursor = { retryQueue: [{ ...retry(1), failureAttempts: 2, lastError: "award_search:request_timeout" }],
      discoveryStrategyTimeouts: [timeoutState(1, 1, "name-only-v1", "award_detail")] };
    mocks.worker.mockResolvedValue(timeoutRow(1));
    const body = await (await GET(request("?limit=1"))).json();
    expect(body.heldStrategyCompanies).toBe(0); expect(body.unresolvedDeadLetters).toBe(1);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([timeoutState(1, 1, "name-only-v1", "award_detail"),
      expect.objectContaining({ companyId: id(1), stage: "award_search", timeoutCount: 1, heldAt: null })]);
  });

  it("held retry and main IDs make zero provider calls and preserve failure evidence", async () => {
    const originalRetry = retry(1);
    lease.cursor = { retryQueue: [originalRetry], discoveryStrategyTimeouts: [timeoutState(1)] };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(0); expect(body.skippedHeldCompanyIds).toEqual([id(1)]); expect(body.skippedHeldCount).toBe(1);
    expect(body.heldRetryExcluded).toBe(1); expect(body.skippedHeldAreAttempts).toBe(false);
    expect(body.selectionCycleComplete).toBe(true); expect(body.attemptCycleComplete).toBe(false); expect(body.afterCompanyId).toBeNull();
    expect(mocks.complete.mock.calls[0][1].done).toBe(false);
    expect(mocks.worker).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
    expect(lease.cursor.retryQueue).toEqual([originalRetry]); expect(lease.cursor.discoveryAttemptsTotal).toBeUndefined();
  });

  it("advances an all-held page but neither its lookahead nor attempt count", async () => {
    lease.cursor = { discoveryStrategyTimeouts: Array.from({ length: 21 }, (_, n) => timeoutState(n + 1)) };
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(0); expect(body.afterCompanyId).toBe(id(20)); expect(body.skippedHeldCount).toBe(20);
    expect(body.skippedHeldCompanyIds).not.toContain(id(21)); expect(body.selectionCycleComplete).toBe(false);
    expect(lease.cursor.afterCompanyId).toBe(id(20)); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("a held prefix does not advance over an unattempted healthy suffix", async () => {
    lease.cursor = { discoveryStrategyTimeouts: [timeoutState(1)] };
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch };
      if (patch.discoveryInFlight?.length) vi.setSystemTime(Date.now() + 240_000); });
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(0); expect(body.afterCompanyId).toBe(id(1)); expect(body.skippedHeldCompanyIds).toEqual([id(1)]);
    expect(body.notAttemptedCompanyIds).toHaveLength(19); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("retains a prior strategy hold as history without applying it to the current strategy", async () => {
    const old = timeoutState(1, 2, "older-name-strategy");
    lease.cursor = { discoveryStrategyTimeouts: [old] };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(1); expect(body.heldStrategyCompanies).toBe(0);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([old]);
  });

  it.each([null, {}, [timeoutState(1), timeoutState(1)], [{ ...timeoutState(1), timeoutCount: 3 }]])("malformed strategy state fails closed: %j", async (bad) => {
    lease.cursor.discoveryStrategyTimeouts = bad;
    expect((await GET(request())).status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("journal failure never applies a second-timeout hold or clears its in-flight fence", async () => {
    lease.cursor = { retryQueue: [retry(1)], discoveryStrategyTimeouts: [timeoutState(1, 1)] };
    mocks.worker.mockResolvedValue(timeoutRow(1)); mocks.event.mockResolvedValue({ data: null, error: { message: "unknown" } });
    expect((await GET(request("?limit=1"))).status).toBe(500);
    expect(lease.cursor.discoveryStrategyTimeouts).toEqual([timeoutState(1, 1)]);
    expect(lease.cursor.discoveryInFlight).toEqual([id(1)]);
    mocks.worker.mockClear(); expect((await GET(request("?limit=1"))).status).toBe(409);
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("inspection is authenticated, exclusive and never acquires or mutates state", async () => {
    expect((await GET(request("?inspect=1", {}))).status).toBe(401);
    for (const q of ["?inspect=0", "?inspect=1&limit=20", "?inspect=1&inspect=1", "?inspect=1&companyId="+id(1)]) {
      expect((await GET(request(q))).status).toBe(400);
    }
    expect(mocks.inspect).not.toHaveBeenCalled();
    mocks.inspect.mockResolvedValue({ data: { cursor: { afterCompanyId: id(4), discoveryAttemptsTotal: 20,
      retryQueue: [retry(1)], discoveryStrategyTimeouts: [timeoutState(1)], discoveryInFlight: [id(3)] },
      last_started_at: "2026-09-15T00:00:00Z", last_succeeded_at: null, lease_until: "2026-09-15T00:06:00Z",
      last_error: "raw error https://secret.example", lease_token: "never expose", extra: "untrusted" }, error: null });
    const body = await (await GET(request("?inspect=1"))).json();
    expect(body.readOnly).toBe(true); expect(body.afterCompanyId).toBe(id(4)); expect(body.retryCompanyIds).toEqual([id(1)]);
    expect(body.heldCompanyIds).toEqual([id(1)]); expect(body.inFlightCompanyIds).toEqual([id(3)]); expect(body.errorPresent).toBe(true);
    expect(body.leaseUntil).toBe("2026-09-15T00:06:00Z"); expect(body.attemptsTotal).toBe(20);
    expect(mocks.inspect).toHaveBeenCalledWith("cursor,last_started_at,last_succeeded_at,last_error,lease_until", "source", "federal-discovery");
    expect(JSON.stringify(body)).not.toMatch(/secret\.example|never expose|untrusted|last_error|lease_token/);
    for (const operation of [mocks.begin, mocks.checkpoint, mocks.complete, mocks.fail, mocks.worker, mocks.event, mocks.rpc]) expect(operation).not.toHaveBeenCalled();
  });

  it("inspection rejects malformed cursor data without exposing raw contents or writing", async () => {
    mocks.inspect.mockResolvedValue({ data: { cursor: { discoveryInFlight: ["https://private.example"] } }, error: null });
    const response = await GET(request("?inspect=1")); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private.example");
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.fail).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("429 stops new waves and persists source backoff with exact debt", async () => {
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12)), companyId === id(1) ? "error" : "no_candidate", companyId === id(1) ? 429 : null));
    const response = await GET(request()); const body = await response.json();
    expect(response.status).toBe(429); expect(body.checked).toBe(4); expect(body.afterCompanyId).toBe(id(4));
    expect(body.notAttemptedCompanyIds).toHaveLength(16); expect(body.errors).toBe(1);
    expect(lease.cursor.discoveryBackoffUntil).toBe("2026-09-15T00:15:00.000Z");
    expect(lease.cursor.retryQueue).toHaveLength(1);
  });

  it("an active backoff does not select companies or make source requests", async () => {
    lease.cursor.discoveryBackoffUntil = "2026-09-15T00:15:00Z";
    const response = await GET(request()); expect(response.status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("never exceeds four live company operations", async () => {
    let active = 0, peak = 0;
    mocks.worker.mockImplementation(async (companyId) => { active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10)); active--; return row(Number(companyId.slice(-12))); });
    const pending = GET(request()); await vi.runAllTimersAsync(); await pending;
    expect(peak).toBe(4);
  });

  it("clamps company deadlines and leaves runtime-expired suffix unadvanced", async () => {
    mocks.worker.mockImplementation(async (companyId, options) => {
      expect(options.deadlineMs - Date.now()).toBeLessThanOrEqual(60_000);
      await new Promise((resolve) => setTimeout(resolve, 60_000)); return row(Number(companyId.slice(-12)));
    });
    const pending = GET(request()); await vi.runAllTimersAsync(); const body = await (await pending).json();
    expect(body.checked).toBe(16); expect(body.afterCompanyId).toBe(id(16)); expect(body.notAttemptedCompanyIds).toHaveLength(4);
  });

  it("does not launch any source call when checkpointing consumes the deadline", async () => {
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch };
      if (patch.discoveryInFlight?.length) vi.setSystemTime(Date.now() + 240_000); });
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(0); expect(body.afterCompanyId).toBeNull(); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("busy lease and interrupted in-flight work make no new request", async () => {
    mocks.begin.mockRejectedValueOnce(new PublicGrowthSweepBusyError("federal-discovery", null));
    expect((await GET(request())).status).toBe(409);
    lease.cursor.discoveryInFlight = [id(1)]; expect((await GET(request())).status).toBe(409);
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("checkpoint failure retains in-flight evidence and cannot report cursor success", async () => {
    mocks.checkpoint.mockImplementation(async (_lease, patch) => {
      if (patch.afterCompanyId) throw new Error("database outage"); lease.cursor = { ...lease.cursor, ...patch };
    });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryInFlight).toEqual([id(1), id(2), id(3), id(4)]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("rejects duplicate/non-monotonic source rows before provider work", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }, { id: id(1) }], error: null });
    expect((await GET(request())).status).toBe(500); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("unknown thrown work is held for readback with unknown request count", async () => {
    mocks.worker.mockRejectedValue(new Error("not exposed"));
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const response = await GET(request()); const body = await response.json(); expect(response.status).toBe(409);
    expect(body.outcomes[0].status).toBe("error"); expect(body.outcomes[0].sourceRequests).toBeNull();
    expect(body.uncertainCompanyIds).toEqual([id(1)]); expect(JSON.stringify(body)).not.toContain("not exposed");
    expect(lease.cursor.discoveryInFlight).toEqual([id(1)]); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("journals every exact attempt and confirms it before cursor/debt advancement", async () => {
    await GET(request());
    expect(mocks.event).toHaveBeenCalledTimes(5);
    expect(mocks.event.mock.calls.flatMap(([event]) => event.meta.attemptedCompanies.map((r: { companyId: string }) => r.companyId)))
      .toEqual(Array.from({ length: 20 }, (_, n) => id(n + 1)));
    expect(mocks.event.mock.calls.every(([event]) => event.kind === "federal.discovery.attempts" && event.meta.coverageVerified === false)).toBe(true);
    expect(mocks.event.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkpoint.mock.invocationCallOrder[1]);
  });

  it("a failed or mismatched attempt journal keeps in-flight evidence and never advances", async () => {
    mocks.event.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryInFlight).toHaveLength(4); expect(mocks.complete).not.toHaveBeenCalled();
    expect(lease.cursor.afterCompanyId).toBeUndefined();
  });

  it.each(["error", "ambiguous"])("possible partial enrollment %s never enters automatic retry debt or advances its wave", async (status) => {
    mocks.worker.mockImplementation(async (companyId) => ({ ...row(Number(companyId.slice(-12)), status), mayHaveWritten: true }));
    const response = await GET(request()); const body = await response.json(); expect(response.status).toBe(409);
    expect(body.checked).toBe(4); expect(body.afterCompanyId).toBeNull(); expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(lease.cursor.discoveryUncertainOutcomes).toHaveLength(4); expect(lease.cursor.discoveryInFlight).toHaveLength(4);
    expect(lease.cursor.retryQueue).toBeUndefined(); expect(mocks.complete).not.toHaveBeenCalled();
    mocks.worker.mockClear();
    expect((await GET(request())).status).toBe(409); expect(mocks.worker).not.toHaveBeenCalled();
  });
});

describe("discovery selector migration boundary", () => {
  it("uses exact current membership and the inverse existing verified recipient/award eligibility", () => {
    const sql = readFileSync(new URL("../../../../supabase/migrations/0057_federal_discovery_selector.sql", import.meta.url), "utf8");
    expect(sql).toContain("c.status is distinct from 'removed_from_tam'");
    expect(sql).toContain("coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]");
    expect(sql).toContain("and not exists ("); expect(sql).toContain("m.match_status = 'verified'");
    expect(sql).toContain("e.usaspending_recipient_id is not null"); expect(sql).toContain("a.government_entity_id = e.id");
    expect(sql).toContain("c.id > p_after_company_id"); expect(sql).toContain("order by c.id");
    expect(sql).toContain("from public, anon, authenticated"); expect(sql).toContain("to service_role");
    expect(sql).not.toContain("reconcile_company_signal_flags"); expect(sql).not.toContain("list_public_growth_recurring_tam_batch_v2(");
  });
});
