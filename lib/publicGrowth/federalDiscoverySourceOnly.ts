import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { enrichCompanyIdentity } from "@/lib/companyIdentity";
import { enqueueObservation, intelligenceEnabled, governmentJsonWithinBounds, prepareObservation, type ObservationInput } from "@/lib/intelligence/observations";
import { fetchJson, requirePublicGrowthTime } from "./http";
import { companyIdentityNames, normalizeName } from "./identity";
import { assertFrozenFederalIdentities, loadVerifiedFederalIdentities, targetAcceptsSearchRow } from "./federalIdentity";
import { advanceDiscovery, federalDiscoveryCompanyIdentity, federalDiscoverySearchBody, parseFederalDiscoverySearchPage } from "./federalDiscovery";
import { parseFederalDiscoveryContinuation, type FederalDiscoveryContinuation, type FederalDiscoverySourceCapture } from "./federalDiscoveryState";
import { compactAward } from "./usaspending";
import { stableHash } from "./storage";
import { USASPENDING_LEGACY_PAGE_BUDGET } from "./usaspendingCursor";

const SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** JSONB key order is not source identity. Arrays retain their exact order. */
export function federalSourceOnlyHash(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
  return sha(JSON.stringify(ordered(value)));
}
export class FederalCaptureReadbackRequired extends Error {
  constructor() { super("federal_source_capture_requires_exact_readback"); }
}
type SourceRequest = { method: "GET" | "POST"; url: string; body: Record<string, unknown> | null };
export type FederalSourceOnlyOutcome = {
  companyId: string; status: "incomplete"; reason: string; sourceRequests: number; reusedCapture: boolean;
  sourceCaptured: boolean; observationId: string | null; jobId: string | null;
  analysisComplete: false; identityVerified: false; historyComplete: false; continuation: FederalDiscoveryContinuation;
};

async function readObservation(companyId: string, sourceKey: string) {
  const { data, error } = await serviceClient().from("intelligence_observations")
    .select("id,company_id,source_kind,source_key,source_url,evidence_text,metadata,observed_at")
    .eq("company_id", companyId).eq("source_kind", "government").eq("source_key", sourceKey).eq("is_current", true).maybeSingle();
  if (error) throw new FederalCaptureReadbackRequired();
  return data;
}
export type FederalRetainedSourceBinding = { observationId: string; jobId: string; sourceKey: string; requestSha256: string; retainedJsonSha256: string };
async function exactJob(observationId: string, retainedOnly?: FederalRetainedSourceBinding) {
  // jobs owns an observation FK, not a company_id column. The caller has
  // already verified this exact observation's company/source/body binding.
  const { data, error } = await serviceClient().from("intelligence_jobs").select("id,observation_id,kind,status,attempts,lease_token,lease_until,finished_at,codex_news_request_id")
    .eq("observation_id", observationId).eq("kind", "interpret").limit(2);
  if (error || !Array.isArray(data) || data.length !== 1
    || data[0].observation_id !== observationId || data[0].kind !== "interpret" || typeof data[0].id !== "string") {
    throw new FederalCaptureReadbackRequired();
  }
  if (retainedOnly && (data[0].id !== retainedOnly.jobId || data[0].status !== "queued" || data[0].attempts !== 0
    || data[0].lease_token != null || data[0].lease_until != null || data[0].finished_at != null || data[0].codex_news_request_id != null)) {
    throw new FederalCaptureReadbackRequired();
  }
  return data[0].id as string;
}

/** One exact existing search/detail step. No classifier, enrollment, match,
 * award, metric, trigger, grade or membership writes occur in this path. */
export async function captureFederalPendingSource(companyId: string, raw: FederalDiscoveryContinuation,
  operationId: string, deadlineMs = Date.now() + 60_000, retainedOnly?: FederalRetainedSourceBinding): Promise<FederalSourceOnlyOutcome> {
  const state = parseFederalDiscoveryContinuation(raw, companyId);
  let sourceRequests = 0, reusedCapture = false, jobId: string | null = null;
  let captured: FederalDiscoverySourceCapture | undefined;
  const finish = (reason: string, held = true): FederalSourceOnlyOutcome => {
    state.sourceCapture = captured ? { ...captured, status: held ? "held" : "pending", reason } : {
      version: 1, status: "held", stage: state.candidate ? "detail" : "search", reason,
      observationId: null, requestSha256: null, retainedJsonSha256: null, capturedAt: null,
    };
    return { companyId, status: "incomplete", reason, sourceRequests, reusedCapture,
      sourceCaptured: Boolean(captured), observationId: captured?.observationId ?? null, jobId,
      analysisComplete: false, identityVerified: false, historyComplete: false, continuation: state };
  };
  if (!intelligenceEnabled()) throw new Error("government source capture disabled");
  if (state.sourceCapture?.status === "held") throw new Error("source capture hold cannot be replayed");
  return withServiceDeadline(deadlineMs, async () => {
    try {
      requirePublicGrowthTime(deadlineMs);
      const { data: row, error } = await serviceClient().from("companies")
        .select("id,name,domain,website_raw,city,state,netsuite_internal_id,lists,status,tal_claimed")
        .eq("id", companyId).maybeSingle();
      if (error) return finish("company_read_unavailable");
      if (!row || row.id !== companyId || typeof row.name !== "string" || !row.name.trim() || !Array.isArray(row.lists)
        || row.lists.includes("tam_duplicate") || !(row.tal_claimed === true
          || row.lists.includes("netsuite_tam") && row.status !== "removed_from_tam")) return finish("not_current_tam_or_claimed_tal");
      const company = await enrichCompanyIdentity(row);
      if (state.companyIdentity !== federalDiscoveryCompanyIdentity(company)) return finish("company_identity_changed");
      const identities = await loadVerifiedFederalIdentities(companyId);
      assertFrozenFederalIdentities(state.targets.flatMap(target => target.identity ? [target.identity] : []), identities);
      const target = state.targets[state.targetIndex];
      if (!target.identity && !companyIdentityNames(company).map(normalizeName).includes(normalizeName(target.query))) return finish("unbound_query_not_in_current_identity");
      if (state.candidate && (!state.sourceCapture?.observationId || state.sourceCapture.stage !== "search")) {
        // An old identity-deferred candidate may already have fetched its detail.
        // Its lossy continuation is not permission to repeat that provider call.
        return finish("legacy_candidate_requires_original_readback");
      }
      if (state.candidate) {
        const parent = state.sourceCapture!;
        const { data: original, error: originalError } = await serviceClient().from("intelligence_observations")
          .select("id,company_id,source_kind,evidence_text,metadata").eq("id", parent.observationId!).eq("company_id", companyId).maybeSingle();
        if (originalError || !original || original.id !== parent.observationId || original.source_kind !== "government"
          || typeof original.evidence_text !== "string" || sha(original.evidence_text) !== parent.retainedJsonSha256
          || original.metadata?.requestSha256 !== parent.requestSha256 || original.metadata?.governmentJsonCaptureVersion !== 1
          || original.metadata?.sourceOnly !== true || original.metadata?.sourceStage !== "search") throw new FederalCaptureReadbackRequired();
        const priorPage = parseFederalDiscoverySearchPage(JSON.parse(original.evidence_text), state.searchAfter);
        if (!priorPage.rows.some(row => isDeepStrictEqual(row, state.candidate))) return finish("candidate_missing_from_retained_search");
      }
      if (!state.candidate && state.searchAfter === undefined && state.page >= USASPENDING_LEGACY_PAGE_BUDGET) {
        return finish("legacy_pagination_requires_review");
      }
      const stage = state.candidate ? "detail" : "search";
      const request: SourceRequest = state.candidate ? { method: "GET",
        url: `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(state.candidate.id)}/`, body: null }
        : { method: "POST", url: SEARCH_URL, body: federalDiscoverySearchBody(target.query, state.page, state.searchEndDate, state.searchAfter, state.collection) };
      const requestSha256 = federalSourceOnlyHash({ companyId, companyIdentity: state.companyIdentity, request });
      const title = `USAspending ${stage} evidence for ${company.name}`;
      const base: ObservationInput = { companyId, companyName: company.name, companyDomain: company.domain,
        netsuiteInternalId: company.netsuite_internal_id, sourceKind: "government", sourceUrl: request.url,
        title, text: "{}", governmentJsonCapture: { requestSha256 } };
      const sourceKey = prepareObservation(base).sourceKey;
      let retained = await readObservation(companyId, sourceKey);
      let body: unknown;
      // Recovery may only consume the independently bound original from this
      // exact interrupted operation. Missing or changed storage never fetches.
      if (retainedOnly && (!retained || retained.id !== retainedOnly.observationId || sourceKey !== retainedOnly.sourceKey
        || requestSha256 !== retainedOnly.requestSha256 || retained.metadata?.operationId !== operationId
        || retained.metadata?.retainedJsonSha256 !== retainedOnly.retainedJsonSha256
        || retained.metadata?.fullResponseCaptured !== true || retained.metadata?.sourceStage !== stage
        || !isDeepStrictEqual(retained.metadata?.continuationBefore, raw))) throw new FederalCaptureReadbackRequired();
      if (retained) {
        if (retained.company_id !== companyId || retained.source_key !== sourceKey || retained.source_kind !== "government"
          || retained.source_url !== request.url || retained.metadata?.governmentJsonCaptureVersion !== 1
          || retained.metadata?.requestSha256 !== requestSha256 || retained.metadata?.sourceOnly !== true
          || !isDeepStrictEqual(retained.metadata?.sourceRequest, request)
          || typeof retained.evidence_text !== "string" || retained.metadata.retainedJsonSha256 !== sha(retained.evidence_text)
          || !Number.isFinite(Date.parse(retained.observed_at))) throw new FederalCaptureReadbackRequired();
        prepareObservation({ ...base, text: retained.evidence_text }); // Same whole-object and size gate.
        body = JSON.parse(retained.evidence_text); reusedCapture = true;
      } else {
        requirePublicGrowthTime(deadlineMs); sourceRequests = 1;
        try {
          body = await fetchJson(request.url, { method: request.method, redirect: "error",
            ...(request.body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) } : {}) }, 20_000, 1, deadlineMs);
        } catch { return finish("provider_unavailable_no_retry"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return finish("invalid_provider_response_no_retry");
        const original = JSON.stringify(body);
        if (!governmentJsonWithinBounds(original)) return finish("source_exceeds_lossless_capture_bound");
        const input: ObservationInput = { ...base, text: original, observedAt: new Date().toISOString(), metadata: {
          sourceOnly: true, collector: "federal-discovery", operationId, sourceRequest: request,
          sourceStage: stage, fullResponseCaptured: true, historyComplete: false, analysisComplete: false,
          identityVerified: false, searchEndDate: state.searchEndDate, continuationBefore: raw,
          companyIdentity: { id: company.id, name: company.name, domain: company.domain, website: company.website_raw,
            city: company.city, state: company.state, netsuiteInternalId: company.netsuite_internal_id,
            legalNames: company.legalNames, addresses: company.addresses },
          limitation: "Name search retrieves candidates; company-recipient identity and signal interpretation require independent review.",
        } };
        try {
          const saved = await enqueueObservation(input);
          retained = await readObservation(companyId, sourceKey);
          if (!saved || !retained || retained.id !== saved.id || retained.company_id !== companyId
            || retained.source_kind !== "government" || retained.source_url !== request.url || retained.evidence_text !== original
            || retained.metadata?.requestSha256 !== requestSha256 || retained.metadata?.retainedJsonSha256 !== sha(original)
            || retained.metadata?.governmentJsonCaptureVersion !== 1 || !isDeepStrictEqual(retained.metadata?.sourceRequest, request)) {
            throw new FederalCaptureReadbackRequired();
          }
        } catch { throw new FederalCaptureReadbackRequired(); }
      }
      jobId = await exactJob(retained.id, retainedOnly);
      captured = { version: 1, status: "held", stage, reason: "awaiting_independent_review", observationId: retained.id,
        requestSha256, retainedJsonSha256: sha(retained.evidence_text), capturedAt: retained.observed_at };
      if (stage === "detail") {
        const detail = body as Record<string, unknown>;
        if (!detail.recipient || typeof detail.recipient !== "object" || Array.isArray(detail.recipient)) return finish("captured_detail_schema_requires_review");
        const award = compactAward(detail);
        if (award.generatedAwardId !== state.candidate!.id || (state.candidate!.uei && award.recipient.uei?.toUpperCase() !== state.candidate!.uei.toUpperCase())) {
          return finish("captured_detail_identity_conflict");
        }
        return finish("candidate_detail_captured_awaiting_independent_review");
      }
      let page: ReturnType<typeof parseFederalDiscoverySearchPage>;
      try { page = parseFederalDiscoverySearchPage(body, state.searchAfter); }
      catch { return finish("captured_search_schema_requires_review"); }
      const pageHash = stableHash(page.rows);
      if (page.hasNext && (!page.rows.length || pageHash === state.lastPageHash)) return finish("captured_pagination_did_not_advance");
      const seen = new Set(state.evaluatedRecipients ?? []);
      const candidates = page.rows.filter(row => {
        const key = row.uei ? `uei:${row.uei.toUpperCase()}` : `award:${row.id}`;
        if (seen.has(key) || !targetAcceptsSearchRow(target, { recipientName: row.name, recipientUei: row.uei })) return false;
        seen.add(key); return true;
      });
      state.candidate = candidates.shift() ?? null;
      state.candidateQueue = candidates;
      state.pendingPage = { hasNext: page.hasNext, pageHash, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      if (state.candidate) return finish("search_captured_detail_pending", false);
      if (!advanceDiscovery(state)) return finish("search_window_captured_awaiting_independent_review");
      return finish("search_page_captured_continuation_pending", false);
    } catch (error) {
      if (error instanceof FederalCaptureReadbackRequired) throw error;
      // A failed step is explicit durable debt, never a retry or a negative.
      return finish("source_step_requires_review");
    }
  });
}
