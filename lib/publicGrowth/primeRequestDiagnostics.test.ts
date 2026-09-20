import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/companyIdentity", () => ({ enrichCompanyIdentity: async (company: any) => company }));
const mocks = vi.hoisted(() => ({ autocomplete: vi.fn(), search: vi.fn(), detail: vi.fn(), transactions: vi.fn(),
  entity: vi.fn(), match: vi.fn(), award: vi.fn(), saveTransactions: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: vi.fn() }));
vi.mock("./identity", () => ({ normalizeName: (v: string) => v.toLowerCase(), companyIdentityNames: (company: any) => [...new Set([company.name, ...(company.legalNames ?? [])].filter((name: unknown) => typeof name === "string" && name.trim()))],
  decideIdentityMatch: () => ({ status: "verified", confidence: 1 }) }));
vi.mock("./usaspending", () => ({ autocompleteRecipients: mocks.autocomplete, searchContractAwardsPage: mocks.search,
  fetchAwardDetail: mocks.detail, fetchAwardTransactionsPage: mocks.transactions, compactAward: (v: unknown) => v,
  awardUrl: () => "https://www.usaspending.gov/award/TEST", recipientProfileUrl: vi.fn(), searchReceivedContractSubawardsPage: vi.fn() }));
vi.mock("./storage", () => ({ saveGovernmentEntity: mocks.entity, saveCompanyGovernmentMatch: mocks.match,
  saveFederalAward: mocks.award, saveFederalTransactions: mocks.saveTransactions,
  saveFederalSubaward: vi.fn(), recordPublicGrowthTrigger: vi.fn(), stableHash: () => "hash" }));
import { sweepUsaspendingCompany } from "./usaspendingSweep";
import { queuePublicGrowthMainFailures, type PublicGrowthAwardContinuation } from "./sweepState";
import { PublicGrowthDeadlineError } from "./http";

const ID = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const company = { id: ID, name: "Acme", domain: "acme.test", city: null, state: null };
const continuation = (patch: Partial<PublicGrowthAwardContinuation> = {}): PublicGrowthAwardContinuation => ({
  version: 1, recipientName: "Acme", searchEndDate: "2026-09-15", searchPage: 1, searchPassFoundNew: false,
  seenAwardIds: [], entityId: null, uei: null, recipientId: null, pendingAwardId: null,
  transactionPage: 1, transactionPassFoundNew: false, seenTransactionIds: [], ...patch,
});
let time: number;
let verified: any[];
beforeEach(() => {
  vi.resetAllMocks(); verified = []; time = 1000; vi.spyOn(Date, "now").mockImplementation(() => time);
  mocks.autocomplete.mockResolvedValue([]); mocks.search.mockResolvedValue({ rows: [], hasNext: false });
  mocks.detail.mockResolvedValue({ generatedAwardId: "A1", recipient: { legalName: "Acme", uei: "U1", recipientId: "R1" }, businessSizeStatus: "unknown" });
  mocks.entity.mockResolvedValue(ENTITY); mocks.match.mockResolvedValue(undefined); mocks.award.mockResolvedValue("stored-A1");
  const query: any = {};
  for (const method of ["select", "eq", "limit"]) query[method] = () => query;
  query.then = (resolve: any, reject: any) => Promise.resolve({ data: verified, error: null }).then(resolve, reject);
  mocks.from.mockReturnValue(query);
});
afterEach(() => vi.restoreAllMocks());
function timeout(mock: ReturnType<typeof vi.fn>) {
  mock.mockImplementation(async () => { time += 20_000; throw new DOMException("Request aborted", "AbortError"); });
}

describe("prime request diagnostics", () => {
  it("resumes a legacy identifier-bound checkpoint through its current verified link without rematching by name/address", async () => {
    verified = [{ government_entity_id: ENTITY, government_entities: {
      legal_name: "Different Legal Name", dba_name: null, uei: "U1", usaspending_recipient_id: "R1" } }];
    const prior = continuation({ recipientName: "Old Frozen Query", entityId: ENTITY, uei: "U1", recipientId: "R1",
      pendingAwardId: "A1", transactionPage: 3, seenTransactionIds: ["existing"] });
    mocks.detail.mockResolvedValue({ generatedAwardId: "A1", recipient: { legalName: "Different Legal Name", uei: "U1", recipientId: "R1" }, businessSizeStatus: "unknown" });
    mocks.transactions.mockResolvedValue({ rows: [], hasNext: true }); mocks.saveTransactions.mockResolvedValue(0);
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(result.status).toBe("matched");
    expect(result.awardContinuation).toMatchObject({ recipientName: "Old Frozen Query", entityId: ENTITY,
      transactionPage: 4, seenTransactionIds: ["existing"], searchTargetIndex: 0,
      searchTargets: [{ query: "Old Frozen Query", identity: { entityId: ENTITY, uei: "U1", recipientId: "R1" } }] });
    expect(mocks.award).toHaveBeenCalledWith(ENTITY, expect.objectContaining({ generatedAwardId: "A1" }));
    expect(mocks.entity).not.toHaveBeenCalled(); expect(mocks.match).not.toHaveBeenCalled();
    expect(mocks.autocomplete).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled();
  });
  it.each(["missing", "uei_changed", "recipient_changed"])("does not trust legacy checkpoint identifiers without an unchanged verified binding: %s", async (failure) => {
    if (failure !== "missing") verified = [{ government_entity_id: ENTITY, government_entities: {
      legal_name: "Acme", dba_name: null, uei: failure === "uei_changed" ? "OTHER" : "U1",
      usaspending_recipient_id: failure === "recipient_changed" ? "OTHER" : "R1" } }];
    const result = await sweepUsaspendingCompany(company, { awardContinuation: continuation({ entityId: ENTITY, uei: "U1", recipientId: "R1", pendingAwardId: "A1" }) });
    expect(result).toMatchObject({ status: "error", error: "legacy federal verified identity changed" });
    expect(mocks.detail).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.entity).not.toHaveBeenCalled(); expect(mocks.match).not.toHaveBeenCalled(); expect(mocks.award).not.toHaveBeenCalled();
  });
  it("persists a vehicle and its ordering date through the existing award and transaction path", async () => {
    const id = "CONT_IDV_TEST_9700";
    mocks.search.mockResolvedValue({ rows: [{ generatedId: id, recipientName: "Acme", lastDateToOrder: "2030-02-01" }], hasNext: false });
    mocks.detail.mockResolvedValue({ generatedAwardId: id, awardId: "TEST", awardCategory: "idv", awardTypeCode: "IDV_B", awardType: "IDC",
      recipient: { legalName: "Acme", uei: "U1", recipientId: "R1" }, businessSizeStatus: "unknown",
      awardCeiling: 1000000, totalObligations: 0, currentAwardAmount: 0 });
    mocks.transactions.mockResolvedValue({ rows: [], hasNext: false }); mocks.saveTransactions.mockResolvedValue(0);
    const result = await sweepUsaspendingCompany(company, { awardContinuation: continuation({ collection: "idvs" }) });
    expect(result).toMatchObject({ status: "matched", awards: 1, awardDone: false, awardContinuation: { collection: "idvs", seenAwardIds: [id], pendingAwardId: null } });
    expect(mocks.award.mock.calls[0][1]).toMatchObject({ awardCategory: "idv", orderingEndDate: "2030-02-01", totalObligations: 0 });
    const queued = queuePublicGrowthMainFailures({}, [result], 0);
    expect(queued.cursorPatch.retryQueue[0].awardContinuation?.collection).toBe("idvs");
  });
  it("adopts exact provider pairs and passes them on after fully processed source pages", async () => {
    const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
    mocks.search.mockResolvedValueOnce({ rows: [{ generatedId: "other", recipientName: "Other" }], hasNext: true, nextCursor: pair })
      .mockResolvedValueOnce({ rows: [], hasNext: false });
    const first = await sweepUsaspendingCompany(company);
    expect(first.awardContinuation).toMatchObject({ searchPage: 2, searchAfter: pair });
    const final = await sweepUsaspendingCompany(company, { awardContinuation: first.awardContinuation });
    expect(mocks.search.mock.calls[1][5]).toEqual(pair);
    expect(mocks.search.mock.calls[1][2]).toBe(first.awardContinuation?.searchEndDate);
    expect(final.awardDone).toBe(false);
    expect(final.awardContinuation).toMatchObject({ collection: "idvs", searchPage: 1, searchAfter: null });
    const complete = await sweepUsaspendingCompany(company, { awardContinuation: final.awardContinuation });
    expect(complete.awardDone).toBe(true);
    expect(mocks.search.mock.calls[2][6]).toBe("idvs");
  });
  it("does not advance a page cursor before its eligible award's transaction writes finish", async () => {
    const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
    const next = { lastRecordUniqueId: 122, lastRecordSortValue: "1693526400000" };
    mocks.search.mockResolvedValue({ rows: [{ generatedId: "A1", recipientName: "Acme" }], hasNext: true, nextCursor: next });
    timeout(mocks.transactions);
    const prior = continuation({ searchPage: 501, searchAfter: pair });
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(result).toMatchObject({ status: "error", awardContinuation: { searchPage: 501, searchAfter: pair, pendingAwardId: "A1" } });
    expect(result.awardContinuation?.seenAwardIds).toEqual([]);
  });
  it("replays a legacy over-budget cursor from its frozen scope with seen IDs retained", async () => {
    const prior = continuation({ searchPage: 501, seenAwardIds: ["old"], ignoredAwardIds: ["unrelated"], searchPassFoundNew: true });
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(result).toMatchObject({ awardDone: false, awardContinuation: { ...prior, searchPage: 1, searchPassFoundNew: false, searchAfter: null } });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("resets the provider pair when a stable recheck begins and when moving to another alias", async () => {
    const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
    const prior = continuation({ searchPage: 501, searchAfter: pair, searchPassFoundNew: true, seenAwardIds: ["old"] });
    const recheck = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(recheck.awardContinuation).toMatchObject({ searchPage: 1, searchAfter: null, searchPassFoundNew: false });
    const aliases = continuation({ searchAfter: pair, searchTargets: [{ query: "Acme", identity: null }, { query: "ACME", identity: null }], searchTargetIndex: 0 });
    const next = await sweepUsaspendingCompany(company, { awardContinuation: aliases });
    expect(next.awardContinuation).toMatchObject({ recipientName: "ACME", searchPage: 1, searchAfter: null });
  });
  it("retains the terminal page anchor if metric finalization fails", async () => {
    const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
    const query: any = {};
    for (const method of ["select", "eq", "order", "limit", "gt"]) query[method] = () => query;
    query.then = (resolve: any) => Promise.resolve({ data: null, error: { message: "metric facts unavailable" } }).then(resolve);
    const identityQuery: any = {};
    for (const method of ["select", "eq", "limit"]) identityQuery[method] = () => identityQuery;
    identityQuery.then = (resolve: any) => Promise.resolve({ data: [{ government_entity_id: ENTITY,
      government_entities: { legal_name: "Acme", dba_name: null, uei: "U1", usaspending_recipient_id: null } }], error: null }).then(resolve);
    mocks.from.mockImplementation((table) => table === "company_government_matches" ? identityQuery : query);
    const prior = continuation({ collection: "idvs", entityId: ENTITY, uei: "U1", searchPage: 501, searchAfter: pair, seenAwardIds: ["old"] });
    const failed = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(failed).toMatchObject({ status: "error", awardContinuation: { searchPage: 501, searchAfter: pair } });
    await sweepUsaspendingCompany(company, { awardContinuation: failed.awardContinuation });
    expect(mocks.search.mock.calls.map((call) => call[5])).toEqual([pair, pair]);
  });
  it("recovers an explicit legacy result-window error once, then preserves sequential failures", async () => {
    mocks.search.mockRejectedValue(new Error("422 Unprocessable Entity: Page #51 with limit 100 is over the maximum result limit 5000. Please provide the 'last_record_sort_value' and 'last_record_unique_id' to paginate sequentially."));
    const first = await sweepUsaspendingCompany(company, { awardContinuation: continuation({ searchPage: 51, seenAwardIds: ["old"] }) });
    expect(first).toMatchObject({ awardDone: false, awardContinuation: { searchPage: 1, searchAfter: null, seenAwardIds: ["old"] } });
    expect(first.error).toBeUndefined();
    const second = await sweepUsaspendingCompany(company, { awardContinuation: first.awardContinuation });
    expect(second).toMatchObject({ status: "error", awardContinuation: first.awardContinuation });
  });
  it("continues beyond an initial page containing only unrelated names", async () => {
    mocks.search.mockResolvedValue({ rows: [{ generatedId: "unrelated", recipientName: "Other" }], hasNext: true });
    const result = await sweepUsaspendingCompany(company);
    expect(result).toMatchObject({ awardDone: false, awardContinuation: { searchPage: 2 } });
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("uses verified UEI/legal/DBA queries without name autocomplete", async () => {
    verified = [{ government_entity_id: ENTITY, government_entities: { legal_name: "Legal Name", dba_name: "Brand", uei: "ABCDEFGHIJKL", usaspending_recipient_id: "R1" } }];
    const result = await sweepUsaspendingCompany(company);
    expect(mocks.autocomplete).not.toHaveBeenCalled();
    expect(mocks.search.mock.calls[0][0]).toBe("ABCDEFGHIJKL");
    expect(result).toMatchObject({ awardDone: false, awardContinuation: { recipientName: "Legal Name", searchTargetIndex: 1 } });
    expect(result.awardContinuation?.searchTargets?.map((target) => target.query)).toEqual(["ABCDEFGHIJKL", "Legal Name", "Brand"]);
  });
  it("does not suppress another verified entity's award after rejecting it for the first entity", async () => {
    const secondId = "33333333-3333-4333-8333-333333333333";
    const first = { entityId: ENTITY, legalName: "First", dbaName: null, uei: "ABCDEFGHIJKL", recipientId: "R1" };
    const second = { entityId: secondId, legalName: "Second", dbaName: null, uei: "ZYXWVUTSRQPO", recipientId: "R2" };
    verified = [first, second].map((identity) => ({ government_entity_id: identity.entityId, government_entities: {
      legal_name: identity.legalName, dba_name: null, uei: identity.uei, usaspending_recipient_id: identity.recipientId } }));
    mocks.search.mockResolvedValue({ rows: [{ generatedId: "A1", recipientName: "Second", recipientUei: null }], hasNext: false });
    mocks.detail.mockResolvedValue({ generatedAwardId: "A1", recipient: { legalName: "Second", uei: second.uei, recipientId: "R2" }, businessSizeStatus: "unknown" });
    timeout(mocks.transactions);
    let state = continuation({ recipientName: "First", entityId: ENTITY, uei: first.uei, recipientId: "R1",
      searchTargetIndex: 0, searchTargets: [{ query: "First", identity: first }, { query: "Second", identity: second }] });
    const excluded = await sweepUsaspendingCompany(company, { awardContinuation: state });
    expect(excluded.awardContinuation).toMatchObject({ ignoredAwardIds: ["A1"], seenAwardIds: [] });
    state = excluded.awardContinuation!;
    for (let step = 0; step < 2; step++) state = (await sweepUsaspendingCompany(company, { awardContinuation: state })).awardContinuation!;
    expect(state).toMatchObject({ recipientName: "Second", ignoredAwardIds: [], searchTargetIndex: 1 });
    await sweepUsaspendingCompany(company, { awardContinuation: state });
    expect(mocks.award).toHaveBeenCalledWith(secondId, expect.objectContaining({ generatedAwardId: "A1" }));
    expect(mocks.entity).not.toHaveBeenCalled(); expect(mocks.match).not.toHaveBeenCalled();
  });
  it("identifies autocomplete with one unchanged attempt and only fixed safe diagnostic fields", async () => {
    timeout(mocks.autocomplete);
    const result = await sweepUsaspendingCompany(company, { deadlineMs: 241000 });
    expect(mocks.autocomplete).toHaveBeenCalledTimes(1); expect(mocks.autocomplete).toHaveBeenCalledWith("Acme", 1, 241000);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(result.requestDiagnostic).toEqual({ operation: "recipient_autocomplete", elapsedMs: 20000, failureClass: "request_timeout", httpStatus: null });
    expect(result.error).toBe("Request aborted [usaspending_operation=recipient_autocomplete; elapsed_ms=20000; failure_class=request_timeout]");
    expect(result.awardContinuation).toBeUndefined();
    const saved = queuePublicGrowthMainFailures({}, [result], 1, "2026-09-15T21:10:00Z");
    expect(saved.cursorPatch.retryQueue[0].lastError).toBe(result.error);
    expect(saved.cursorPatch.retryQueue[0].failureAttempts).toBe(1);
  });
  it("distinguishes initial search from autocomplete and preserves its query continuation", async () => {
    timeout(mocks.search);
    const result = await sweepUsaspendingCompany(company);
    expect(mocks.autocomplete).toHaveBeenCalledTimes(1); expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(result.requestDiagnostic?.operation).toBe("initial_award_search");
    expect(result.awardContinuation).toMatchObject({ recipientName: "Acme", searchPage: 1, searchTargetIndex: 0 });
  });
  it("identifies continuation search and keeps its exact pending history", async () => {
    timeout(mocks.search); const prior = continuation({ searchPage: 3, seenAwardIds: ["old"] });
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(mocks.autocomplete).not.toHaveBeenCalled();
    expect(result.requestDiagnostic?.operation).toBe("continuation_award_search");
    expect(result.awardContinuation).toEqual(prior);
  });
  it("identifies award detail while retaining the pending award", async () => {
    timeout(mocks.detail); const prior = continuation({ pendingAwardId: "A1" });
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior, deadlineMs: 241000 });
    expect(mocks.detail).toHaveBeenCalledTimes(1); expect(mocks.detail).toHaveBeenCalledWith("A1", 1, 241000);
    expect(result.requestDiagnostic?.operation).toBe("award_detail");
    expect(result.awardContinuation).toEqual(prior);
    expect(mocks.entity).not.toHaveBeenCalled();
  });
  it("identifies transactions after persisted identity and award without marking the award complete", async () => {
    timeout(mocks.transactions);
    const result = await sweepUsaspendingCompany(company, { awardContinuation: continuation({ pendingAwardId: "A1", transactionPage: 2 }), deadlineMs: 241000 });
    expect(mocks.transactions).toHaveBeenCalledTimes(1); expect(mocks.transactions).toHaveBeenCalledWith("A1", 2, 241000);
    expect(result.requestDiagnostic?.operation).toBe("award_transactions");
    expect(result.awardContinuation).toMatchObject({ pendingAwardId: "A1", transactionPage: 2, entityId: ENTITY });
    expect(result.awards).toBe(0); expect(mocks.saveTransactions).not.toHaveBeenCalled();
  });
  it("does not relabel a database failure as the last successful provider operation", async () => {
    mocks.entity.mockRejectedValue(new Error("Database write failed"));
    const result = await sweepUsaspendingCompany(company, { awardContinuation: continuation({ pendingAwardId: "A1" }) });
    expect(result.error).toBe("Database write failed"); expect(result.requestDiagnostic).toBeUndefined();
  });
  it("preserves overall deadline continuation handling without converting it into an error/retry", async () => {
    mocks.search.mockRejectedValue(new PublicGrowthDeadlineError()); const prior = continuation();
    const result = await sweepUsaspendingCompany(company, { awardContinuation: prior });
    expect(result.status).toBe("no_awards"); expect(result.awardDone).toBe(false);
    expect(result.awardContinuation).toEqual(prior); expect(result.error).toBeUndefined(); expect(result.requestDiagnostic).toBeUndefined();
  });
  it.each([
    [new Error("429 Too Many Requests: private source body"), "rate_limited", 429],
    [new Error("503 Service Unavailable: private source body"), "http_error", 503],
    [new TypeError("fetch failed with private URL"), "transport_error", null],
    [new SyntaxError("private response is not JSON"), "invalid_json", null],
  ])("classifies %s without copying its free text into the public diagnostic", async (error, failureClass, httpStatus) => {
    mocks.autocomplete.mockRejectedValue(error);
    const result = await sweepUsaspendingCompany(company);
    expect(result.requestDiagnostic).toEqual({ operation: "recipient_autocomplete", elapsedMs: 0, failureClass, httpStatus });
    expect(result.error?.startsWith((error as Error).message)).toBe(true);
  });
  it("requires both contracts and vehicles before reporting a completed no-award scope", async () => {
    const result = await sweepUsaspendingCompany(company);
    expect(result).toMatchObject({ status: "no_awards", awardDone: false, awards: 0, transactions: 0, triggers: 0 });
    expect(result.awardContinuation?.collection).toBe("idvs");
    expect(result.requestDiagnostic).toBeUndefined(); expect(mocks.autocomplete).toHaveBeenCalledTimes(1); expect(mocks.search).toHaveBeenCalledTimes(1);
  });
});
