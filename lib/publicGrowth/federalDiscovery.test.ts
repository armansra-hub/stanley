import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ from: vi.fn(), search: vi.fn(), detail: vi.fn(), deadline: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }),
  withServiceDeadline: (deadline: number, fn: () => Promise<unknown>) => { mocks.deadline(deadline); return fn(); } }));
vi.mock("./http", async (original) => ({ ...await original<typeof import("./http")>(), fetchJson: mocks.search }));
vi.mock("./usaspending", async (original) => ({ ...await original<typeof import("./usaspending")>(), fetchAwardDetail: mocks.detail }));
vi.mock("./storage", () => ({ stableHash: (v: unknown) => JSON.stringify(v) }));
import { discoverFederalBatch, discoverFederalCompany } from "./federalDiscovery";

const ID = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const UEI = "ABCDEFGHIJKL";
const company = { id: ID, name: "Acme Aerospace Inc", domain: "acme.test", website_raw: null, city: "Austin", state: "TX",
  netsuite_internal_id: "123", lists: ["netsuite_tam"], status: "new" };
const sourceRow = { generated_internal_id: "A1", "Award ID": "PIID1", "Recipient Name": company.name, "Recipient UEI": UEI };
const sourceDetail = { generated_unique_award_id: "A1", piid: "PIID1", type: "D", total_obligation: 10,
  recipient: { recipient_name: company.name, recipient_uei: UEI, recipient_hash: "recipient1", location: { city_name: "Austin", state_code: "TX" } } };
let tables: Record<string, any[]>;
let writes: Array<{ table: string; payload: any; options: any }>;
let readHook: ((table: string, filters: Record<string, unknown>) => unknown) | undefined;
let writeHook: ((table: string, payload: any) => unknown) | undefined;
let queryError: string | undefined;
function query(table: string) {
  const filters: Record<string, unknown> = {};
  let single = false, limit = Infinity, payload: any, options: any, selected = "";
  const q: any = {
    select: (value: string) => { selected = value; return q; }, eq: (k: string, v: unknown) => { filters[k] = v; return q; }, contains: () => q, neq: () => q,
    limit: (n: number) => { limit = n; return q; }, maybeSingle: () => { single = true; return q; },
    insert: (p: any) => { payload = p; options = { insert: true }; return q; },
    upsert: (p: any, o: any) => { payload = p; options = o; return q; },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => {
      if (queryError === table) return { data: null, error: { message: "private DB error" } };
      if (payload) {
        writes.push({ table, payload, options });
        const custom = writeHook?.(table, payload); if (custom) return custom;
        const keys = options.onConflict?.split(",") ?? ["uei"];
        if (!tables[table].some((r) => keys.every((key: string) => r[key] === payload[key]))) {
          tables[table].push({ id: table === "government_entities" ? ENTITY : "stored-award", ...payload });
        }
        return { data: null, error: null };
      }
      const custom = readHook?.(table, filters); if (custom) return custom;
      let rows = (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)).slice(0, limit);
      if (selected.includes("government_entities!inner")) rows = rows.map((row) => ({ ...row,
        government_entities: tables.government_entities.find((entity) => entity.id === row.government_entity_id) }));
      return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
    }).then(resolve, reject),
  };
  return q;
}
beforeEach(() => {
  vi.resetAllMocks(); readHook = undefined; writeHook = undefined; queryError = undefined; writes = [];
  tables = { companies: [structuredClone(company)], government_entities: [], company_government_matches: [], federal_awards: [] };
  mocks.from.mockImplementation(query);
  mocks.search.mockResolvedValue({ results: [sourceRow], page_metadata: { hasNext: false } });
  mocks.detail.mockResolvedValue(structuredClone(sourceDetail));
});
afterEach(() => vi.restoreAllMocks());

describe("bounded federal discovery", () => {
  it("enrolls an exact current identity and one award, without any history or signal writes", async () => {
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    const result = await discoverFederalCompany(ID);
    expect(result).toMatchObject({ status: "matched", verified: true, historyComplete: false, exhaustive: false,
      sourceRequests: 2, entityId: ENTITY, awardId: "stored-award", mayHaveWritten: true });
    expect(writes.map((w) => w.table)).toEqual(["government_entities", "company_government_matches", "federal_awards"]);
    expect(writes[1].options.ignoreDuplicates).toBe(true); expect(writes[2].options.ignoreDuplicates).toBe(true);
    expect(writes[2].payload.source_url).toBe("https://www.usaspending.gov/award/A1/latest");
    expect(mocks.deadline.mock.calls[0][0] - start).toBeLessThanOrEqual(60000);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0].slice(2, 4)).toEqual([20000, 1]);
    expect(JSON.parse(mocks.search.mock.calls[0][1].body)).toMatchObject({ page: 1, limit: 100 });
    expect(mocks.detail).toHaveBeenCalledWith("A1", 1, mocks.deadline.mock.calls[0][0]);
  });
  it.each(["absent", "removed", "foreign list"])("refuses %s canonical membership before provider work", async (kind) => {
    if (kind === "absent") tables.companies = [];
    if (kind === "removed") tables.companies[0].status = "removed_from_tam";
    if (kind === "foreign list") tables.companies[0].lists = [];
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "error", reason: "not_current_canonical_tam", sourceRequests: 0 });
    expect(mocks.search).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("accepts NULL status exactly as the canonical current-TAM selector does", async () => {
    tables.companies[0].status = null;
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "matched" });
  });
  it.each([{}, { results: [], page_metadata: {} }, { results: [{}], page_metadata: { hasNext: false } }])("does not turn malformed source shape into no candidate", async (data) => {
    mocks.search.mockResolvedValue(data);
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "error", reason: "invalid_search_response" });
    expect(writes).toEqual([]);
  });
  it("labels a valid empty page as only a bounded attempt, never absence/history completion", async () => {
    mocks.search.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "no_candidate", exhaustive: false, historyComplete: false, sourceRequests: 1 });
    expect(mocks.detail).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("includes the requested sort field, as required by the observed USAspending400 response", async () => {
    mocks.search.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      // The actual provider rejects this request before searching when its sort
      // field is omitted, even though all requested recipient fields are valid.
      if (!body.fields.includes(body.sort)) throw new Error("400 Bad Request: Sort value 'Start Date' not found in requested fields");
      expect(body.sort).toBe("Start Date");
      return { results: [], page_metadata: { hasNext: false } };
    });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "no_candidate", sourceRequests: 1 });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
  it.each(["different recipients", "missing UEI"])("retains ambiguity for %s rather than selecting first identity", async (kind) => {
    const rows = kind === "different recipients" ? [sourceRow, { ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }]
      : kind === "missing UEI" ? [{ ...sourceRow, "Recipient UEI": null }] : [sourceRow];
    mocks.search.mockResolvedValue({ results: rows, page_metadata: { hasNext: false } });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "ambiguous", verified: false });
    expect(mocks.detail).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("requires the existing name/state identity rule and rejects an unverified name-only hit", async () => {
    mocks.detail.mockResolvedValue({ ...sourceDetail, recipient: { ...sourceDetail.recipient, location: { state_code: "CA", city_name: "Oakland" } } });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "ambiguous", reason: "identity_not_verified" });
    expect(writes).toEqual([]);
  });
  it.each(["award", "UEI", "name"])("rejects a detail %s mismatch before writes", async (kind) => {
    const detail = structuredClone(sourceDetail);
    if (kind === "award") detail.generated_unique_award_id = "A2";
    if (kind === "UEI") detail.recipient.recipient_uei = "ZZZZZZZZZZZZ";
    if (kind === "name") detail.recipient.recipient_name = "Other Aerospace";
    mocks.detail.mockResolvedValue(detail);
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "error", reason: "award_identity_mismatch" });
    expect(writes).toEqual([]);
  });
  it("preserves all existing SAM entity bytes and a verified match", async () => {
    const existing = { id: ENTITY, legal_name: company.name, uei: UEI, usaspending_recipient_id: "recipient1", source: "SAM", evidence: { registration: "preserve" } };
    tables.government_entities.push(structuredClone(existing));
    const link = { company_id: ID, government_entity_id: ENTITY, match_status: "verified", evidence: { manuallyVerified: true } };
    tables.company_government_matches.push(structuredClone(link));
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "matched" });
    expect(tables.government_entities).toEqual([existing]); expect(tables.company_government_matches).toEqual([link]);
    expect(writes.some((w) => w.table === "government_entities")).toBe(false);
  });
  it.each(["rejected link", "identifier conflict", "award conflict"])("preserves %s without writes", async (kind) => {
    tables.government_entities.push({ id: ENTITY, legal_name: company.name, uei: UEI, usaspending_recipient_id: kind === "identifier conflict" ? "other" : "recipient1" });
    if (kind.endsWith("link")) tables.company_government_matches.push({ company_id: ID, government_entity_id: kind === "other link" ? OTHER : ENTITY, match_status: kind === "rejected link" ? "rejected" : "verified" });
    if (kind === "award conflict") tables.federal_awards.push({ id: "existing", generated_award_id: "A1", government_entity_id: OTHER });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "ambiguous" }); expect(writes).toEqual([]);
  });
  it("keeps a truncated name search pending and discovers an exact candidate on a later page", async () => {
    mocks.search.mockResolvedValueOnce({ results: [{ ...sourceRow, "Recipient Name": "Unrelated" }], page_metadata: { hasNext: true } })
      .mockResolvedValueOnce({ results: [sourceRow], page_metadata: { hasNext: false } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", mayHaveWritten: false, continuation: { page: 2, candidate: null } });
    expect(writes).toEqual([]);
    const final = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(final).toMatchObject({ status: "matched" });
    expect(JSON.parse(mocks.search.mock.calls[1][1].body).page).toBe(2);
  });
  it("retains cross-page ambiguity and never binds the first same-name recipient", async () => {
    mocks.search.mockResolvedValueOnce({ results: [sourceRow], page_metadata: { hasNext: true } })
      .mockResolvedValueOnce({ results: [{ ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }], page_metadata: { hasNext: false } });
    const first = await discoverFederalCompany(ID);
    expect(first.status).toBe("in_progress");
    expect(await discoverFederalCompany(ID, { continuation: first.continuation })).toMatchObject({ status: "ambiguous", reason: "recipient_identity_ambiguous" });
    expect(writes).toEqual([]); expect(mocks.detail).not.toHaveBeenCalled();
  });
  it("uses verified identifiers through legal-name changes and permits another verified entity", async () => {
    tables.government_entities = [{ id: ENTITY, legal_name: "Previous Legal Name", dba_name: company.name, uei: UEI, usaspending_recipient_id: "recipient1" },
      { id: OTHER, legal_name: "Acme Subsidiary", uei: "ZZZZZZZZZZZZ", usaspending_recipient_id: "recipient2" }];
    tables.company_government_matches = [ENTITY, OTHER].map((id) => ({ company_id: ID, government_entity_id: id, match_status: "verified" }));
    const before = structuredClone(tables.government_entities);
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "matched", entityId: ENTITY });
    expect(JSON.parse(mocks.search.mock.calls[0][1].body).filters.recipient_search_text).toEqual([UEI]);
    expect(tables.government_entities).toEqual(before);
  });
  it("fails closed when a frozen verified identifier changes between pages", async () => {
    tables.government_entities = [{ id: ENTITY, legal_name: company.name, uei: UEI, usaspending_recipient_id: "recipient1" }];
    tables.company_government_matches = [{ company_id: ID, government_entity_id: ENTITY, match_status: "verified" }];
    mocks.search.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    const first = await discoverFederalCompany(ID);
    expect(first.status).toBe("in_progress");
    tables.government_entities[0].uei = "ZZZZZZZZZZZZ";
    expect(await discoverFederalCompany(ID, { continuation: first.continuation })).toMatchObject({ status: "error", sourceRequests: 0 });
    expect(writes).toEqual([]);
  });
  it("rechecks exact membership and identity after the provider response", async () => {
    mocks.detail.mockImplementation(async () => { tables.companies[0].state = "CA"; return sourceDetail; });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "ambiguous", reason: "company_identity_changed" });
    expect(writes).toEqual([]);
  });
  it("does not overwrite a rejected match inserted concurrently at the write boundary", async () => {
    writeHook = (table) => {
      if (table === "company_government_matches") tables.company_government_matches.push({ company_id: ID, government_entity_id: ENTITY, match_status: "rejected" });
    };
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "ambiguous", reason: "conflicting_existing_link", mayHaveWritten: true });
    expect(tables.company_government_matches[0].match_status).toBe("rejected"); expect(tables.federal_awards).toEqual([]);
  });
  it("retains partial-write uncertainty when award persistence fails", async () => {
    writeHook = (table) => table === "federal_awards" ? { data: null, error: { code: "57014", message: "timeout" } } : undefined;
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "error", reason: "database_operation_failed", mayHaveWritten: true, verified: false });
  });
  it("fails closed on existing-entity read errors", async () => {
    queryError = "government_entities";
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "error", reason: "database_operation_failed" }); expect(writes).toEqual([]);
  });
  it.each([[new Error("429 Too Many Requests: secret"), "rate_limited", 429], [new DOMException("private", "AbortError"), "request_timeout", undefined]])("reports safe failure metadata with no retry", async (error, failureClass, httpStatus) => {
    mocks.search.mockRejectedValue(error);
    const result = await discoverFederalCompany(ID);
    expect(result).toMatchObject({ status: "error", failureClass, sourceRequests: 1 }); expect(result.httpStatus).toBe(httpStatus);
    expect(JSON.stringify(result)).not.toMatch(/secret|private/); expect(mocks.search).toHaveBeenCalledTimes(1); expect(writes).toEqual([]);
  });
  it("does not start a source request after an expired deadline", async () => {
    expect(await discoverFederalCompany(ID, { deadlineMs: Date.now() - 1 })).toMatchObject({ status: "error", failureClass: "deadline", sourceRequests: 0 });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("caps parallel work at four, preserves input order and exposes untouched IDs after429", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`);
    tables.companies = ids.map((id) => ({ ...company, id }));
    const pending: Array<() => void> = [];
    let active = 0, maxActive = 0;
    mocks.search.mockImplementation(() => new Promise((_, reject) => { active++; maxActive = Math.max(maxActive, active);
      pending.push(() => { active--; reject(new Error("429 Too Many Requests")); }); }));
    const run = discoverFederalBatch(ids);
    await vi.waitFor(() => expect(pending).toHaveLength(4)); pending.forEach((resolve) => resolve());
    const result = await run;
    expect(maxActive).toBe(4); expect(result.receipts.map((r) => r.companyId)).toEqual(ids.slice(0, 4));
    expect(result.notAttemptedCompanyIds).toEqual(ids.slice(4));
  });
  it("rejects duplicate IDs and a concurrency override above four", async () => {
    await expect(discoverFederalBatch([ID, ID])).rejects.toThrow("invalid discovery batch");
    await expect(discoverFederalBatch([ID], { concurrency: 5 })).rejects.toThrow("invalid discovery concurrency");
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
