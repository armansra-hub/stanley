import "server-only";
import { createHash } from "node:crypto";
import { compactSamOpportunity } from "./sam";
import { requirePublicGrowthTime } from "./http";

export const SAM_BULK_URL = "https://s3.amazonaws.com/falextracts/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv";
export const SAM_RANGE_BYTES = 8 * 1024 * 1024;
export const SAM_QUEUE_MAX_BYTES = 512 * 1024;
export const SAM_QUEUE_MAX_ENTRIES = 2000;
export interface SamQueuedNotice {
  row: ReturnType<typeof compactSamOpportunity>;
  sourceRowHash: string;
  candidateIdsHash: string;
  candidates: Array<[string, { relationship: "awardee" | "incumbent_recompete"; confidence: number; evidence: Record<string, unknown> }]>;
  queueEntryHash: string;
}
export interface SamOpportunityCursor {
  version: 2; sourceUrl: typeof SAM_BULK_URL; etag: string; lastModified: string | null;
  totalBytes: number; nextByte: number; headers: string[]; cutoffDate: string; untilDate: string;
  scanned: number; identityScopeHash: string;
  notices: SamQueuedNotice[]; deliveryIndex: number;
  pendingNotice?: { noticeId: string; sourceRowHash: string; candidateIdsHash: string; queueEntryHash: string; lastCompanyId: string | null };
}
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function canonicalQueueValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalQueueValue);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalQueueValue(value[key])]));
  throw new Error("SAM queue contains a non-JSON value");
}
/** JSONB changes object key order. Hash canonical values so a durable roundtrip
 * preserves the same exact queued evidence, including nested candidate facts. */
export const samQueueHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonicalQueueValue(value))).digest("hex");
export const samQueuedNoticeHash = (notice: Omit<SamQueuedNotice, "queueEntryHash">): string => samQueueHash({
  row: notice.row, sourceRowHash: notice.sourceRowHash, candidateIdsHash: notice.candidateIdsHash, candidates: notice.candidates,
});
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validUuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function validNoticeUrl(value: unknown, noticeId: string): boolean {
  if (typeof value !== "string" || value.includes("\\") || /[\u0000-\u0020]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === "sam.gov" && !url.username && !url.password && !url.search && !url.hash
      && [ `/opp/${encodeURIComponent(noticeId)}/view`, `/workspace/contract/opp/${encodeURIComponent(noticeId)}/view` ].includes(url.pathname);
  } catch { return false; }
}
function validateNoticeQueue(cursor: SamOpportunityCursor): void {
  const notices = cursor.notices;
  if (!Array.isArray(notices) || notices.length > SAM_QUEUE_MAX_ENTRIES
    || !Number.isSafeInteger(cursor.deliveryIndex) || cursor.deliveryIndex < 0 || cursor.deliveryIndex > notices.length
    || (cursor.nextByte < cursor.totalBytes && cursor.deliveryIndex !== 0)
    || Buffer.byteLength(JSON.stringify(notices), "utf8") > SAM_QUEUE_MAX_BYTES) throw new Error("Invalid or oversized SAM notice queue");
  const ids = new Set<string>();
  const rowKeys = Object.keys(compactSamOpportunity({})).sort().join(",");
  for (const notice of notices) {
    if (!isObject(notice) || Object.keys(notice).sort().join(",") !== "candidateIdsHash,candidates,queueEntryHash,row,sourceRowHash"
      || !validHash(notice.sourceRowHash) || !validHash(notice.candidateIdsHash) || !validHash(notice.queueEntryHash)
      || !isObject(notice.row) || Object.keys(notice.row).sort().join(",") !== rowKeys
      || typeof notice.row.noticeId !== "string" || !notice.row.noticeId.trim() || notice.row.noticeId !== notice.row.noticeId.trim()
      || notice.row.noticeId.length > 256 || ids.has(notice.row.noticeId)
      || !validDate(notice.row.postedDate) || notice.row.postedDate < cursor.cutoffDate || notice.row.postedDate > cursor.untilDate
      || !validNoticeUrl(notice.row.sourceUrl, notice.row.noticeId)
      || typeof notice.row.title !== "string" || !["active", "archived"].includes(notice.row.status)
      || !isObject(notice.row.placeOfPerformance) || !isObject(notice.row.evidence)
      || notice.row.evidence.source !== "SAM public Contract Opportunities bulk CSV"
      || notice.row.evidence.noticeId !== notice.row.noticeId || notice.row.evidence.etag !== cursor.etag
      || notice.row.evidence.lastModified !== cursor.lastModified
      || (notice.row.awardAmount !== null && (typeof notice.row.awardAmount !== "number" || !Number.isFinite(notice.row.awardAmount)))
      || !Array.isArray(notice.candidates) || !notice.candidates.length) throw new Error("Invalid SAM queued notice evidence");
    ids.add(notice.row.noticeId);
    for (const field of ["solicitationNumber", "awardNumber", "noticeType", "description", "agency", "subagency", "office", "naicsCode", "pscCode", "setAside", "responseDeadline", "archiveDate", "awardeeName", "awardeeUei"] as const) {
      if (notice.row[field] !== null && typeof notice.row[field] !== "string") throw new Error("Invalid SAM queued notice field type");
    }
    if (notice.row.archiveDate !== null && !validDate(notice.row.archiveDate)) throw new Error("Invalid SAM queued archive date");
    let previous: string | null = null;
    for (const candidate of notice.candidates) {
      if (!Array.isArray(candidate) || candidate.length !== 2 || !validUuid(candidate[0]) || (previous !== null && candidate[0] <= previous)
        || !isObject(candidate[1]) || Object.keys(candidate[1]).sort().join(",") !== "confidence,evidence,relationship"
        || !["awardee", "incumbent_recompete"].includes(candidate[1].relationship)
        || typeof candidate[1].confidence !== "number" || !Number.isFinite(candidate[1].confidence) || candidate[1].confidence < 0 || candidate[1].confidence > 1
        || !isObject(candidate[1].evidence)) throw new Error("Invalid SAM queued candidate ordering or evidence");
      previous = candidate[0];
    }
    if (samQueueHash(notice.candidates) !== notice.candidateIdsHash || samQueuedNoticeHash(notice) !== notice.queueEntryHash)
      throw new Error("SAM queued notice hash differs from its exact evidence");
  }
  const pending = cursor.pendingNotice;
  if (pending !== undefined) {
    const current = notices[cursor.deliveryIndex];
    if (cursor.nextByte !== cursor.totalBytes || !isObject(pending) || !current
      || Object.keys(pending).sort().join(",") !== "candidateIdsHash,lastCompanyId,noticeId,queueEntryHash,sourceRowHash"
      || pending.noticeId !== current.row.noticeId || pending.sourceRowHash !== current.sourceRowHash
      || pending.candidateIdsHash !== current.candidateIdsHash || pending.queueEntryHash !== current.queueEntryHash
      || (pending.lastCompanyId !== null && (!validUuid(pending.lastCompanyId) || !current.candidates.some(([id]) => id === pending.lastCompanyId))))
      throw new Error("Invalid SAM pending-notice queue binding");
  }
}
export function parseSamOpportunityCursor(value: unknown): SamOpportunityCursor | null {
  if (value == null) return null;
  const row = value as SamOpportunityCursor;
  if (typeof row !== "object" || Array.isArray(row) || row.version !== 2 || row.sourceUrl !== SAM_BULK_URL
    || typeof row.etag !== "string" || !/^"[^"\r\n]+"$/.test(row.etag) || row.etag.length > 256
    || (row.lastModified !== null && (typeof row.lastModified !== "string" || !Number.isFinite(Date.parse(row.lastModified))))
    || !Number.isSafeInteger(row.totalBytes) || row.totalBytes <= 0 || !Number.isSafeInteger(row.nextByte) || row.nextByte < 0 || row.nextByte > row.totalBytes
    || !Number.isSafeInteger(row.scanned) || row.scanned < 0 || !Array.isArray(row.headers) || !row.headers.length
    || row.headers.some((header) => typeof header !== "string") || new Set(row.headers).size !== row.headers.length
    || !row.headers.includes("NoticeId") || !row.headers.includes("PostedDate")
    || !validDate(row.cutoffDate) || !validDate(row.untilDate) || row.cutoffDate > row.untilDate
    || !validHash(row.identityScopeHash)) throw new Error("Invalid SAM opportunity source checkpoint");
  validateNoticeQueue(row);
  return structuredClone(row);
}

/** Windows-1252 is single-byte: character offsets are source byte offsets.
 * Expose only whole RFC4180 records, never a quoted embedded newline boundary. */
export function parseSamCsvRange(bytes: Uint8Array, startByte: number, eof: boolean): Array<{ values: string[]; endByte: number }> {
  const text = new TextDecoder("windows-1252").decode(bytes);
  const rows: Array<{ values: string[]; endByte: number }> = [];
  let fields: string[] = [], field = "", quoted = false, quotePending = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (quotePending) {
        if (char === '"') { field += '"'; quotePending = false; continue; }
        if (![",", "\r", "\n"].includes(char)) throw new Error("Invalid SAM CSV quoted-field boundary");
        quoted = false; quotePending = false;
      } else {
        if (char === '"') quotePending = true; else field += char;
        continue;
      }
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error("Invalid SAM CSV quote inside an unquoted field");
      quoted = true;
    }
    else if (char === ",") { fields.push(field); field = ""; }
    else if (char === "\n") { fields.push(field); rows.push({ values: fields, endByte: startByte + index + 1 }); fields = []; field = ""; }
    else if (char === "\r") {
      if (index + 1 === text.length && !eof) break; // refetch this incomplete record boundary
      if (text[index + 1] !== "\n") throw new Error("Invalid SAM CSV bare carriage return");
    } else field += char;
  }
  if (eof) {
    if (quoted && !quotePending) throw new Error("SAM CSV ends inside a quoted field");
    if (field.length || fields.length || quotePending) { fields.push(field); rows.push({ values: fields, endByte: startByte + bytes.length }); }
  }
  return rows;
}

export function compactSamBulkRow(values: string[], headers: string[], cursor: SamOpportunityCursor) {
  if (values.length !== headers.length) throw new Error("SAM CSV record width differs from frozen headers");
  const raw = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  const date = String(raw.PostedDate ?? "").slice(0, 10);
  if (!raw.NoticeId) return null;
  if (!validDate(date)) throw new Error("SAM notice has an invalid source posted date");
  if (date < cursor.cutoffDate || date > cursor.untilDate) return null;
  const compact = compactSamOpportunity({
    noticeId: raw.NoticeId, title: raw.Title, solicitationNumber: raw["Sol#"] || null,
    department: raw["Department/Ind.Agency"] || null, subTier: raw["Sub-Tier"] || null, office: raw.Office || null,
    postedDate: raw.PostedDate || null, type: raw.Type || null, active: raw.Active, archiveDate: raw.ArchiveDate || null,
    typeOfSetAsideDescription: raw.SetASide || raw.SetAside || null, responseDeadLine: raw.ResponseDeadLine || null,
    naicsCode: raw.NaicsCode || null, classificationCode: raw.ClassificationCode || null,
    placeOfPerformance: { street: raw.PopStreetAddress || null, city: raw.PopCity || null, state: raw.PopState || null, zip: raw.PopZip || null, country: raw.PopCountry || null },
    award: { number: raw.AwardNumber || null, amount: raw["Award$"] || null, awardee: { name: raw.Awardee || null } },
    uiLink: raw.Link || `https://sam.gov/opp/${encodeURIComponent(raw.NoticeId)}/view`, description: null,
  });
  compact.evidence = { source: "SAM public Contract Opportunities bulk CSV", noticeId: raw.NoticeId, lastModified: cursor.lastModified, etag: cursor.etag };
  return compact;
}

/** One exact source range, with hard byte/time bounds and no transport retry. */
export async function fetchSamOpportunityRange(options: { cursor: SamOpportunityCursor | null; days: number; identityScopeHash: string; deadlineMs: number }) {
  const { cursor, days, identityScopeHash, deadlineMs } = options;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid SAM source date window");
  requirePublicGrowthTime(deadlineMs);
  const start = cursor?.nextByte ?? 0;
  if (cursor && (cursor.identityScopeHash !== identityScopeHash || cursor.nextByte >= cursor.totalBytes)) throw new Error("SAM opportunity scope/checkpoint requires review");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(20_000, Math.max(1, deadlineMs - Date.now())));
  try {
    const response = await fetch(SAM_BULK_URL, { cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { Range: `bytes=${start}-${start + SAM_RANGE_BYTES - 1}`, "Accept-Encoding": "identity", ...(cursor ? { "If-Match": cursor.etag } : {}) } });
    const etag = response.headers.get("etag"), lastModified = response.headers.get("last-modified");
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (response.status !== 206 || !response.body || !range || Number(range[1]) !== start || !etag || !/^"[^"\r\n]+"$/.test(etag)
      || ![null, "identity"].includes(response.headers.get("content-encoding"))
      || (cursor && (etag !== cursor.etag || Number(range[3]) !== cursor.totalBytes))) {
      await response.body?.cancel(); throw new Error("SAM source changed or did not provide the required exact byte range");
    }
    const expectedBytes = Number(range[2]) - start + 1, totalBytes = Number(range[3]);
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || expectedBytes < 1 || expectedBytes > SAM_RANGE_BYTES || start + expectedBytes > totalBytes) {
      await response.body.cancel(); throw new Error("Invalid SAM source range bounds");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      requirePublicGrowthTime(deadlineMs);
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > expectedBytes) { await reader.cancel(); throw new Error("SAM source response exceeded its declared byte range"); }
      chunks.push(part.value);
    }
    if (length !== expectedBytes) throw new Error("SAM source response was truncated");
    const bytes = new Uint8Array(length); let target = 0;
    for (const chunk of chunks) { bytes.set(chunk, target); target += chunk.byteLength; }
    const rows = parseSamCsvRange(bytes, start, start + length === totalBytes);
    if (!rows.length) throw new Error("SAM CSV record exceeds the bounded source range");
    let nextCursor = cursor && structuredClone(cursor);
    if (!nextCursor) {
      const header = rows.shift()!;
      const headers = header.values.map((value, index) => index === 0 ? value.replace(/^ï»¿|^\uFEFF/, "") : value);
      const until = new Date();
      nextCursor = { version: 2, sourceUrl: SAM_BULK_URL, etag, lastModified, totalBytes, nextByte: header.endByte, headers,
        cutoffDate: new Date(until.getTime() - days * 86_400_000).toISOString().slice(0, 10), untilDate: until.toISOString().slice(0, 10), scanned: 0, identityScopeHash, notices: [], deliveryIndex: 0 };
    }
    return { cursor: parseSamOpportunityCursor(nextCursor)!, rows, bytesRead: length };
  } finally { controller.abort(); clearTimeout(timer); }
}
