import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), begin: vi.fn(), checkpoint: vi.fn(), fail: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("./federalDiscoverySourceOnly", async original => ({ ...await original<typeof import("./federalDiscoverySourceOnly")>(), captureFederalPendingSource: mocks.capture }));
vi.mock("./sweepState", async original => ({ ...await original<typeof import("./sweepState")>(), beginPublicGrowthSweep: mocks.begin,
  checkpointPublicGrowthSweep: mocks.checkpoint, failPublicGrowthSweep: mocks.fail }));
import { continueFederalPendingSources, federalPendingSourceSchema, inspectFederalPendingSources } from "./federalDiscoveryPending";
import { federalSourceOnlyHash } from "./federalDiscoverySourceOnly";

/* eslint-disable @typescript-eslint/no-explicit-any */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const continuation = (n: number) => ({ version: 1, companyId: id(n), companyIdentity: "a".repeat(64), searchEndDate: "2026-09-29",
  targets: [{ query: `Company ${n}`, identity: null }], targetIndex: 0, page: 1, candidate: null, lastPageHash: null,
  publicOriginalExtension: { retained: n } });
const hold = { version: 1, status: "held", reason: "reviewed_journal_capacity_recovery_requires_manual_resume",
  operationId: id(9000), journalId: id(9001), companyIds: [id(1), id(2), id(3), id(4)], evidenceSha256: "b".repeat(64),
  readerTaskId: "reader", reviewerTaskId: "reviewer", heldAt: "2026-10-07T00:00:00Z" };
let state: any, lease: any, events: any[], failures: Set<string>;
const request = (ns = [1]) => ({ operationId: id(9002), holdOperationId: hold.operationId, sourceOnly: true as const,
  continuations: ns.map(n => ({ companyId: id(n), expectedSha256: federalSourceOnlyHash(state.cursor.discoveryContinuations[id(n)]) })) });
function query(table: string) {
  if (!["public_growth_sweep_state", "app_events"].includes(table)) throw new Error(`Forbidden table ${table}`);
  const filters: Record<string, unknown> = {}; let payload: any;
  const q: any = { select: () => q, eq: (key: string, value: unknown) => { filters[key] = value; return q; }, maybeSingle: () => q,
    insert: (row: any) => { payload = structuredClone(row); return q; },
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(() => {
      if (payload) {
        events.push(payload);
        return { data: null, error: failures.has("event-write") ? { code: "uncertain" } : null };
      }
      if (table === "public_growth_sweep_state") return { data: structuredClone(state), error: null };
      const event = events.find(row => Object.entries(filters).every(([key, value]) => row[key] === value));
      return { data: structuredClone(event ?? null), error: event && failures.has("event-read") ? { code: "unavailable" } : null };
    }).then(resolve, reject) };
  return q;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  state = { cursor: { offset: 0, afterCompanyId: id(333), discoveryAttemptsTotal: 3636,
    discoveryContinuations: Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [id(n + 1), continuation(n + 1)])),
    discoveryCapacityHold: structuredClone(hold), discoveryInFlight: [], discoveryInFlightEventId: null,
    retryQueue: [], deadLetters: [], discoveryReadbackHold: { companyIds: [id(9999)], status: "unresolved" },
    preservedUnrelated: { full: [1, "raw", null] } }, lease_token: null, lease_until: null };
  events = []; failures = new Set(); mocks.from.mockImplementation(query);
  mocks.begin.mockImplementation(async (source, batchSize) => {
    if (failures.has("race")) state.cursor.discoveryContinuations[id(1)].page++;
    lease = { source, batchSize, managed: true, token: id(8000), offset: 0, cursor: structuredClone(state.cursor), leaseUntil: "2099-01-01T00:00:00Z" };
    state.lease_token = lease.token; state.lease_until = lease.leaseUntil; return lease;
  });
  mocks.checkpoint.mockImplementation(async (_lease, patch) => {
    if (failures.has("initial-checkpoint") || failures.has("final-checkpoint") && patch.discoveryContinuations) throw new Error("checkpoint uncertain");
    state.cursor = { ...state.cursor, ...structuredClone(patch), offset: lease.offset }; lease.cursor = structuredClone(state.cursor);
  });
  mocks.fail.mockImplementation(async () => { state.lease_token = null; state.lease_until = null; return true; });
  mocks.capture.mockImplementation(async (companyId, original) => ({ companyId, status: "incomplete", reason: "test_source_hold", sourceRequests: 1,
    reusedCapture: false, sourceCaptured: false, observationId: null, jobId: null, analysisComplete: false, identityVerified: false, historyComplete: false,
    continuation: { ...structuredClone(original), sourceCapture: { version: 1, status: "held", stage: "search", reason: "test_source_hold",
      observationId: null, requestSha256: null, retainedJsonSha256: null, capturedAt: null } } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("exact held federal foreground admission", () => {
  it("inspects only exact bounded retained originals and stable hashes without a lease or provider", async () => {
    const result = await inspectFederalPendingSources([id(1), id(2000)]);
    expect(result.items).toEqual([{ companyId: id(1), present: true, expectedSha256: request().continuations[0].expectedSha256,
      continuation: continuation(1) }, { companyId: id(2000), present: false, expectedSha256: null, continuation: null }]);
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("preserves all 1001 continuations, hold, debt and keyset; records exact incomplete event and releases lease", async () => {
    const before = structuredClone(state.cursor), input = request([1, 2, 3, 4]);
    const result = await continueFederalPendingSources(input);
    expect(result).toMatchObject({ eventId: input.operationId, sourceRequests: 4, operatorHoldRetained: true, analysisComplete: false,
      mainSelections: 0, retrySelections: 0, keysetAdvanced: false, attemptsCredited: 0, exactEventVerified: true, exactStateVerified: true });
    expect(mocks.begin).toHaveBeenCalledWith("federal-discovery", 4, null);
    expect(mocks.checkpoint.mock.calls[0][1]).toMatchObject({ discoveryInFlight: [id(1), id(2), id(3), id(4)], discoveryInFlightEventId: input.operationId });
    expect(Object.keys(state.cursor.discoveryContinuations)).toHaveLength(1001);
    for (const [key, value] of Object.entries(before)) if (!["discoveryContinuations", "discoveryInFlight", "discoveryInFlightEventId"].includes(key)) expect(state.cursor[key]).toEqual(value);
    for (let n = 5; n <= 1001; n++) expect(state.cursor.discoveryContinuations[id(n)]).toEqual(before.discoveryContinuations[id(n)]);
    expect(state.cursor.discoveryContinuations[id(1)].publicOriginalExtension).toEqual({ retained: 1 });
    expect(state.lease_token).toBeNull(); expect(events).toHaveLength(1);
  });
  it("same operation is readback-only and changed payload cannot retarget or fall back", async () => {
    const input = request(); await continueFederalPendingSources(input); mocks.begin.mockClear(); mocks.capture.mockClear();
    expect((await continueFederalPendingSources(input)).reusedReceipt).toBe(true);
    await expect(continueFederalPendingSources({ ...input, continuations: request([2]).continuations })).rejects.toThrow("never replay");
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
  });
  it.each(["no-hold", "wrong-hold", "changed", "missing", "in-flight", "uncertain", "backoff", "old-hold", "one-timeout", "capture-held"])("rejects unsafe scope before lease: %s", async kind => {
    const input = request();
    if (kind === "no-hold") delete state.cursor.discoveryCapacityHold;
    if (kind === "wrong-hold") input.holdOperationId = id(8001);
    if (kind === "changed") state.cursor.discoveryContinuations[id(1)].page++;
    if (kind === "missing") input.continuations[0].companyId = id(2000);
    if (kind === "in-flight") state.cursor.discoveryInFlight = [id(2)];
    if (kind === "uncertain") state.cursor.discoveryUncertainOutcomes = [{ companyId: id(2) }];
    if (kind === "backoff") state.cursor.discoveryBackoffUntil = "2099-01-01T00:00:00Z";
    if (kind === "old-hold") state.cursor.discoveryReadbackHold.companyIds = [id(1)];
    if (kind === "one-timeout") state.cursor.discoveryStrategyTimeouts = [{ companyId: id(1), timeoutCount: 1, heldAt: null }];
    if (kind === "capture-held") state.cursor.discoveryContinuations[id(1)].sourceCapture = {
      version: 1, status: "held", stage: "search", reason: "prior_failure", observationId: null, requestSha256: null, retainedJsonSha256: null, capturedAt: null };
    await expect(continueFederalPendingSources(input)).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("rechecks exact admission after obtaining the shared lease", async () => {
    failures.add("race"); await expect(continueFederalPendingSources(request())).rejects.toThrow("changed");
    expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.checkpoint).not.toHaveBeenCalled(); expect(mocks.fail).toHaveBeenCalledTimes(1);
  });
  it.each(["initial-checkpoint", "worker-uncertain", "event-write", "event-read", "final-checkpoint"])("retains uncertain boundary without retry: %s", async kind => {
    failures.add(kind);
    if (kind === "worker-uncertain") mocks.capture.mockRejectedValue(new Error("unknown observation write"));
    const input = request(); await expect(continueFederalPendingSources(input)).rejects.toThrow();
    if (kind === "initial-checkpoint") expect(mocks.capture).not.toHaveBeenCalled();
    else {
      expect(state.cursor.discoveryInFlight).toEqual([id(1)]);
      expect(state.cursor.discoverySourceOnlyOperation.request).toEqual(input);
      const count = mocks.capture.mock.calls.length;
      await expect(continueFederalPendingSources({ ...input, operationId: id(7000) })).rejects.toThrow();
      expect(mocks.capture).toHaveBeenCalledTimes(count);
    }
  });
  it("preserves earlier outcomes if a later selected step becomes uncertain", async () => {
    const implementation = mocks.capture.getMockImplementation()!;
    mocks.capture.mockImplementation(async (...args) => args[0] === id(2) ? Promise.reject(new Error("uncertain")) : implementation(...args));
    await expect(continueFederalPendingSources(request([1, 2]))).rejects.toThrow();
    expect(state.cursor.discoverySourceOnlyOperation.outcomes).toHaveLength(1);
    expect(state.cursor.discoveryInFlight).toEqual([id(1), id(2)]);
  });
  it("stops further provider attempts after upstream unavailability and preserves unattempted continuations", async () => {
    const implementation = mocks.capture.getMockImplementation()!;
    mocks.capture.mockImplementation(async (...args) => ({ ...await implementation(...args), reason: "provider_unavailable_no_retry" }));
    const before = structuredClone(state.cursor.discoveryContinuations[id(2)]);
    const result = await continueFederalPendingSources(request([1, 2]));
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(result.outcomes[1]).toMatchObject({ reason: "not_attempted_after_provider_failure", sourceRequests: 0 });
    expect(state.cursor.discoveryContinuations[id(2)]).toEqual(before);
  });
  it.each(["five", "duplicate", "source-false", "extra-selector", "no-hash", "same-op"])("strict request cannot broaden admission: %s", kind => {
    const input: any = request();
    if (kind === "five") input.continuations = request([1, 2, 3, 4, 5]).continuations;
    if (kind === "duplicate") input.continuations.push(input.continuations[0]);
    if (kind === "source-false") input.sourceOnly = false;
    if (kind === "extra-selector") input.limit = 4;
    if (kind === "no-hash") delete input.continuations[0].expectedSha256;
    if (kind === "same-op") input.operationId = input.holdOperationId;
    expect(federalPendingSourceSchema.safeParse(input).success).toBe(false);
  });
  it("capture disabled performs no DB reads or lease mutation", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(continueFederalPendingSources(request())).rejects.toThrow("disabled");
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled();
  });
});
