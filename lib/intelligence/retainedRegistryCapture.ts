import { createHash } from "node:crypto";
import { pick, type CoverageQuery } from "./manualCoverage";
import { lightNorm } from "../sources/coSos";

// This is an exact retained-state read, never a provider client or a review authority.
export const REGISTRY_CAPTURE_FIELDS = "company_id,source_key,complete,last_attempt_at,last_success_at,last_error,coverage_status,next_attempt_at,cursor";
export const MAX_REGISTRY_CAPTURE_BYTES = 256 * 1024;
export class RegistryCaptureReadError extends Error {
  constructor(readonly reason: "invalid_retained_schema" | "unsafe_retained_evidence" | "retained_capture_oversize" | "retained_binding_mismatch") { super(reason); }
}
const bad = (): never => { throw new RegistryCaptureReadError("invalid_retained_schema"); };
const unsafe = (): never => { throw new RegistryCaptureReadError("unsafe_retained_evidence"); };
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return bad();
  return v as Record<string, unknown>;
};
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]/.test(v) && Number.isFinite(Date.parse(v))
  && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const id = (v: unknown) => nonempty(v) || typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const optionalText = (v: unknown) => v == null || typeof v === "string";
const count = (v: unknown) => v == null || (typeof v === "number" || typeof v === "string" && /^\d+$/.test(v)) && Number.isSafeInteger(Number(v)) && Number(v) >= 0;
const secretKey = { test: (key: string) => /(?:token|secret|password|passwd|authorization|credentials?|cookies?|sessions?|apikey|accesskey|privatekey)$|^lease(?:id|until)?$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")) };
const secretValue = /(?:\b(?:bearer|basic)\s+[a-z0-9+/=_\-.]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|(?:authorization|x-app-token|api[_-]?key|access[_-]?token|password|secret)\s*[:=])/i;
/** Keep unknown public row fields losslessly, but refuse credential-shaped data instead of silently redacting it. */
function publicJson(v: unknown, depth = 0): unknown {
  if (depth > 8) return bad();
  if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { if (secretValue.test(v)) return unsafe(); return v; }
  if (Array.isArray(v)) { if (v.length > 500) return bad(); return v.map(x => publicJson(x, depth + 1)); }
  const row = object(v), entries = Object.entries(row);
  if (entries.length > 128) return bad();
  return Object.fromEntries(entries.map(([key, value]) => {
    if (key.length > 128 || /[\u0000-\u001f]/.test(key)) return bad();
    if (secretKey.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) return unsafe();
    return [key, publicJson(value, depth + 1)];
  }));
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function bounded(v: unknown) {
  if (Buffer.byteLength(JSON.stringify(v), "utf8") > MAX_REGISTRY_CAPTURE_BYTES) throw new RegistryCaptureReadError("retained_capture_oversize");
}
const endpoints: Record<string, string> = {
  carrier: "https://data.transportation.gov/resource/kjg3-diqy.json",
  entity: "https://data.colorado.gov/resource/4ykn-tg5h.json", debtor: "https://data.colorado.gov/resource/8upq-58vz.json",
  filing: "https://data.colorado.gov/resource/wffy-3uut.json", party: "https://data.colorado.gov/resource/ap62-sav4.json",
};
function sourceQuery(value: unknown, table: string) {
  if (typeof value !== "string") return bad();
  let url: URL; try { url = new URL(value); } catch { return bad(); }
  if (`${url.origin}${url.pathname}` !== endpoints[table] || url.username || url.password || url.hash || url.port) return unsafe();
  const allowed = ["$select", "$where", "$order", "$limit"];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return unsafe();
  const select = url.searchParams.get("$select"), where = url.searchParams.get("$where"), limit = url.searchParams.get("$limit");
  if (!select || !/^[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/.test(select) || !where || !limit || !/^[1-9][0-9]*$/.test(limit) || Number(limit) > 500) return bad();
  if (select.split(",").some(k => secretKey.test(k))) return unsafe();
  const query = Object.fromEntries(url.searchParams.entries()); publicJson(query);
  return { parameters: query, limit: Number(limit), selectedFields: select.split(",") };
}
function rowIdentityValid(row: Record<string, unknown>, table: string): boolean {
  if (table === "carrier") return (typeof row.dot_number === "string" && /^[1-9]\d*$/.test(row.dot_number) || typeof row.dot_number === "number" && Number.isSafeInteger(row.dot_number) && row.dot_number > 0)
    && [row.legal_name, row.dba_name].some(nonempty) && [row.legal_name, row.dba_name, row.phy_city, row.phy_state, row.mcs150_date].every(optionalText)
    && count(row.nbr_power_unit) && count(row.driver_total);
  if (table === "entity") return id(row.entityid) && nonempty(row.entityname) && date(row.entityformdate)
    && [row.entitytype, row.entitystatus, row.principalcity].every(optionalText);
  return id(row.fileid) && (table === "filing" ? date(row.filingdate) && nonempty(row.documenttype)
    : nonempty(row.organizationname) && (table !== "debtor" || optionalText(row.city)));
}
const normalizedFields: Record<string, string> = {
  records: "dot,legal,dba,units,drivers,city,state,mcs150", entities: "name,id,formed,type,status,city",
  filings: "filed,docType,debtorAsFiled,debtorCity,securedParty",
};
function normalizedRows(v: unknown, kind: string) {
  if (!Array.isArray(v) || v.length > 500) return bad();
  return v.map(value => {
    const row = object(value), projected = pick(row, normalizedFields[kind]);
    const metrics = kind === "records" ? ["units", "drivers"] : [];
    if (Object.entries(projected).some(([key, value]) => metrics.includes(key) ? !count(value) : typeof value !== "string")) return bad();
    publicJson(projected);
    return { ...projected, omittedFieldCount: Object.keys(row).filter(k => !(k in projected)).length };
  });
}
/** Defense in depth: the query also enforces this membership filter in the database. */
export function registryCompanyInScope(company: Record<string, unknown>, scope: CoverageQuery["scope"]) {
  const lists = company.lists;
  if (lists !== null && (!Array.isArray(lists) || lists.some(x => typeof x !== "string"))) return false;
  if (Array.isArray(lists) && lists.includes("tam_duplicate")) return false;
  const tam = Array.isArray(lists) && lists.includes("netsuite_tam") && typeof company.status === "string" && company.status !== "removed_from_tam";
  const tal = company.tal_claimed === true;
  return scope === "tam" ? tam : scope === "tal" ? tal : tam || tal;
}

export function retainedRegistryCapture(row: Record<string, unknown>, companyId: string, sourceKey: "fmcsa" | "cosos") {
  if (row.company_id !== companyId || row.source_key !== sourceKey) throw new RegistryCaptureReadError("retained_binding_mismatch");
  if (typeof row.complete !== "boolean" || !["complete", "empty", "partial", "unavailable", "unsupported", "unknown"].includes(String(row.coverage_status))
    || !date(row.last_attempt_at) || ![row.last_success_at, row.next_attempt_at].every(v => v == null || date(v))) return bad();
  const sourceState = { ...pick(row, "company_id,source_key,complete,coverage_status,last_attempt_at,last_success_at,next_attempt_at"), hasError: row.last_error != null };
  const cursor = row.cursor == null ? null : object(row.cursor);
  if (!cursor) return { sourceState, retainedCaptureAvailable: false, boundedLookupComplete: false, analysisComplete: false,
    reason: "no_retained_cursor", responseTruncated: false, retainedVersionSha256: hash(sourceState), hashBasis: "canonical_retained_representation_not_http_bytes" };
  if (!["source_only", "legacy"].includes(String(cursor.collectionMode)) || !date(cursor.observedAt) || !nonempty(cursor.query) || typeof cursor.truncated !== "boolean"
    || !Array.isArray(cursor.rawCaptures) || cursor.rawCaptures.length > 16) return bad();
  bounded({ query: cursor.query, rawCaptures: cursor.rawCaptures, records: cursor.records, entities: cursor.entities, filings: cursor.filings, priorSnapshot: cursor.priorSnapshot });
  // Only explicit public cursor fields enter the payload. Never return raw cursor/error_details or their unknown field names.
  const retained: Record<string, unknown> = pick(cursor, sourceKey === "fmcsa"
    ? "collectionMode,observedAt,query,truncated,matchedDot,priorSnapshotRead,comparisonBaselinePreserved"
    : "collectionMode,observedAt,query,truncated,entitySince,uccSince");
  publicJson(retained);
  const normalizedKeys = sourceKey === "fmcsa" ? ["records"] : ["entities", "filings"];
  for (const key of normalizedKeys) retained[key] = normalizedRows(cursor[key], key);
  if (sourceKey === "fmcsa") {
    if (!optionalText(cursor.matchedDot) || typeof cursor.priorSnapshotRead !== "boolean" || typeof cursor.comparisonBaselinePreserved !== "boolean") return bad();
    const prior = cursor.priorSnapshot == null ? null : pick(object(cursor.priorSnapshot), "nbr_power_unit,driver_total,captured_at");
    if (prior && (typeof prior.nbr_power_unit !== "number" || typeof prior.driver_total !== "number" || !count(prior.nbr_power_unit) || !count(prior.driver_total) || !date(prior.captured_at))) return bad();
    retained.priorSnapshot = prior;
  } else if (!date(cursor.entitySince) || !date(cursor.uccSince)) return bad();
  let malformedRows = 0, totalRows = 0, limitReached = false;
  const captures = cursor.rawCaptures.map(value => {
    const raw = object(value), table = sourceKey === "fmcsa" ? "carrier" : raw.table;
    if (typeof table !== "string" || !(table in endpoints) || (sourceKey === "cosos" && table === "carrier")
      || (sourceKey === "fmcsa" && raw.table != null && raw.table !== "carrier") || !date(raw.observedAt)
      || !Array.isArray(raw.rows) || raw.rows.length > 500) return bad();
    const query = sourceQuery(raw.sourceUrl, table);
    const rows = raw.rows.map(value => publicJson(object(value)) as Record<string, unknown>);
    const invalidRows = rows.filter(row => !rowIdentityValid(row, table)).length;
    malformedRows += invalidRows; totalRows += rows.length; limitReached ||= rows.length >= query.limit;
    const capture = { sourceUrl: raw.sourceUrl, table, observedAt: raw.observedAt, rows };
    return { ...capture, query, rowCount: rows.length, rowsWithInvalidRequiredFields: invalidRows,
      unknownPublicRowFields: [...new Set(rows.flatMap(row => Object.keys(row).filter(k => !query.selectedFields.includes(k))))].sort(),
      omittedCaptureMetadataFieldCount: Object.keys(raw).filter(k => !["sourceUrl", "table", "observedAt", "rows"].includes(k)).length,
      retainedCanonicalSha256: hash(capture), retainedCanonicalBytes: Buffer.byteLength(canonical(capture), "utf8") };
  });
  retained.rawCaptures = captures;
  bounded(retained);
  const tables = new Set(captures.map(c => c.table));
  if (tables.size !== captures.length) return bad();
  const minimumCaptures = sourceKey === "fmcsa" ? tables.has("carrier") : tables.has("entity") && tables.has("debtor")
    && (!captures.some(c => c.table === "debtor" && c.rows.some(row => nonempty(row.organizationname) && id(row.fileid)
      && lightNorm(row.organizationname) === lightNorm(cursor.query as string))) || tables.has("filing"))
    && (!(retained.filings as unknown[]).length || tables.has("filing") && tables.has("party"))
    && (!captures.some(c => c.table === "filing" && c.rowCount > 0) || tables.has("party"));
  const issues = [
    ...(!minimumCaptures ? ["required_raw_capture_missing"] : []),
    ...(malformedRows ? ["raw_rows_have_invalid_required_fields"] : []),
    ...(cursor.truncated || limitReached ? ["bounded_source_limit_reached"] : []),
    ...(sourceState.hasError ? ["collector_error_present"] : []),
    ...(!row.complete || !["complete", "empty"].includes(String(row.coverage_status)) ? ["collector_not_complete"] : []),
  ];
  const version = { sourceState, retained };
  const result = { ...version, retainedCaptureAvailable: captures.length > 0, retainedCaptureCount: captures.length, retainedRawRowCount: totalRows,
    retainedVersionSha256: hash(version), hashBasis: "canonical_retained_representation_not_http_bytes",
    boundedLookupComplete: issues.length === 0, sourceCompletenessIssues: issues,
    analysisComplete: false, coverageVerified: false, responseTruncated: false,
    omittedCursorFieldCount: Object.keys(cursor).filter(k => !(k in retained)).length,
    omittedOperationalFields: ["last_error_body", "error_details", "unknown_cursor_metadata"],
    limitations: ["One currently retained mutable source-state version; no historical version or transactional membership guarantee.",
      "Raw rows are complete retained parsed public provider records, not original HTTP bytes or all provider columns. Unknown public row fields remain evidence, not instructions.",
      "boundedLookupComplete describes captured bounded queries only; pagination beyond query limits and full-registry coverage are not established.",
      "Normalized matches and prior snapshots do not prove company identity, event dates, reviewed signals or completed analysis."] };
  bounded(result);
  return result;
}
