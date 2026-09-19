import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  page: vi.fn(), save: vi.fn(), trigger: vi.fn(), priority: vi.fn(), rpc: vi.fn(),
  autocomplete: vi.fn(), primePage: vi.fn(), from: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.priority }));
vi.mock("./usaspending", () => ({
  searchReceivedContractSubawardsPage: mocks.page,
  autocompleteRecipients: mocks.autocomplete, searchContractAwardsPage: mocks.primePage,
  awardUrl: vi.fn(), compactAward: vi.fn(), fetchAwardDetail: vi.fn(), fetchAwardTransactionsPage: vi.fn(), recipientProfileUrl: vi.fn(),
}));
vi.mock("./storage", () => ({
  saveFederalSubaward: mocks.save, recordPublicGrowthTrigger: mocks.trigger,
  stableHash: (value: unknown) => JSON.stringify(value), saveCompanyGovernmentMatch: vi.fn(),
  saveFederalAward: vi.fn(), saveFederalTransactions: vi.fn(), saveGovernmentEntity: vi.fn(),
}));
import { sweepUsaspendingSubawardsCompany, sweepUsaspendingSubawardsTamBatch, sweepUsaspendingTamBatch } from "./usaspendingSweep";
import type { PublicGrowthSubawardContinuation } from "./sweepState";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const company = { id: ID, name: "Acme", domain: "acme.test", city: null, state: null };
let links: Array<Record<string, unknown>>;
let metricRows: Array<Record<string, unknown>>;
let metricWrites: Array<Record<string, unknown>>;
let metricsError: string | null;
function row(id: string) { return { "Sub-Award ID": id, "Sub-Awardee Name": "Acme", "Sub-Recipient UEI": "ABCDEFGHIJKL", "Sub-Award Date": "2026-09-01", "Sub-Award Amount": 100, primeAwardId: "P1" }; }
function continuation(patch: Partial<PublicGrowthSubawardContinuation> = {}): PublicGrowthSubawardContinuation {
  return { version: 1, companyId: ID, entityId: ENTITY, names: ["Acme"], nameIndex: 0,
    searchEndDate: "2026-09-14", searchPage: 1, searchPassFoundNew: false, seenSubawardIds: [], ...patch };
}
beforeEach(() => {
  vi.clearAllMocks();
  links = [{ government_entity_id: ENTITY, government_entities: { legal_name: "Acme", dba_name: null, uei: "ABCDEFGHIJKL" } }];
  metricRows = []; metricWrites = []; metricsError = null;
  mocks.save.mockResolvedValue(undefined); mocks.trigger.mockResolvedValue(false); mocks.priority.mockResolvedValue(undefined);
  mocks.page.mockResolvedValue({ rows: [], hasNext: false });
  mocks.autocomplete.mockResolvedValue([]); mocks.primePage.mockResolvedValue({ rows: [], hasNext: false });
  mocks.from.mockImplementation((table: string) => {
    let selected = "";
    const query: Record<string, any> = {};
    for (const method of ["eq", "in", "or", "gte", "lte", "gt", "order", "limit", "range", "contains", "neq"])
      query[method] = vi.fn(() => query);
    query.select = vi.fn((value: string) => { selected = value; return query; });
    query.upsert = vi.fn((value: Record<string, unknown>) => { metricWrites.push(value); return query; });
    query.then = (resolve: any, reject: any) => Promise.resolve(table === "company_government_matches"
      ? { data: selected === "company_id" ? [{ company_id: ID }, { company_id: OTHER }] : links, error: null }
      : table === "federal_subawards" ? { data: metricRows, error: metricsError ? { message: metricsError } : null }
      : { data: null, error: null }).then(resolve, reject);
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("resumable exact-company subaward history", () => {
  it("upgrades an old over-budget cursor, crosses adjacent dates, and deduplicates stored IDs across resume", async () => {
    mocks.page.mockImplementation((_name, _page, endDate, _deadline, startDate) => Promise.resolve({
      rows: startDate === "2007-10-01" ? [{ ...row("old"), "Sub-Award Date": "2007-10-01" }, { ...row("left"), "Sub-Award Date": "2007-10-02" }]
        : [{ ...row("right"), "Sub-Award Date": "2007-10-03" }, { ...row("end"), "Sub-Award Date": endDate }], hasNext: false,
    }));
    const first = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({
      searchEndDate: "2007-10-04", searchPage: 101, seenSubawardIds: ["old"], searchPassFoundNew: true,
    }) });
    expect(first).toMatchObject({ status: "linked", stored: 1, subawardDone: false, subawardContinuation: {
      searchEndDate: "2007-10-04", searchWindowIndex: 1, searchPage: 1, seenSubawardIds: ["old", "left"],
      searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-02" }, { startDate: "2007-10-03", endDate: "2007-10-04" }],
    } });
    expect(metricWrites).toHaveLength(0);
    const final = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: first.subawardContinuation });
    expect(final.subawardDone).toBe(true);
    expect(mocks.save.mock.calls.map(([value]) => value.externalSubawardId)).toEqual(["left", "right", "end"]);
    expect(mocks.page.mock.calls).toEqual([
      ["Acme", 1, "2007-10-02", undefined, "2007-10-01"], ["Acme", 1, "2007-10-02", undefined, "2007-10-01"],
      ["Acme", 1, "2007-10-04", undefined, "2007-10-03"], ["Acme", 1, "2007-10-04", undefined, "2007-10-03"],
    ]);
    expect(metricWrites[0].as_of_date).toBe("2007-10-04");
  });
  it("partitions a full budget-boundary page even when provider hasNext is false", async () => {
    mocks.page.mockResolvedValue({ rows: Array.from({ length: 100 }, (_, i) => row(`S${i}`)), sourceResultCount: 100, hasNext: false });
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({ searchPage: 100 }) });
    expect(result).toMatchObject({ status: "linked", stored: 20, subawardDone: false, subawardContinuation: { searchPage: 1, searchWindowIndex: 0 } });
    expect(result.subawardContinuation?.searchWindows).toHaveLength(2);
    expect(result.subawardContinuation?.seenSubawardIds).toHaveLength(20);
    expect(metricWrites).toHaveLength(0);
  });
  it("recovers only the explicit provider result-window error using smaller scopes", async () => {
    mocks.page.mockRejectedValueOnce(new Error("422 Unprocessable Entity: Page #51 with limit 100 is over the maximum result limit 5000. Please provide the 'last_record_sort_value' and 'last_record_unique_id' to paginate sequentially."))
      .mockResolvedValue({ rows: [], hasNext: true });
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({ searchPage: 51 }) });
    expect(result).toMatchObject({ status: "linked", subawardDone: false, subawardContinuation: { searchPage: 3, searchWindowIndex: 0 } });
    expect(result.subawardContinuation?.searchWindows).toHaveLength(2);
    expect(metricWrites).toHaveLength(0);
  });
  it("does not disguise an unrelated 422 as a result-window limit", async () => {
    mocks.page.mockRejectedValue(new Error("422 Unprocessable Entity: invalid recipient filter"));
    const prior = continuation({ searchPage: 3 });
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: prior });
    expect(result).toMatchObject({ status: "error", subawardDone: false, subawardContinuation: prior });
    expect(result.subawardContinuation?.searchWindows).toBeUndefined();
  });
  it("keeps an unsplittable same-day overflow partial when sequential traversal cannot advance", async () => {
    mocks.page.mockResolvedValue({ rows: [row("old")], hasNext: true });
    const prior = continuation({ searchEndDate: "2007-10-02", searchPage: 101, searchWindowIndex: 1,
      searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-01" }, { startDate: "2007-10-02", endDate: "2007-10-02" }], seenSubawardIds: ["old"] });
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: prior });
    expect(result).toMatchObject({ status: "error", subawardDone: false, subawardContinuation: { ...prior, searchPage: 1, searchAfter: null } });
    expect(result.error).toContain("omitted its next cursor");
    expect(mocks.page).toHaveBeenCalledWith("Acme", 1, "2007-10-02", undefined, "2007-10-02", null);
    expect(metricWrites).toHaveLength(0);
  });
  it("recovers a same-day offset overflow using provider pairs and rechecks without duplicate writes", async () => {
    const pair = { lastRecordUniqueId: 123, lastRecordSortValue: "1191283200000" };
    mocks.page.mockImplementation((_name, _page, _end, _deadline, _start, after) => Promise.resolve(after
      ? { rows: [{ ...row("last"), "Sub-Award Date": "2007-10-02" }], hasNext: false }
      : { rows: [{ ...row("old"), "Sub-Award Date": "2007-10-02" }], hasNext: true, nextCursor: pair }));
    const prior = continuation({ searchEndDate: "2007-10-02", searchPage: 101, searchWindowIndex: 1,
      searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-01" }, { startDate: "2007-10-02", endDate: "2007-10-02" }], seenSubawardIds: ["old"] });
    const first = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: prior });
    expect(first).toMatchObject({ stored: 1, subawardDone: false, subawardContinuation: {
      searchPage: 1, searchAfter: null, searchWindowIndex: 1, seenSubawardIds: ["old", "last"],
    } });
    const final = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: first.subawardContinuation });
    expect(final.subawardDone).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.page.mock.calls.map((call) => call[5])).toEqual([null, pair, null, pair]);
    expect(mocks.page.mock.calls.every((call) => call[2] === "2007-10-02" && call[4] === "2007-10-02")).toBe(true);
  });
  it("retains the page anchor until every eligible subaward on a partially stored page completes", async () => {
    const after = { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" };
    const next = { lastRecordUniqueId: 122, lastRecordSortValue: "1693526400000" };
    const records = Array.from({ length: 25 }, (_, i) => row(`S${i}`));
    mocks.page.mockImplementation((_name, _page, _end, _deadline, _start, cursor) => Promise.resolve(cursor?.lastRecordUniqueId === 122
      ? { rows: [], hasNext: false } : { rows: records, hasNext: true, nextCursor: next }));
    const first = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({ searchPage: 501, searchAfter: after }) });
    expect(first).toMatchObject({ stored: 20, subawardDone: false, subawardContinuation: { searchPage: 501, searchAfter: after } });
    const second = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: first.subawardContinuation });
    expect(second.stored).toBe(5);
    expect(mocks.page.mock.calls[1][5]).toEqual(after);
    expect(mocks.page.mock.calls[2][5]).toEqual(next);
    expect(mocks.save).toHaveBeenCalledTimes(25);
  });
  it("binds prime and received roles to distinct verified entities and deduplicates their aliases", async () => {
    const second = "33333333-3333-4333-8333-333333333333";
    links.push({ government_entity_id: second, government_entities: { legal_name: "Second Legal", dba_name: "Brand", uei: "ZYXWVUTSRQPO" } });
    mocks.page.mockResolvedValue({ rows: [{ ...row("S1"), "Sub-Awardee Name": "Renamed legal entity",
      "Sub-Recipient UEI": "ZYXWVUTSRQPO", "Prime Award Recipient UEI": "ABCDEFGHIJKL" }], hasNext: false });
    metricRows = [{ id: "metric1", prime_government_entity_id: ENTITY, subaward_government_entity_id: second, subaward_amount: 100 }];
    let result = await sweepUsaspendingSubawardsCompany(company);
    expect(result.subawardDone).toBe(false);
    expect(metricWrites).toHaveLength(0);
    result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: result.subawardContinuation });
    expect(result.subawardDone).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ primeGovernmentEntityId: ENTITY, subawardGovernmentEntityId: second }));
    expect(metricWrites[0]).toMatchObject({ prime_subaward_dollars_365d: 100, received_subaward_dollars_365d: 100 });
  });
  it("does not bind a same-name subaward with another recipient's UEI", async () => {
    mocks.page.mockResolvedValue({ rows: [{ ...row("S1"), "Sub-Recipient UEI": "ZYXWVUTSRQPO" }], hasNext: false });
    const result = await sweepUsaspendingSubawardsCompany(company);
    expect(result.subawardDone).toBe(true); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("leaves a same-name subaward without identifiers unresolved instead of binding its name", async () => {
    mocks.page.mockImplementation((name) => Promise.resolve({ rows: [{ ...row("S1"), "Sub-Awardee Name": name, "Sub-Recipient UEI": null }], hasNext: false }));
    const result = await sweepUsaspendingSubawardsCompany(company);
    expect(result).toMatchObject({ status: "error", subawardDone: false });
    expect(result.error).toContain("identifiers missing"); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("finishes empty aliases and metrics in one invocation without creating retry debt", async () => {
    links[0].government_entities = { legal_name: "Acme Legal", dba_name: "Acme DBA", uei: "ABCDEFGHIJKL" };
    const result = await sweepUsaspendingSubawardsCompany(company);
    expect(mocks.page).toHaveBeenCalledTimes(3);
    expect(result.subawardDone).toBe(true);
    expect(result.subawardContinuation).toBeUndefined();
    expect(metricWrites).toHaveLength(1);
  });
  it("rechecks stable IDs across a multipage pass and never finalizes metrics early", async () => {
    mocks.page.mockImplementation((_name, page) => Promise.resolve(page === 1 ? { rows: [row("A")], hasNext: true } : { rows: [row("B")], hasNext: false }));
    const first = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation() });
    expect(first).toMatchObject({ stored: 2, subawardDone: false, subawardContinuation: { searchPage: 2, seenSubawardIds: ["A", "B"], searchPassFoundNew: false } });
    expect(metricWrites).toHaveLength(0);
    const final = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: first.subawardContinuation });
    expect(final.subawardDone).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(metricWrites).toHaveLength(1);
  });
  it("checkpoints at most20 fully persisted rows and retains the same source page", async () => {
    mocks.page.mockResolvedValue({ rows: Array.from({ length: 25 }, (_, i) => row(`S${i}`)), hasNext: false });
    const result = await sweepUsaspendingSubawardsCompany(company);
    expect(result.stored).toBe(20);
    expect(result.subawardDone).toBe(false);
    expect(result.subawardContinuation?.searchPage).toBe(1);
    expect(result.subawardContinuation?.seenSubawardIds).toHaveLength(20);
    expect(metricWrites).toHaveLength(0);
  });
  it("freezes aliases and date even when a later company name changes", async () => {
    const result = await sweepUsaspendingSubawardsCompany({ ...company, name: "Renamed" }, { subawardContinuation: continuation() });
    expect(mocks.page).toHaveBeenCalledWith("Acme", 1, "2026-09-14", undefined);
    expect(result.subawardDone).toBe(true);
  });
  it("rejects a continuation for another company without reading or writing source data", async () => {
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({ companyId: OTHER }) });
    expect(result.status).toBe("error");
    expect(mocks.page).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("preserves debt when the frozen verified entity changes", async () => {
    links[0].government_entity_id = OTHER;
    const prior = continuation({ seenSubawardIds: ["A"] });
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: prior });
    expect(result.status).toBe("error"); expect(result.subawardContinuation).toEqual(prior);
    expect(mocks.page).not.toHaveBeenCalled(); expect(metricWrites).toHaveLength(0);
  });
  it("does not mark a failed trigger/persistence ID as completed", async () => {
    mocks.page.mockResolvedValue({ rows: [row("A"), row("B")], hasNext: false });
    mocks.trigger.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("trigger write unavailable"));
    const result = await sweepUsaspendingSubawardsCompany(company);
    expect(result.status).toBe("error"); expect(result.subawardDone).toBe(false);
    expect(result.subawardContinuation?.seenSubawardIds).toEqual(["A"]);
    expect(metricWrites).toHaveLength(0);
  });
  it("keeps finalization continuation on metric failure", async () => {
    metricsError = "metrics unavailable";
    const result = await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: continuation({ nameIndex: 1 }) });
    expect(result.status).toBe("error"); expect(result.subawardDone).toBe(false);
    expect(result.subawardContinuation?.nameIndex).toBe(1);
  });
  it("does not advance an unattempted subaward company after shared deadline", async () => {
    let now = 100; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.rpc.mockResolvedValue({ data: [company, { ...company, id: OTHER }], error: null });
    mocks.page.mockImplementation(async () => { now = 1100; return { rows: [], hasNext: false }; });
    const result = await sweepUsaspendingSubawardsTamBatch(2, 0, "verified", null, { deadlineMs: 1000 });
    expect(result).toMatchObject({ checked: 1, done: false, cursorPatch: { afterCompanyId: ID } });
    expect(result.receipts).toHaveLength(1);
  });
  it("does not advance an unattempted prime-award company after shared deadline", async () => {
    let now = 100; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.rpc.mockResolvedValue({ data: [company, { ...company, id: OTHER }], error: null });
    mocks.primePage.mockImplementation(async () => { now = 1100; return { rows: [], hasNext: false }; });
    const result = await sweepUsaspendingTamBatch(2, 0, { scope: "verified", deadlineMs: 1000 });
    expect(result).toMatchObject({ checked: 1, done: false, cursorPatch: { afterCompanyId: ID } });
    expect(result.receipts).toHaveLength(1);
  });
});
