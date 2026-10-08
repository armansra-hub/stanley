import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc,
  from: (table: string) => ({ select: () => ({ eq: (_key: string, value: string) => ({ maybeSingle: () => mocks.read(table, value) }) }) }),
}) }));
import { reconcileFederalDiscoveryCapacity, federalCapacityReconciliationSchema } from "./federalDiscoveryReconciliation";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = { operationId: id(8000), journalId: id(8001), companyIds: [id(998), id(999), id(1000), id(1001)],
  expectedCursorMd5: "a".repeat(32), expectedJournalMd5: "b".repeat(32), evidenceSha256: "c".repeat(64), readerTaskId: "reader", reviewerTaskId: "reviewer" };
const continuation = (companyId: string) => ({ version: 1, companyId, companyIdentity: "a".repeat(64), searchEndDate: "2026-09-29",
  targets: [{ query: "Original company", identity: null }], targetIndex: 0, page: 1, candidate: null, lastPageHash: null, collection: "idvs", searchAfter: null });
describe("provider-free federal capacity transaction and readback", () => {
  let journal: Record<string, any>, event: Record<string, any>, state: Record<string, any>, priorState: Record<string, any>, receipt: Record<string, any>;
  beforeEach(() => {
    vi.clearAllMocks();
    journal = { id: input.journalId, module: "headhunter", kind: "federal.discovery.attempts", entity_type: "cron", meta: {
      source: "federal-discovery", requestStrategy: "name-only-v1", coverageVerified: false, historyComplete: false,
      attemptedCompanies: input.companyIds.map(companyId => ({ companyId, status: "in_progress", stage: "award_search", reason: "searching_contract_vehicles",
        sourceRequests: 1, mayHaveWritten: false, verified: false, historyComplete: false, exhaustive: false, continuation: continuation(companyId) })),
    } };
    const hold = { version: 1, status: "held", reason: "reviewed_journal_capacity_recovery_requires_manual_resume", operationId: input.operationId,
      journalId: input.journalId, companyIds: input.companyIds, evidenceSha256: input.evidenceSha256, readerTaskId: input.readerTaskId,
      reviewerTaskId: input.reviewerTaskId, heldAt: "2026-10-08T00:00:00Z" };
    receipt = { eventId: input.operationId, status: "held", request: input, hold, sourceRequests: 0, attemptsCredited: 0,
      providerReplay: false, coverageVerified: false, historyComplete: false, pendingSearches: 1001, afterCompanyId: id(5000), attemptsTotal: 3636 };
    state = { cursor: { afterCompanyId: receipt.afterCompanyId, discoveryAttemptsTotal: 3636, discoveryInFlight: [], discoveryInFlightEventId: null,
      discoveryCapacityHold: hold, discoveryContinuations: Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [id(n + 1), continuation(id(n + 1))])) } };
    priorState = structuredClone(state);
    delete priorState.cursor.discoveryCapacityHold;
    for (const id of input.companyIds) delete priorState.cursor.discoveryContinuations[id];
    priorState.cursor.discoveryInFlight = input.companyIds; priorState.cursor.discoveryInFlightEventId = input.journalId;
    event = { id: input.operationId, module: "headhunter", kind: "federal.discovery.capacity_hold", entity_type: "cron", entity_id: "federal-discovery", meta: receipt };
    mocks.rpc.mockImplementation(async () => ({ data: structuredClone(receipt), error: null }));
    let stateReads = 0;
    mocks.read.mockImplementation(async (table, key) => ({ data: structuredClone(table === "public_growth_sweep_state"
      ? ++stateReads === 1 ? priorState : state : key === input.journalId ? journal : event), error: null }));
  });
  it("requires the exact committed event and all four retained continuations before success", async () => {
    expect(await reconcileFederalDiscoveryCapacity(input)).toMatchObject({ ...receipt, exactEventVerified: true, exactStateVerified: true });
    expect(mocks.rpc).toHaveBeenCalledWith("reconcile_federal_discovery_capacity_hold", { p_request: input });
    expect(mocks.read.mock.calls).toEqual([["app_events", input.journalId], ["public_growth_sweep_state", "federal-discovery"],
      ["app_events", input.operationId], ["public_growth_sweep_state", "federal-discovery"]]);
  });
  it.each(["possible-write", "wrong-company", "malformed-continuation"])("rejects unsafe journal before the transaction: %s", async kind => {
    if (kind === "possible-write") journal.meta.attemptedCompanies[0].mayHaveWritten = true;
    if (kind === "wrong-company") journal.meta.attemptedCompanies[0].companyId = id(5555);
    if (kind === "malformed-continuation") journal.meta.attemptedCompanies[0].continuation.targets[0].query = { bad: true };
    await expect(reconcileFederalDiscoveryCapacity(input)).rejects.toThrow(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["event", "continuation", "keyset", "count", "hold", "counter", "fence", "unrelated-continuation", "unrelated-cursor"])("never claims success for a mismatched readback: %s", async kind => {
    if (kind === "event") event.kind = "wrong";
    if (kind === "continuation") state.cursor.discoveryContinuations[input.companyIds[0]].page = 2;
    if (kind === "keyset") state.cursor.afterCompanyId = id(9999);
    if (kind === "count") delete state.cursor.discoveryContinuations[id(1)];
    if (kind === "hold") state.cursor.discoveryCapacityHold = { ...state.cursor.discoveryCapacityHold, operationId: id(8888) };
    if (kind === "counter") state.cursor.discoveryAttemptsTotal++;
    if (kind === "fence") state.cursor.discoveryInFlight = input.companyIds;
    if (kind === "unrelated-continuation") state.cursor.discoveryContinuations[id(1)].page = 2;
    if (kind === "unrelated-cursor") state.cursor.unrelatedDebt = "unexpected mutation";
    await expect(reconcileFederalDiscoveryCapacity(input)).rejects.toThrow(); expect(mocks.rpc).toHaveBeenCalledOnce();
  });
  it("does not retry an uncertain transaction result", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "response lost" } });
    await expect(reconcileFederalDiscoveryCapacity(input)).rejects.toThrow(); expect(mocks.rpc).toHaveBeenCalledOnce();
  });
  it("requires a distinct actual reviewer identity after trimming", () => {
    expect(federalCapacityReconciliationSchema.safeParse({ ...input, reviewerTaskId: " reader " }).success).toBe(false);
  });
});
