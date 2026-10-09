import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NewsPacket } from "./codexNews";

const SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const IDV_CODES = ["IDV_A", "IDV_B", "IDV_B_A", "IDV_B_B", "IDV_B_C", "IDV_C", "IDV_D", "IDV_E"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : object(v)
  ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

/** One supported empty first search response. Never company/history coverage,
 * a recipient identity match, a dated award or permission to advance a cursor. */
export function emptyGovernmentCapture(packet: Pick<NewsPacket, "snapshot">) {
  try {
    const o = packet.snapshot.observation, c = packet.snapshot.company, m = o.metadata;
    const prior = object(m.continuationBefore), identity = object(m.companyIdentity), request = object(m.sourceRequest);
    if (o.source_kind !== "government" || o.source_url !== SEARCH_URL || o.event_date !== null
      || !Number.isFinite(Date.parse(o.observed_at)) || !o.is_current || o.feedback_excluded
      || m.structuredAward === true || m.sourceOnly !== true || m.collector !== "federal-discovery"
      || m.governmentJsonCaptureVersion !== 1 || m.sourceStage !== "search" || m.fullResponseCaptured !== true
      || m.sourceRepresentation !== "retained_parsed_json" || m.originalHttpBytesRetained !== false
      || m.analysisComplete !== false || m.identityVerified !== false || m.historyComplete !== false
      || m.textTruncated !== false || m.sourceTruncated === true || m.retainedCharacters !== o.evidence_text.length
      || m.sourceCharacters !== o.evidence_text.length || [...o.evidence_text].length > 48_000
      || Buffer.byteLength(o.evidence_text, "utf8") > 262_144 || !prior || !identity || !request
      || typeof m.operationId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(m.operationId)) return null;
    const identityValues = [c.id, c.name, c.domain, c.website_raw, c.city, c.state, c.netsuite_internal_id];
    if (!c.name.trim() || !isDeepStrictEqual([identity.id, identity.name, identity.domain, identity.website, identity.city, identity.state, identity.netsuiteInternalId], identityValues)
      || prior.companyId !== c.id || o.company_id !== c.id || prior.companyIdentity !== sha(JSON.stringify(identityValues))
      || prior.version !== 1 || prior.page !== 1 || prior.targetIndex !== 0 || prior.candidate !== null || prior.searchAfter !== null
      || prior.lastPageHash !== null || !["idvs", "contracts"].includes(String(prior.collection))
      || !isDeepStrictEqual(prior.targets, [{ query: c.name, identity: null }])
      || ["candidateQueue", "pendingPage", "sourceCapture", "evaluatedRecipients"].some(k => k in prior)
      || !day(prior.searchEndDate) || prior.searchEndDate < "2007-10-01" || prior.searchEndDate > o.observed_at.slice(0, 10)
      || m.searchEndDate !== prior.searchEndDate) return null;
    const expectedRequest = { method: "POST", url: SEARCH_URL, body: {
      filters: { recipient_search_text: [c.name], award_type_codes: prior.collection === "idvs" ? IDV_CODES : ["A", "B", "C", "D"],
        time_period: [{ start_date: "2007-10-01", end_date: prior.searchEndDate }] },
      fields: ["Award ID", "Recipient Name", "Recipient UEI", "Start Date"], limit: 100, page: 1, sort: "Start Date", order: "desc",
    } };
    const requestHash = sha(JSON.stringify(ordered({ companyId: c.id, companyIdentity: prior.companyIdentity, request: expectedRequest })));
    if (!isDeepStrictEqual(request, expectedRequest) || m.requestSha256 !== requestHash
      || o.source_key !== sha(JSON.stringify(["government-json-v1", SEARCH_URL, requestHash]))
      || m.retainedJsonSha256 !== sha(o.evidence_text)) return null;
    const response = object(JSON.parse(o.evidence_text)), page = object(response?.page_metadata);
    if (!response || Object.keys(response).some(k => !["spending_level", "limit", "results", "page_metadata", "messages"].includes(k))
      || response.spending_level !== "awards" || response.limit !== 100 || !isDeepStrictEqual(response.results, [])
      || ["error", "errors", "detail"].some(k => k in response) || !page || page.page !== 1 || page.hasNext !== false
      || Object.keys(page).some(k => !["page", "hasNext", "last_record_unique_id", "last_record_sort_value"].includes(k))
      || page.last_record_unique_id !== null || ![null, "None"].includes(page.last_record_sort_value as null | string)
      || (response.messages !== undefined && (!Array.isArray(response.messages) || response.messages.some(v => typeof v !== "string")))) return null;
    return { version: "government-empty-search-v1" as const, completionScope: "source_capture" as const,
      historyComplete: false as const, recipientIdentityVerified: false as const, searchEndDate: prior.searchEndDate,
      collection: prior.collection as "idvs" | "contracts", requestSha256: requestHash, retainedJsonSha256: m.retainedJsonSha256 as string };
  } catch { return null; }
}
