import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseUsaspendingSearchAfter, usaspendingNextCursor, usaspendingCursorRequest } from "./usaspendingCursor";
import { parsePublicGrowthSubawardContinuation, queuePublicGrowthMainFailures, applyPublicGrowthRetryOutcomes } from "./sweepState";
import { parseFederalDiscoveryContinuation } from "./federalDiscoveryState";

const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
const companyId = "11111111-1111-4111-8111-111111111111";
describe("provider paired sequential cursor", () => {
  it("preserves the opaque provider sort value verbatim", () => {
    expect(usaspendingCursorRequest(pair)).toEqual({ last_record_unique_id: 123, last_record_sort_value: "1693526400000" });
    expect(parseUsaspendingSearchAfter(undefined)).toBeUndefined();
    expect(parseUsaspendingSearchAfter(null)).toBeNull();
  });
  it.each([{}, { lastRecordUniqueId: 123 }, { lastRecordSortValue: "date" },
    { ...pair, lastRecordUniqueId: "123" }, { ...pair, lastRecordUniqueId: Number.MAX_SAFE_INTEGER + 1 },
    { ...pair, lastRecordSortValue: 123 }, { ...pair, lastRecordSortValue: "None" }, { ...pair, lastRecordSortValue: "" }])("rejects unsafe or incomplete pair %j", (value) => {
    expect(() => parseUsaspendingSearchAfter(value)).toThrow("cursor");
  });
  it("handles the provider's terminal null/None metadata", () => {
    expect(usaspendingNextCursor({ hasNext: false, last_record_unique_id: null, last_record_sort_value: "None" }, 0, pair)).toBeUndefined();
  });
  it("rejects omitted, half, empty-page and repeated sequential cursors", () => {
    expect(() => usaspendingNextCursor({ hasNext: true }, 100, pair)).toThrow("omitted");
    expect(() => usaspendingNextCursor({ hasNext: true, last_record_unique_id: 123 }, 100, undefined)).toThrow("pair");
    expect(() => usaspendingNextCursor({ hasNext: true, ...usaspendingCursorRequest(pair) }, 0, null)).toThrow("empty page");
    expect(() => usaspendingNextCursor({ hasNext: true, ...usaspendingCursorRequest(pair) }, 100, pair)).toThrow("did not advance");
  });
  it("roundtrips exact pairs through prime retries and dead-letter receipts", () => {
    const continuation = { version: 1 as const, recipientName: "Acme", searchEndDate: "2026-09-18", searchPage: 501,
      searchPassFoundNew: false, seenAwardIds: ["old"], entityId: null, uei: null, recipientId: null,
      pendingAwardId: null, transactionPage: 1, transactionPassFoundNew: false, seenTransactionIds: [], searchAfter: pair };
    let state = queuePublicGrowthMainFailures({}, [{ companyId, status: "matched", awardDone: false, awardContinuation: continuation }], 0).cursorPatch;
    expect(state.retryQueue[0].awardContinuation).toEqual(continuation);
    for (let i = 0; i < 3; i++) state = applyPublicGrowthRetryOutcomes(state, state.retryQueue,
      [{ companyId, status: "error", error: "provider failed", awardDone: false, awardContinuation: continuation }]).cursorPatch;
    expect(state.deadLetters[0].awardContinuation).toEqual(continuation);
  });
  it("roundtrips subaward/discovery pairs and rejects malformed stored pairs", () => {
    const sub = { version: 1 as const, companyId, entityId: companyId, names: ["Acme"], nameIndex: 0,
      searchEndDate: "2026-09-18", searchPage: 501, searchPassFoundNew: false, seenSubawardIds: [], searchAfter: pair };
    const discovery = { version: 1 as const, companyId, companyIdentity: "hash", searchEndDate: "2026-09-18",
      targets: [{ query: "Acme", identity: null }], targetIndex: 0, page: 501, candidate: null, lastPageHash: null, searchAfter: pair };
    expect(parsePublicGrowthSubawardContinuation(sub)).toEqual(sub);
    expect(parseFederalDiscoveryContinuation(discovery, companyId)).toEqual(discovery);
    expect(() => parsePublicGrowthSubawardContinuation({ ...sub, searchAfter: { lastRecordUniqueId: 1 } })).toThrow();
    expect(() => parseFederalDiscoveryContinuation({ ...discovery, searchAfter: [] }, companyId)).toThrow();
  });
});
