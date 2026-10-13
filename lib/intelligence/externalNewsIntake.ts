import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { readNewsEvidence } from "@/lib/sources/newsEvidence";
import { canonicalEvidenceUrl, intelligenceEnabled, INTELLIGENCE_VERSION, prepareObservation } from "./observations";

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.string().regex(/^[a-zA-Z0-9_:/.-]{3,180}$/);
const timestamp = z.iso.datetime({ offset: true });
const endpoint = z.enum(["tinyfish.web.search", "tinyfish.web.search.news"]);
const identity = z.object({ name: z.string().min(1).max(500), domain: z.string().max(500).nullable(),
  netsuiteInternalId: z.string().max(30).nullable() }).strict();
export const externalNewsActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import_discovery"), requestId: uuid, taskId: actor, companyId: uuid,
    expectedIdentity: identity, sourceOnly: z.literal(true), lane: z.enum(["news", "oracle_partnership"]),
    retrievedAt: timestamp, providerRequest: z.string().min(2).max(8000), providerResponse: z.string().min(2).max(180_000),
    requestSha256: hash, responseSha256: hash }).strict(),
  z.object({ action: z.literal("capture_discovery_url"), requestId: uuid, taskId: actor, companyId: uuid,
    expectedIdentity: identity, sourceOnly: z.literal(true), discoveryId: uuid, position: z.number().int().min(1).max(24) }).strict(),
]);
type Import = Extract<z.infer<typeof externalNewsActionSchema>, { action: "import_discovery" }>;
type Capture = Extract<z.infer<typeof externalNewsActionSchema>, { action: "capture_discovery_url" }>;
const searchRequest = z.object({ endpoint_id: endpoint, query: z.object({ query: z.string().min(1).max(900),
  domain_type: z.enum(["web", "news"]), after_date: z.iso.date(), before_date: z.iso.date(),
  language: z.string().regex(/^[a-z]{2}$/), page: z.number().int().min(0).max(100) }).strict(),
  headers: z.object({ "X-Treg-Route-Max-Cost": z.literal("0") }).strict().optional(),
  idempotency_key: z.string().min(1).max(180).optional() }).strict();
const itemSchema = z.object({ title: z.string().min(1).max(600), url: z.string().min(1).max(2048),
  position: z.number().int().min(1).max(24), snippet: z.string().max(6000).nullish(),
  date: z.string().max(120).nullish(), publisher: z.string().max(300).nullish(), site_name: z.string().max(300).nullish() }).strict();
const responseSchema = z.object({ status: z.literal(200), endpoint_id: endpoint, call_id: z.string().min(1).max(180),
  body: z.object({ query: z.string(), results: z.array(itemSchema).max(24), total_results: z.number().int().nonnegative(),
    page: z.number().int().nonnegative() }).strict() }).passthrough();
export class ExternalNewsIntakeError extends Error {}
function fail(message: string): never { throw new ExternalNewsIntakeError(message); }
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** This endpoint accepts public discovery data, never provider credentials. */
function rejectCredentialFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)) fail("credential_field_rejected");
    rejectCredentialFields(child);
  }
}
const gateway = (host: string) => /(?:^|\.)(?:google\.com|googleusercontent\.com|gstatic\.com|bing\.com)$/i.test(host.replace(/\.$/, ""));
function directUrl(raw: string) {
  const url = validatePublicHttpUrl(raw);
  // No search gateway resolution or provider replay is permitted in this path.
  if (gateway(url.hostname)) fail("direct_original_url_required");
  return canonicalEvidenceUrl(raw);
}

export function prepareExternalDiscovery(input: Import, now = Date.now()) {
  if (sha(input.providerRequest) !== input.requestSha256 || sha(input.providerResponse) !== input.responseSha256) fail("external_receipt_hash_mismatch");
  const requestRaw: unknown = JSON.parse(input.providerRequest), responseRaw: unknown = JSON.parse(input.providerResponse);
  rejectCredentialFields(requestRaw); rejectCredentialFields(responseRaw);
  const request = searchRequest.parse(requestRaw);
  const wrapper = responseRaw as { isError?: boolean; structuredContent?: unknown };
  if (wrapper.isError === true) fail("external_query_not_successful");
  const response = responseSchema.parse(wrapper.structuredContent ?? responseRaw);
  if (response.error != null || response.whose_error != null) fail("external_query_not_successful");
  if (response.endpoint_id !== request.endpoint_id || response.body.query !== request.query.query
    || response.body.page !== request.query.page || (request.endpoint_id.endsWith(".news") ? "news" : "web") !== request.query.domain_type) fail("external_query_binding_mismatch");
  const retrieved = Date.parse(input.retrievedAt);
  if (retrieved > now || request.query.after_date >= request.query.before_date
    || Date.parse(request.query.after_date) > retrieved) fail("external_query_date_invalid");
  if (response.body.total_results < response.body.results.length
    || new Set(response.body.results.map(item => item.position)).size !== response.body.results.length) fail("external_result_geometry_invalid");
  const items = response.body.results.map(item => ({ ...item, canonicalUrl: canonicalEvidenceUrl(item.url),
    // A search gateway is still a returned result, never an original to fetch.
    // Preserve successful query accounting without dispatching its resolver.
    captureEligible: !gateway(new URL(item.url).hostname), captureHoldReason: gateway(new URL(item.url).hostname) ? "direct_original_url_required" : null,
    // Relative provider labels stay raw. Even an ISO-looking label is left for
    // the original publication metadata and independent date review to resolve.
    eventDate: null, itemSha256: sha(JSON.stringify(item)) }));
  const queryHash = sha(JSON.stringify(["external-news-v1", "tinyfish", input.lane, request.endpoint_id, request.query]));
  return { ...input, queryHash, query: request.query.query, endpoint: request.endpoint_id, callId: response.call_id, items,
    outcome: items.length ? "success" : "empty", capturableResultCount: items.filter(item => item.captureEligible).length, totalReported: response.body.total_results, page: request.query.page,
    pagination: "unknown", coverage: "query_page_only", analysisCompleted: false, accountCompleted: false };
}

export async function externalNewsRpc(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { data, error } = await serviceClient().rpc("intelligence_external_news_intake", { p_action: action, p_payload: payload });
  if (error) fail("external_news_intake_unconfirmed");
  return data;
}

export async function importExternalDiscovery(input: Import) {
  if (!intelligenceEnabled()) fail("source_capture_disabled");
  const prepared = prepareExternalDiscovery(input);
  const saved = await externalNewsRpc("import", prepared);
  const readback = await externalNewsRpc("status", { requestId: input.requestId });
  if (!saved || !isDeepStrictEqual(saved, readback)) fail("external_import_readback_unconfirmed");
  return readback;
}

type CaptureAdmission = { fetch: boolean; operation: Record<string, unknown>; lease?: string;
  company?: { id: string; name: string; domain: string | null; netsuite_internal_id: string | null; subindustry: string | null };
  item?: { canonicalUrl: string; title: string; snippet?: string | null; itemSha256: string; date?: string | null } };
export async function captureExternalDiscovery(input: Capture) {
  if (!intelligenceEnabled()) fail("source_capture_disabled");
  const admission = await externalNewsRpc("begin_capture", input) as CaptureAdmission | null;
  if (!admission) fail("external_capture_admission_unconfirmed");
  // An existing/uncertain operation is read-only recovery, never a fetch retry.
  if (!admission.fetch) return admission.operation;
  const { item, company, lease } = admission;
  if (!item || !company || !lease) fail("external_capture_binding_missing");
  let observation: ReturnType<typeof prepareObservation> | null = null;
  let failure = "original_unavailable";
  try {
    directUrl(item.canonicalUrl);
    const evidence = await readNewsEvidence({ source_url: item.canonicalUrl, raw_excerpt: item.title,
      feed_excerpt: item.snippet ?? undefined, signal_date: null }, { deadlineMs: Date.now() + 20_000, directOnly: true });
    if (evidence.bodyAvailable && !("textTruncated" in evidence.metadata && evidence.metadata.textTruncated === true) && [...evidence.text].length <= 48_000) {
      // Existing page-publication convention: only one unambiguous date on the
      // original can date the capture. Provider labels and modified dates cannot.
      const dates = "sourceDates" in evidence.metadata ? evidence.metadata.sourceDates : [];
      const published = [...new Set(dates.filter(date => date.kind === "published").map(date => date.value))];
      const publication = published.length === 1 && Date.parse(published[0]) <= Date.now() ? published[0] : null;
      observation = prepareObservation({ companyId: company.id, companyName: company.name, companyDomain: company.domain,
        netsuiteInternalId: company.netsuite_internal_id, companySubindustry: company.subindustry, sourceKind: "news",
        sourceUrl: evidence.sourceUrl, title: evidence.title, text: evidence.text, eventDate: publication,
        metadata: { ...evidence.metadata, externalDiscoveryId: input.discoveryId, externalCaptureId: input.requestId,
          externalItemSha256: item.itemSha256, providerRawDate: item.date ?? null, eventDateBasis: publication ? "page_publication" : "unknown", sourceOnly: true } });
      if (observation.metadata.textTruncated) { observation = null; failure = "original_exceeds_capture_bound"; }
    } else failure = evidence.bodyAvailable ? "original_incomplete_or_oversize" : "original_unavailable";
  } catch { failure = "original_fetch_failed"; }
  // Capture, URL-attempt outcome and operation receipt commit together. A DB
  // error leaves the admitted operation uncertain; this function never retries.
  const saved = await externalNewsRpc("finish_capture", { requestId: input.requestId, lease, observation,
    version: INTELLIGENCE_VERSION, failure: observation ? null : failure });
  const readback = await externalNewsRpc("status", { requestId: input.requestId });
  if (!saved || !isDeepStrictEqual(saved, readback)) fail("external_capture_readback_unconfirmed");
  return readback;
}
