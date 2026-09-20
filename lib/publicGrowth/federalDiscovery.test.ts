import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/companyIdentity", () => ({ enrichCompanyIdentity: async (company: any) => ({ ...company,
  legalNames: company.legalNames ?? [], addresses: company.addresses ?? [] }) }));
const mocks = vi.hoisted(() => ({ from: vi.fn(), search: vi.fn(), detail: vi.fn(), deadline: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }),
  withServiceDeadline: (deadline: number, fn: () => Promise<unknown>) => { mocks.deadline(deadline); return fn(); } }));
vi.mock("./http", async (original) => ({ ...await original<typeof import("./http")>(), fetchJson: mocks.search }));
vi.mock("./usaspending", async (original) => ({ ...await original<typeof import("./usaspending")>(), fetchAwardDetail: mocks.detail }));
vi.mock("./storage", async () => { const { createHash } = await import("node:crypto"); return { stableHash: (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex") }; });
vi.mock("./federalIdentityResolution", () => ({ resolveFederalIdentity: mocks.resolve,
  FederalIdentityDeferredError: class FederalIdentityDeferredError extends Error { constructor(readonly reason: string) { super(reason); } } }));
import { discoverFederalBatch, discoverFederalCompany } from "./federalDiscovery";
import { decideIdentityMatch } from "./identity";
import { FederalIdentityDeferredError } from "./federalIdentityResolution";

const ID = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const UEI = "ABCDEFGHIJKL";
const company = { id: ID, name: "Acme Aerospace Inc", domain: "acme.test", website_raw: null, city: "Austin", state: "TX",
  addresses: [{ addressLine1: "100 Main Street", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US",
    sourceKind: "netsuite_record", sourceId: "record-123", capturedAt: "2026-09-19T00:00:00Z" }],
  netsuite_internal_id: "123", lists: ["netsuite_tam"], status: "new" };
const sourceRow = { generated_internal_id: "A1", "Award ID": "PIID1", "Recipient Name": company.name, "Recipient UEI": UEI };
const sourceDetail = { generated_unique_award_id: "A1", piid: "PIID1", type: "D", total_obligation: 10,
  recipient: { recipient_name: company.name, recipient_uei: UEI, recipient_hash: "recipient1", location: {
    address_line1: "100 Main St", city_name: "Austin", state_code: "TX", zip5: "78701", location_country_code: "USA" } } };
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
          tables[table].push({ id: table === "government_entities" ? [ENTITY,OTHER].find(id=>!tables.government_entities.some(row=>row.id===id)) : `stored-award${tables[table].length || ""}`, ...payload });
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
  mocks.resolve.mockImplementation(async (company,candidate)=>decideIdentityMatch(company,candidate));
});
afterEach(() => vi.restoreAllMocks());

describe("bounded federal discovery", () => {
  it("requires sourced street evidence when a fresh government recipient has no website", async () => {
    tables.companies[0].addresses = [];
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "in_progress", reason: "candidate_identity_evaluated", mayHaveWritten: false, candidateDecision: { candidate: { uei: UEI }, decision: { status: "pending" } } });
    expect(writes).toEqual([]);
  });
  it("retrieves a sourced legal alias and binds it using the account's address without leaking CRM address text", async () => {
    tables.companies[0].name = "Acme Brand";
    tables.companies[0].legalNames = [company.name];
    mocks.search.mockResolvedValueOnce({ results: [], page_metadata: { hasNext: false } })
      .mockResolvedValueOnce({ results: [sourceRow], page_metadata: { hasNext: false } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", reason: "next_verified_alias" });
    const result = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(result.status).toBe("matched");
    expect(JSON.parse(mocks.search.mock.calls[1][1].body).filters.recipient_search_text).toEqual([company.name]);
    const binding = writes.find((write) => write.table === "company_government_matches");
    expect(binding?.payload.match_method).toBe("exact_name_address");
    expect(JSON.stringify(binding?.payload.evidence)).not.toMatch(/100 Main|78701/);
    expect(binding?.payload.evidence.addressEvidence[0]).toMatchObject({ sourceId: "record-123", streetMatch: true });
  });
  it("persists provider cursors and independently enrolls matching recipients on successive pages", async () => {
    mocks.search.mockResolvedValueOnce({ results: [sourceRow], page_metadata: {
      hasNext: true, last_record_unique_id: 123, last_record_sort_value: "1693526400000",
    } }).mockResolvedValueOnce({ results: [{ ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }],
      page_metadata: { hasNext: false, last_record_unique_id: null, last_record_sort_value: "None" } });
    mocks.detail.mockResolvedValueOnce(sourceDetail).mockResolvedValueOnce({ ...sourceDetail, generated_unique_award_id: "A2",
      recipient: { ...sourceDetail.recipient, recipient_uei: "ZZZZZZZZZZZZ", recipient_hash: "recipient2" } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "matched", continuation: { page: 2,
      searchAfter: { lastRecordUniqueId: 123, lastRecordSortValue: "1693526400000" }, candidate: null, foundVerified: true } });
    const next = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(next).toMatchObject({ status: "matched", entityId: OTHER, continuation: { collection: "idvs" } });
    const body = JSON.parse(mocks.search.mock.calls[1][1].body);
    expect(body).toMatchObject({ last_record_unique_id: 123, last_record_sort_value: "1693526400000",
      filters: { recipient_search_text: [company.name], time_period: [{ start_date: "2007-10-01", end_date: first.continuation?.searchEndDate }] } });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(tables.government_entities.map(row => row.uei)).toEqual([UEI, "ZZZZZZZZZZZZ"]);
  });
  it("keeps a missing sequential pair partial without additional enrollment writes", async () => {
    mocks.search.mockResolvedValueOnce({ results: [sourceRow], page_metadata: {
      hasNext: true, last_record_unique_id: 123, last_record_sort_value: "1693526400000",
    } }).mockResolvedValueOnce({ results: [{ ...sourceRow, generated_internal_id: "A2" }], page_metadata: { hasNext: true } });
    const first = await discoverFederalCompany(ID);
    const before = structuredClone(writes);
    const second = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(second).toMatchObject({ status: "error", historyComplete: false, continuation: first.continuation });
    expect(writes).toEqual(before);
  });
  it("processes a legacy saved candidate before restarting its over-budget unread page", async () => {
    mocks.search.mockResolvedValue({ results: [sourceRow], page_metadata: { hasNext: true } });
    const first = await discoverFederalCompany(ID);
    const prior = { ...first.continuation!, page: 501, candidate: { id: "A1", name: company.name, uei: UEI } };
    delete prior.evaluatedRecipients; delete prior.foundVerified;
    const saved = await discoverFederalCompany(ID, { continuation: prior });
    expect(saved).toMatchObject({ status: "matched", sourceRequests: 1, continuation: { page: 501, candidate: null } });
    const before = structuredClone(writes);
    const restart = await discoverFederalCompany(ID, { continuation: saved.continuation });
    expect(restart).toMatchObject({ status: "in_progress", sourceRequests: 0, continuation: {
      ...saved.continuation, page: 1, lastPageHash: null, searchAfter: null,
    } });
    expect(writes).toEqual(before);
    expect(restart.searchEndDate).toBe(first.searchEndDate);
  });
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
    const contracts = await discoverFederalCompany(ID);
    expect(contracts).toMatchObject({ status: "in_progress", continuation: { collection: "idvs", page: 1 } });
    expect(await discoverFederalCompany(ID, { continuation: contracts.continuation })).toMatchObject({ status: "no_candidate", exhaustive: false, historyComplete: false, sourceRequests: 1 });
    expect(JSON.parse(mocks.search.mock.calls[1][1].body).filters.award_type_codes).toContain("IDV_B");
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
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "in_progress", sourceRequests: 1 });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
  it("durably processes every plausible recipient on a page without repeating its source search", async () => {
    mocks.search.mockResolvedValue({ results: [sourceRow, { ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }],
      page_metadata: { hasNext: true, last_record_unique_id: 12, last_record_sort_value: "sort" } });
    mocks.detail.mockResolvedValueOnce(sourceDetail).mockResolvedValueOnce({ ...sourceDetail, generated_unique_award_id: "A2",
      recipient: { ...sourceDetail.recipient, recipient_uei: "ZZZZZZZZZZZZ", recipient_hash: "recipient2" } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "matched", continuation: { page: 1, candidate: { id: "A2" },
      pendingPage: { hasNext: true, nextCursor: { lastRecordUniqueId: 12, lastRecordSortValue: "sort" } } } });
    const second = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(second).toMatchObject({ status: "matched", continuation: { page: 2, candidate: null,
      searchAfter: { lastRecordUniqueId: 12, lastRecordSortValue: "sort" } } });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.detail.mock.calls.map(call => call[0])).toEqual(["A1", "A2"]);
    expect(tables.company_government_matches).toHaveLength(2);
  });
  it("uses official detail identifiers when the search row omits UEI", async () => {
    mocks.search.mockResolvedValue({ results: [{ ...sourceRow, "Recipient UEI": null }], page_metadata: { hasNext: false } });
    mocks.detail.mockResolvedValue({ ...sourceDetail, recipient: { ...sourceDetail.recipient, recipient_uei: null } });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "matched", candidateDecision: {
      candidate: { uei: null, recipientId: "recipient1" } } });
    expect(tables.government_entities[0]).toMatchObject({ uei: null, usaspending_recipient_id: "recipient1" });
  });
  it("journals an unverified name-only hit without binding it or stopping the remaining search", async () => {
    mocks.detail.mockResolvedValue({ ...sourceDetail, recipient: { ...sourceDetail.recipient, location: { state_code: "CA", city_name: "Oakland" } } });
    expect(await discoverFederalCompany(ID)).toMatchObject({ status: "in_progress", reason: "candidate_identity_evaluated", candidateDecision: { decision: { status: "pending" } } });
    expect(writes).toEqual([]);
  });
  it.each(["award", "UEI"])("rejects a detail %s mismatch before writes", async (kind) => {
    const detail = structuredClone(sourceDetail);
    if (kind === "award") detail.generated_unique_award_id = "A2";
    if (kind === "UEI") detail.recipient.recipient_uei = "ZZZZZZZZZZZZ";
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
  it.each(["identifier conflict", "award conflict"])("preserves %s without writes", async (kind) => {
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
  it("continues after an unverified first recipient and independently evaluates the next page", async () => {
    mocks.search.mockResolvedValueOnce({ results: [sourceRow], page_metadata: { hasNext: true } })
      .mockResolvedValueOnce({ results: [{ ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }], page_metadata: { hasNext: false } });
    mocks.resolve.mockResolvedValueOnce({ status: "pending", method: "jev_insufficient", confidence: 0, evidence: { native: { answer: "insufficient_evidence" } } });
    mocks.detail.mockResolvedValueOnce(sourceDetail).mockResolvedValueOnce({ ...sourceDetail, generated_unique_award_id: "A2",
      recipient: { ...sourceDetail.recipient, recipient_uei: "ZZZZZZZZZZZZ", recipient_hash: "recipient2" } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", candidateDecision: { decision: { status: "pending", evidence: { native: { answer: "insufficient_evidence" } } } } });
    expect(writes).toEqual([]);
    expect(await discoverFederalCompany(ID, { continuation: first.continuation })).toMatchObject({ status: "matched" });
    expect(tables.government_entities.map(row => row.uei)).toEqual(["ZZZZZZZZZZZZ"]);
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
  it("passes differing official legal names to the resolver and preserves its native decision", async () => {
    mocks.detail.mockResolvedValue({ ...sourceDetail, recipient: { ...sourceDetail.recipient, recipient_name: "Acme Holdings LLC" } });
    const decision = { status: "verified", method: "jev_identity", confidence: 0.96,
      evidence: { jevIdentity: { outcome: "same_company", nativeJev: { answers: { relationship: "same_company" } } } } };
    mocks.resolve.mockResolvedValue(decision);
    const result = await discoverFederalCompany(ID);
    expect(result).toMatchObject({ status: "matched", candidateDecision: { candidate: { name: "Acme Holdings LLC" }, decision } });
    expect(mocks.resolve.mock.calls[0][1]).toMatchObject({ legalName: "Acme Holdings LLC", uei: UEI });
    expect(tables.company_government_matches[0]).toMatchObject({ verified_by: "jev_identity", match_method: "jev_identity", evidence: decision.evidence });
  });
  it("advances past a different intact recipient in a bound broad-name search", async () => {
    tables.government_entities.push({ id: ENTITY, legal_name: company.name, uei: UEI, usaspending_recipient_id: "recipient1" });
    tables.company_government_matches.push({ company_id: ID, government_entity_id: ENTITY, match_status: "verified" });
    mocks.search.mockResolvedValueOnce({ results: [], page_metadata: { hasNext: false } })
      .mockResolvedValueOnce({ results: [{ ...sourceRow, generated_internal_id: "OTHER_AWARD", "Recipient UEI": null }, sourceRow],
        page_metadata: { hasNext: false } });
    const start = await discoverFederalCompany(ID);
    expect(start.continuation?.targetIndex).toBe(1);
    mocks.detail.mockResolvedValueOnce({ ...sourceDetail, generated_unique_award_id: "OTHER_AWARD",
      recipient: { ...sourceDetail.recipient, recipient_uei: "ZZZZZZZZZZZZ", recipient_hash: "recipient2" } })
      .mockResolvedValueOnce(sourceDetail);
    const skipped = await discoverFederalCompany(ID, { continuation: start.continuation });
    expect(skipped).toMatchObject({ status: "in_progress", reason: "different_bound_recipient_skipped",
      candidateDecision: { decision: { status: "rejected", evidence: { reason: "different_bound_recipient" } } },
      continuation: { candidate: { id: "A1" } } });
    expect(writes).toEqual([]);
    expect(await discoverFederalCompany(ID, { continuation: skipped.continuation })).toMatchObject({ status: "matched", entityId: ENTITY });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(tables.federal_awards.map(row => row.generated_award_id)).toEqual(["A1"]);
  });
  it.each(["pending", "rejected"])("preserves an exact %s link while continuing to another candidate", async (status) => {
    tables.government_entities.push({ id: ENTITY, legal_name: company.name, uei: UEI, usaspending_recipient_id: "recipient1" });
    tables.company_government_matches.push({ company_id: ID, government_entity_id: ENTITY, match_status: status });
    mocks.search.mockResolvedValue({ results: [sourceRow, { ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }],
      page_metadata: { hasNext: false } });
    mocks.detail.mockResolvedValueOnce(sourceDetail).mockResolvedValueOnce({ ...sourceDetail, generated_unique_award_id: "A2",
      recipient: { ...sourceDetail.recipient, recipient_uei: "ZZZZZZZZZZZZ", recipient_hash: "recipient2" } });
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", reason: "existing_candidate_decision_preserved",
      candidateDecision: { decision: { status } }, continuation: { candidate: { id: "A2" } } });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    expect(await discoverFederalCompany(ID, { continuation: first.continuation })).toMatchObject({ status: "matched", entityId: OTHER });
    expect(tables.company_government_matches[0].match_status).toBe(status);
  });
  it("retains selected candidate, tail and cursor when native evaluation is deferred", async () => {
    mocks.search.mockResolvedValue({ results: [sourceRow, { ...sourceRow, generated_internal_id: "A2", "Recipient UEI": "ZZZZZZZZZZZZ" }],
      page_metadata: { hasNext: true, last_record_unique_id: 123, last_record_sort_value: "sort" } });
    mocks.resolve.mockRejectedValueOnce(new FederalIdentityDeferredError("budget"));
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", reason: "identity_evaluation_deferred", mayHaveWritten: false,
      continuation: { candidate: { id: "A1" }, candidateQueue: [{ id: "A2" }],
        pendingPage: { nextCursor: { lastRecordUniqueId: 123, lastRecordSortValue: "sort" } } } });
    expect(writes).toEqual([]);
    const resumed = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(resumed).toMatchObject({ status: "matched", continuation: { candidate: { id: "A2" }, page: 1 } });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.detail.mock.calls.map(call => call[0])).toEqual(["A1", "A1"]);
  });
  it("finishes contracts and vehicles with prior verified matches retained", async () => {
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "matched", continuation: { collection: "idvs", foundVerified: true } });
    mocks.search.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    const final = await discoverFederalCompany(ID, { continuation: first.continuation });
    expect(final).toMatchObject({ status: "matched", reason: "candidate_search_completed_with_verified_matches", mayHaveWritten: false });
    expect(final.continuation).toBeUndefined();
  });
  it("does not infer direct enrollment from a native related-company decision", async () => {
    const decision = { status: "pending", method: "jev_related", confidence: 0.97,
      evidence: { jevIdentity: { outcome: "related_company", relationship: "subsidiary" } } };
    mocks.resolve.mockResolvedValue(decision);
    const first = await discoverFederalCompany(ID);
    expect(first).toMatchObject({ status: "in_progress", candidateDecision: { decision } });
    expect(writes).toEqual([]);
    mocks.search.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    expect(await discoverFederalCompany(ID, { continuation: first.continuation })).toMatchObject({ status: "no_candidate", verified: false });
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
