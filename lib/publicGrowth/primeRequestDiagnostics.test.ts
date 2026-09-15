import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ autocomplete: vi.fn(), search: vi.fn(), detail: vi.fn(), transactions: vi.fn(),
  entity: vi.fn(), match: vi.fn(), award: vi.fn(), saveTransactions: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: vi.fn() }));
vi.mock("./identity", () => ({ normalizeName: (v: string) => v.toLowerCase(), decideIdentityMatch: () => ({ status: "verified", confidence: 1 }) }));
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
beforeEach(() => {
  vi.resetAllMocks(); time = 1000; vi.spyOn(Date, "now").mockImplementation(() => time);
  mocks.autocomplete.mockResolvedValue([]); mocks.search.mockResolvedValue({ rows: [], hasNext: false });
  mocks.detail.mockResolvedValue({ generatedAwardId: "A1", recipient: { legalName: "Acme", uei: "U1", recipientId: "R1" }, businessSizeStatus: "unknown" });
  mocks.entity.mockResolvedValue(ENTITY); mocks.match.mockResolvedValue(undefined); mocks.award.mockResolvedValue("stored-A1");
});
afterEach(() => vi.restoreAllMocks());
function timeout(mock: ReturnType<typeof vi.fn>) {
  mock.mockImplementation(async () => { time += 20_000; throw new DOMException("Request aborted", "AbortError"); });
}

describe("prime request diagnostics", () => {
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
  it("distinguishes initial search from autocomplete without establishing a continuation", async () => {
    timeout(mocks.search);
    const result = await sweepUsaspendingCompany(company);
    expect(mocks.autocomplete).toHaveBeenCalledTimes(1); expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(result.requestDiagnostic?.operation).toBe("initial_award_search");
    expect(result.awardContinuation).toBeUndefined();
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
  it("leaves successful no-award output and request count unchanged", async () => {
    const result = await sweepUsaspendingCompany(company);
    expect(result).toMatchObject({ status: "no_awards", awardDone: true, awards: 0, transactions: 0, triggers: 0 });
    expect(result.requestDiagnostic).toBeUndefined(); expect(mocks.autocomplete).toHaveBeenCalledTimes(1); expect(mocks.search).toHaveBeenCalledTimes(1);
  });
});
