import { describe, expect, it } from "vitest";
import { MAX_REGISTRY_CAPTURE_BYTES, RegistryCaptureReadError, registryCompanyInScope, retainedRegistryCapture } from "./retainedRegistryCapture";
import { parseCoverageQuery } from "./manualCoverage";

const companyId = "2520364d-2ee3-4763-8f0c-65d26780faf4";
const at = "2026-10-07T20:54:11.905Z";
const carrier = { dot_number: "12345", legal_name: "Example Carrier LLC", phy_city: "Denver", phy_state: "CO", nbr_power_unit: "17", driver_total: "15", mcs150_date: "13-SEP-21" };
const url = (table: string, select: string, limit: number) => `https://${table === "kjg3-diqy" ? "data.transportation.gov" : "data.colorado.gov"}/resource/${table}.json?${new URLSearchParams({ $select: select, $where: "name like 'EXAMPLE%'", $limit: String(limit) })}`;
const carrierCapture = () => ({ sourceUrl: url("kjg3-diqy", Object.keys(carrier).join(","), 5), observedAt: at, rows: [{ ...carrier }] });
function state(sourceKey: "fmcsa" | "cosos" = "fmcsa") {
  return { company_id: companyId, source_key: sourceKey, complete: true, coverage_status: "complete", last_attempt_at: at, last_success_at: at,
    next_attempt_at: null, last_error: null as unknown, error_details: {}, cursor: sourceKey === "fmcsa" ? {
      collectionMode: "source_only", observedAt: at, query: "Example Carrier", truncated: false, matchedDot: "12345", priorSnapshotRead: true,
      comparisonBaselinePreserved: true, priorSnapshot: { nbr_power_unit: 12, driver_total: 13, captured_at: "2026-09-01T00:00:00Z" },
      records: [{ dot: "12345", legal: "Example Carrier LLC", dba: "", units: 17, drivers: 15, city: "Denver", state: "CO", mcs150: "13-SEP-21" }], rawCaptures: [carrierCapture()],
    } : { collectionMode: "source_only", observedAt: at, query: "Example Services", truncated: false, entitySince: "2026-05-10T00:00:00", uccSince: "2025-10-07T00:00:00",
      entities: [], filings: [], rawCaptures: [
        { table: "entity", sourceUrl: url("4ykn-tg5h", "entityname,entityid,entityformdate,entitytype,entitystatus,principalcity", 10), observedAt: at, rows: [] },
        { table: "debtor", sourceUrl: url("8upq-58vz", "organizationname,city,fileid", 25), observedAt: at, rows: [] },
      ],
    } } as Record<string, any>;
}
const read = (row = state()) => retainedRegistryCapture(row, companyId, row.source_key as "fmcsa" | "cosos");
describe("exact retained public registry readback", () => {
  it("returns every raw field and date plus the unchanged prior baseline with canonical representation hashes", () => {
    const row = state();
    row.cursor.rawCaptures[0].rows[0].unanticipated_public_field = { nested: ["whole😀\ntext", null, 5] };
    const result = read(row) as any;
    expect(result.retained.rawCaptures[0].rows).toEqual(row.cursor.rawCaptures[0].rows);
    expect(result.retained.priorSnapshot).toEqual(row.cursor.priorSnapshot);
    expect(result.retained.rawCaptures[0]).toMatchObject({ unknownPublicRowFields: ["unanticipated_public_field"], rowCount: 1, observedAt: at });
    expect(result).toMatchObject({ retainedCaptureAvailable: true, retainedCaptureCount: 1, retainedRawRowCount: 1, boundedLookupComplete: true, analysisComplete: false, responseTruncated: false, hashBasis: "canonical_retained_representation_not_http_bytes" });
    expect(result.retainedVersionSha256).toMatch(/^[0-9a-f]{64}$/);
    const reordered = structuredClone(row); reordered.cursor.rawCaptures[0].rows[0] = Object.fromEntries(Object.entries(row.cursor.rawCaptures[0].rows[0]).reverse());
    expect(read(reordered).retainedVersionSha256).toBe(result.retainedVersionSha256);
    reordered.cursor.rawCaptures[0].rows[0].driver_total = "16";
    expect(read(reordered).retainedVersionSha256).not.toBe(result.retainedVersionSha256);
  });
  it("projects away unknown operational cursor fields, error bodies and nested capture metadata", () => {
    const row = state(); row.last_error = "SUPER_SECRET_ERROR"; row.error_details = { token: "SUPER_SECRET_DETAILS" };
    row.cursor.providerRequest = { token: "SUPER_SECRET_CURSOR" }; row.cursor.rawCaptures[0].authorization = "SUPER_SECRET_HEADER";
    const result = read(row) as any;
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET");
    expect(result).toMatchObject({ boundedLookupComplete: false, sourceState: { hasError: true }, omittedCursorFieldCount: 1 });
    expect(result.retained.rawCaptures[0].omittedCaptureMetadataFieldCount).toBe(1);
  });
  it.each(["password", "access_token", "apiKey", "Authorization", "clientSecret", "lease_token"])("fails closed rather than redact a credential-shaped public row field: %s", key => {
    const row = state(); row.cursor.rawCaptures[0].rows[0][key] = "KEEP_PRIVATE";
    expect(() => read(row)).toThrow("unsafe_retained_evidence");
  });
  it.each(["Bearer abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----", "api_key=KEEP_PRIVATE"])("rejects credential-shaped values", value => {
    const row = state(); row.cursor.rawCaptures[0].rows[0].public_note = value;
    expect(() => read(row)).toThrow("unsafe_retained_evidence");
  });
  it.each(["https://evil.test/resource/kjg3-diqy.json?x=1", "https://user:pass@data.transportation.gov/resource/kjg3-diqy.json", "https://data.transportation.gov/resource/kjg3-diqy.json?token=PRIVATE"])("rejects non-public or credential-bearing capture URL %s", sourceUrl => {
    const row = state(); row.cursor.rawCaptures[0].sourceUrl = sourceUrl;
    expect(() => read(row)).toThrow(RegistryCaptureReadError);
  });
  it("never treats a false-complete empty cursor without an actual provider capture as complete", () => {
    const row = state(); row.cursor.rawCaptures = []; row.cursor.records = []; row.cursor.matchedDot = null; row.cursor.priorSnapshot = null;
    expect(read(row)).toMatchObject({ retainedCaptureAvailable: false, boundedLookupComplete: false, sourceCompletenessIssues: ["required_raw_capture_missing"] });
  });
  it("preserves malformed original identity fields as evidence but cannot attest complete source capture", () => {
    const row = state(); row.cursor.rawCaptures[0].rows = [{ error: "upstream changed" }];
    const result = read(row) as any;
    expect(result.retained.rawCaptures[0].rows).toEqual([{ error: "upstream changed" }]);
    expect(result).toMatchObject({ boundedLookupComplete: false, sourceCompletenessIssues: ["raw_rows_have_invalid_required_fields"] });
  });
  it("keeps partial, error and independently detected result limits incomplete", () => {
    const row = state(); row.complete = false; row.coverage_status = "partial"; row.last_error = "limit";
    row.cursor.rawCaptures[0].rows = Array.from({ length: 5 }, () => ({ ...carrier }));
    const result = read(row);
    expect(result.boundedLookupComplete).toBe(false);
    expect(result).toMatchObject({ sourceCompletenessIssues: ["bounded_source_limit_reached", "collector_error_present", "collector_not_complete"] });
  });
  it("returns a missing cursor as an explicit absence, not a negative finding", () => {
    const row = state(); row.cursor = null;
    expect(read(row)).toMatchObject({ retainedCaptureAvailable: false, boundedLookupComplete: false, analysisComplete: false, reason: "no_retained_cursor" });
  });
  it("rejects oversize retained evidence without emitting a shortened complete payload", () => {
    const row = state(); row.cursor.rawCaptures[0].rows[0].public_note = "😀".repeat(MAX_REGISTRY_CAPTURE_BYTES / 4);
    expect(() => read(row)).toThrow("retained_capture_oversize");
  });
  it.each([null, "[]", [{ rows: "not-an-array" }]])("fails closed on malformed raw capture containers %j", captures => {
    const row = state(); row.cursor.rawCaptures = captures;
    expect(() => read(row)).toThrow("invalid_retained_schema");
  });
  it("requires exact company/source binding even after database filters", () => {
    const row = state(); row.company_id = "different";
    expect(() => read(row)).toThrow("retained_binding_mismatch");
    expect(() => retainedRegistryCapture(state(), companyId, "cosos")).toThrow("retained_binding_mismatch");
  });
  it("returns complete bounded Colorado empty lookups with both originals and their query windows", () => {
    const result = read(state("cosos")) as any;
    expect(result).toMatchObject({ retainedCaptureCount: 2, retainedRawRowCount: 0, boundedLookupComplete: true });
    expect(result.retained).toMatchObject({ entitySince: "2026-05-10T00:00:00", uccSince: "2025-10-07T00:00:00" });
  });
  it("preserves raw Colorado party errors and requires the party original for a captured filing", () => {
    const row = state("cosos"); row.cursor.rawCaptures.push({ table: "filing", sourceUrl: url("wffy-3uut", "fileid,filingdate,documenttype", 5), observedAt: at,
      rows: [{ fileid: "123", filingdate: "2026-10-01T00:00:00", documenttype: "UCC financing statement" }] });
    expect(read(row)).toMatchObject({ boundedLookupComplete: false, sourceCompletenessIssues: ["required_raw_capture_missing"] });
    row.cursor.rawCaptures.push({ table: "party", sourceUrl: url("ap62-sav4", "fileid,organizationname", 20), observedAt: at, rows: [{ fileid: "123" }] });
    expect(read(row)).toMatchObject({ boundedLookupComplete: false, sourceCompletenessIssues: ["raw_rows_have_invalid_required_fields"] });
  });
  it("does not certify an empty normalized filing list when raw debtors exist but the filing capture is missing", () => {
    const row = state("cosos");
    row.cursor.rawCaptures[1].rows = [{ fileid: "123", organizationname: "Example Services LLC", city: "Denver" }];
    const result = read(row) as any;
    expect(result.retained.filings).toEqual([]);
    expect(result.retained.rawCaptures[1].rows).toEqual(row.cursor.rawCaptures[1].rows);
    expect(result).toMatchObject({ boundedLookupComplete: false, sourceCompletenessIssues: ["required_raw_capture_missing"] });
  });
  it("does not require a filing fetch for prefix-only unrelated debtors the collector intentionally excludes", () => {
    const row = state("cosos");
    row.cursor.rawCaptures[1].rows = [{ fileid: "123", organizationname: "Example Services West LLC", city: "Denver" }];
    expect(read(row)).toMatchObject({ boundedLookupComplete: true, sourceCompletenessIssues: [] });
  });
  it("does not silently merge two retained versions", () => {
    const row = state(); row.cursor.rawCaptures.push(carrierCapture());
    expect(() => read(row)).toThrow("invalid_retained_schema");
  });
  it("includes canonical TAL outside TAM but excludes duplicate and unrelated accounts", () => {
    expect(registryCompanyInScope({ tal_claimed: true, lists: null, status: "removed_from_tam" }, "all")).toBe(true);
    expect(registryCompanyInScope({ tal_claimed: true, lists: ["tam_duplicate"], status: "active" }, "all")).toBe(false);
    expect(registryCompanyInScope({ tal_claimed: false, lists: [], status: "active" }, "all")).toBe(false);
    expect(registryCompanyInScope({ lists: ["netsuite_tam"], status: "active" }, "all")).toBe(true);
    expect(registryCompanyInScope({ tal_claimed: true, lists: [], status: "removed_from_tam" }, "tam")).toBe(false);
  });
  it.each([`view=registry-capture&sourceKey=fmcsa`, `view=registry-capture&companyId=${companyId}`, `view=registry-capture&companyId=${companyId}&sourceKey=news`,
    `view=registry-capture&companyId=${companyId}&sourceKey=fmcsa&limit=2`, `view=registry-capture&companyId=${companyId}&sourceKey=fmcsa&after=${companyId}`,
    `view=sources&companyId=${companyId}&sourceKey=fmcsa`, `view=registry-capture&companyId=${companyId}&sourceKey=fmcsa&sourceKey=cosos`])("rejects an inexact or broadened registry query %s", query => {
    expect(() => parseCoverageQuery(new URLSearchParams(query))).toThrow("invalid_query");
  });
});
