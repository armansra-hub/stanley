import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), begin: vi.fn(), checkpoint: vi.fn(), fail: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("./federalDiscoverySourceOnly", async original => ({ ...await original<typeof import("./federalDiscoverySourceOnly")>(), captureFederalPendingSource: mocks.capture }));
vi.mock("./sweepState", async original => ({ ...await original<typeof import("./sweepState")>(), beginPublicGrowthSweep: mocks.begin,
  checkpointPublicGrowthSweep: mocks.checkpoint, failPublicGrowthSweep: mocks.fail }));
import { continueFederalPendingSources, federalPendingSourceSchema, inspectFederalPendingSources, reconcileFederalPendingSource, federalPendingRecoverySchema } from "./federalDiscoveryPending";
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

const reviewedFixture = {
  "originalRequest": {
    "sourceOnly": true,
    "operationId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
    "continuations": [
      {
        "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "expectedSha256": "70af63a1ffbc568f7ee1869390a01cedef2e8b683d041307bc44e6d32ec7f452"
      },
      {
        "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
        "expectedSha256": "c42a329dd366fcf1f47cf15cb9bbf6bd576fb7b4c5fde801451c3900c1d5cb3d"
      },
      {
        "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
        "expectedSha256": "e5c25473f3391ae43dee4851911ceca7afcf985ed726fb47b6dc57635d67426b"
      },
      {
        "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
        "expectedSha256": "bd4c5d7f902d7f327ba03d7acc89941a939e69eab97f59275be387b6161031e5"
      }
    ],
    "holdOperationId": "4a173495-2b1d-41d4-966d-cba64832fcc9"
  },
  "retainedSource": {
    "observationId": "dfffb638-5c44-472f-b0b6-cac340530ef0",
    "jobId": "db64a7e3-2607-4cc2-a0ae-8119fab094b7",
    "sourceKey": "66b77c52cbe91eec136e963894ead8a2d016b18646349cb00ef126c02265ee49",
    "requestSha256": "c1243ac35ad4efcfe72083cca6217383da08724da4624b517b1d315532b1a030",
    "retainedJsonSha256": "fc757405485bafe627208795a5010df673f1db91aef27d86e0699fc9879b142a"
  },
  "continuations": {
    "5cb49e88-b779-467a-aa28-cb704eb4b808": {
      "page": 1,
      "targets": [
        {
          "query": "Optimize Now Technologies",
          "identity": null
        }
      ],
      "version": 1,
      "candidate": null,
      "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
      "collection": "idvs",
      "searchAfter": null,
      "targetIndex": 0,
      "lastPageHash": null,
      "searchEndDate": "2026-09-29",
      "companyIdentity": "af44c3c4861e415ad643f38ad895588bdfddd9d0d19b20111632c868eb3c85dc"
    },
    "5cb653c0-93c5-483a-a63d-4266c264a77b": {
      "page": 1,
      "targets": [
        {
          "query": "LOOK AD ME studio",
          "identity": null
        }
      ],
      "version": 1,
      "candidate": null,
      "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
      "collection": "idvs",
      "searchAfter": null,
      "targetIndex": 0,
      "lastPageHash": null,
      "searchEndDate": "2026-09-29",
      "companyIdentity": "cbda708686f3e0d45e371532745eaa26c399b8d6e6bc9866a14c1c3d1ee4dc4b"
    },
    "5cb968f7-e56a-4b71-b6a5-a70846949aa3": {
      "page": 1,
      "targets": [
        {
          "query": "Wesslake Consulting",
          "identity": null
        }
      ],
      "version": 1,
      "candidate": null,
      "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
      "collection": "idvs",
      "searchAfter": null,
      "targetIndex": 0,
      "lastPageHash": null,
      "searchEndDate": "2026-09-29",
      "companyIdentity": "25180d7846b660a36a511870523a2e5d931faac1ebf8471db1716fb5e13db40a"
    },
    "5cbdb11f-d241-46e8-a3da-92f213378498": {
      "page": 1,
      "targets": [
        {
          "query": "INACTIVE_BarthCalderon LLP",
          "identity": null
        }
      ],
      "version": 1,
      "candidate": null,
      "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
      "collection": "idvs",
      "searchAfter": null,
      "targetIndex": 0,
      "lastPageHash": null,
      "searchEndDate": "2026-09-29",
      "companyIdentity": "040ce11aaa02872597e70a8265fb72cea72805e905a9c705f9fcc6a563ca92ad"
    }
  }
} as const;
const incidentIds = reviewedFixture.originalRequest.continuations.map(row => row.companyId);
function interruptedInput() {
  const originalRequest = structuredClone(reviewedFixture.originalRequest);
  // Replace only four synthetic entries; retain 1001 total and every other
  // unknown extension so the recovery preservation test is realistic.
  for (let n = 1; n <= 4; n++) delete state.cursor.discoveryContinuations[id(n)];
  Object.assign(state.cursor.discoveryContinuations, structuredClone(reviewedFixture.continuations));
  state.cursor.discoveryCapacityHold.operationId = originalRequest.holdOperationId;
  state.cursor.discoveryCapacityHold.companyIds = [...incidentIds];
  state.cursor.discoveryInFlight = [...incidentIds];
  state.cursor.discoveryInFlightEventId = originalRequest.operationId;
  state.cursor.discoverySourceOnlyOperation = { version: 1, status: "in_flight", request: originalRequest, eventId: originalRequest.operationId };
  return federalPendingRecoverySchema.parse({ operationId: id(9010), originalRequest, expectedCursorSha256: federalSourceOnlyHash(state.cursor),
    retainedSource: structuredClone(reviewedFixture.retainedSource),
    incidentProof: { kind: "first_job_read_missing_company_column_before_serial_checkpoint",
      deployedCommit: "d4cb26f96eb37ab3c2d5e199629b0974809a88de", readerTaskId: "/reader", reviewerTaskId: "/reviewer",
      evidenceSha256: "f".repeat(64), reviewSha256: "b".repeat(64), historicalSourceRequests: 1, remainingSourceRequests: 0 } });
}
function mockRetainedCapture(input: ReturnType<typeof interruptedInput>) {
  mocks.capture.mockImplementation(async (companyId, original, operationId, _deadline, binding) => {
    expect(operationId).toBe(input.originalRequest.operationId); expect(binding).toEqual(input.retainedSource);
    return { companyId, status: "incomplete", reason: "search_page_captured_continuation_pending", sourceRequests: 0,
      reusedCapture: true, sourceCaptured: true, observationId: binding.observationId, jobId: binding.jobId,
      analysisComplete: false, identityVerified: false, historyComplete: false,
      continuation: { ...original, page: 2, sourceCapture: { version: 1, status: "pending", stage: "search", reason: "source_page_retained",
        observationId: binding.observationId, requestSha256: binding.requestSha256, retainedJsonSha256: binding.retainedJsonSha256,
        capturedAt: "2026-10-08T06:03:27.955Z" } } };
  });
}
describe("provider-free reviewed first-step source recovery", () => {
  it("binds full cursor, recovers one source and preserves all positions/extensions; the unattempted three remain eligible pending work", async () => {
    const input = interruptedInput(), before = structuredClone(state.cursor); mockRetainedCapture(input);
    const result = await reconcileFederalPendingSource(input);
    expect(result).toMatchObject({ eventId: input.operationId, sourceRequests: 0, historicalSourceRequests: 1, remainingHistoricalSourceRequests: 0,
      retainedCapturesRecovered: 1, unattemptedIncomplete: 3, attemptsCredited: 0, analysisComplete: false, historyComplete: false,
      exactEventVerified: true, exactStateVerified: true, reusedReceipt: false });
    expect(mocks.capture).toHaveBeenCalledTimes(1); expect(mocks.capture.mock.calls[0][0]).toBe(incidentIds[0]);
    expect(Object.keys(state.cursor.discoveryContinuations)).toHaveLength(1001);
    for (const companyId of Object.keys(before.discoveryContinuations)) {
      const next = structuredClone(state.cursor.discoveryContinuations[companyId]);
      if (companyId === incidentIds[0]) { expect(next.sourceCapture.status).toBe("held"); delete next.sourceCapture; }
      expect(next).toEqual(before.discoveryContinuations[companyId]);
    }
    for (const [key,value] of Object.entries(before)) if (!["discoveryContinuations","discoveryInFlight","discoveryInFlightEventId","discoverySourceOnlyOperation"].includes(key)) expect(state.cursor[key]).toEqual(value);
    expect(result.outcomes.slice(1).every((row: any) => row.reason === "not_attempted_before_first_step_readback_failure" && row.sourceCaptured === false && row.sourceRequests === 0)).toBe(true);
    expect(state.lease_token).toBeNull(); expect(events).toHaveLength(1);
  });
  it("same recovery is exact readback-only; retargeting or changed final state never replays", async () => {
    const input = interruptedInput(); mockRetainedCapture(input); await reconcileFederalPendingSource(input);
    mocks.capture.mockClear(); mocks.begin.mockClear();
    expect((await reconcileFederalPendingSource(input)).reusedReceipt).toBe(true);
    await expect(reconcileFederalPendingSource({ ...input, incidentProof: { ...input.incidentProof, evidenceSha256: "a".repeat(64) } })).rejects.toThrow("never replay");
    state.cursor.preservedUnrelated.full.push("changed");
    await expect(reconcileFederalPendingSource(input)).rejects.toThrow("never replay");
    expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.begin).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
  });
  it.each(["stale-hash", "wrong-hold", "changed-continuation", "partial-outcome", "wrong-order", "original-event", "uncertainty", "race"])("fails closed on mismatched exact incident: %s", async kind => {
    const input = interruptedInput(); mockRetainedCapture(input);
    if (kind === "stale-hash") input.expectedCursorSha256 = "a".repeat(64);
    if (kind === "wrong-hold") state.cursor.discoveryCapacityHold.operationId = id(9030);
    if (kind === "changed-continuation") state.cursor.discoveryContinuations[incidentIds[0]].page++;
    if (kind === "partial-outcome") state.cursor.discoverySourceOnlyOperation.outcomes = [];
    if (kind === "wrong-order") state.cursor.discoveryInFlight.reverse();
    if (kind === "original-event") events.push({ id: input.originalRequest.operationId });
    if (kind === "uncertainty") state.cursor.discoveryUncertainOutcomes = [{ companyId: id(1) }];
    if (kind === "race") mocks.begin.mockImplementationOnce(async () => {
      state.cursor.discoveryContinuations[incidentIds[0]].page++;
      lease = { source: "federal-discovery", batchSize: 4, managed: true, token: id(8000), offset: 0, cursor: structuredClone(state.cursor), leaseUntil: "2099-01-01T00:00:00Z" };
      return lease;
    });
    if (!["stale-hash","race"].includes(kind)) input.expectedCursorSha256 = federalSourceOnlyHash(state.cursor);
    await expect(reconcileFederalPendingSource(input)).rejects.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.checkpoint).not.toHaveBeenCalled();
  });
  it.each(["worker", "wrong-job", "provider-count", "event-write", "event-read", "final-checkpoint"])("retains exact fence after uncertain recovery without retry: %s", async kind => {
    const input = interruptedInput(), before = structuredClone(state.cursor); mockRetainedCapture(input); failures.add(kind);
    const implementation = mocks.capture.getMockImplementation()!;
    if (kind === "worker") mocks.capture.mockRejectedValue(new Error("capture unavailable"));
    if (kind === "wrong-job") mocks.capture.mockImplementation(async (...args) => ({ ...await implementation(...args), jobId: id(999) }));
    if (kind === "provider-count") mocks.capture.mockImplementation(async (...args) => ({ ...await implementation(...args), sourceRequests: 1 }));
    await expect(reconcileFederalPendingSource(input)).rejects.toThrow();
    expect(state.cursor).toEqual(before); expect(state.lease_token).toBeNull();
    const calls = mocks.capture.mock.calls.length;
    if (events.length) await expect(reconcileFederalPendingSource(input)).rejects.toThrow();
    expect(mocks.capture).toHaveBeenCalledTimes(calls);
  });
  it.each(["same-reviewer", "wrong-deployment", "no-proof", "same-operation", "short-scope", "source-enabled", "extra", "other-incident", "other-source", "other-position"])("rejects missing/ambiguous review proof: %s", kind => {
    const input: any = interruptedInput();
    if (kind === "same-reviewer") input.incidentProof.reviewerTaskId = input.incidentProof.readerTaskId;
    if (kind === "wrong-deployment") input.incidentProof.deployedCommit = "f".repeat(40);
    if (kind === "no-proof") delete input.incidentProof.reviewSha256;
    if (kind === "same-operation") input.operationId = input.originalRequest.operationId;
    if (kind === "short-scope") input.originalRequest.continuations.pop();
    if (kind === "source-enabled") input.incidentProof.remainingSourceRequests = 1;
    if (kind === "extra") input.providerReplay = true;
    if (kind === "other-incident") input.originalRequest.operationId = id(9898);
    if (kind === "other-source") input.retainedSource.observationId = id(9898);
    if (kind === "other-position") input.originalRequest.continuations[0].expectedSha256 = "a".repeat(64);
    expect(federalPendingRecoverySchema.safeParse(input).success).toBe(false);
  });
});
