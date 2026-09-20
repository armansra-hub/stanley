import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { enrichCompanyIdentity } from "@/lib/companyIdentity";
import { fetchJson, PublicGrowthDeadlineError, requirePublicGrowthTime } from "./http";
import { companyIdentityNames, normalizeName } from "./identity";
import { FederalIdentityDeferredError, resolveFederalIdentity } from "./federalIdentityResolution";
import type { IdentityDecision } from "./types";
import { awardUrl, compactAward, fetchAwardDetail, IDV_CODES, type FederalAwardCollection } from "./usaspending";
import { stableHash } from "./storage";
import { assertFrozenFederalIdentities, federalSearchTargets, loadVerifiedFederalIdentities,
  matchesFederalIdentifiers, targetAcceptsSearchRow, type VerifiedFederalIdentity } from "./federalIdentity";
import { parseFederalDiscoveryContinuation, type FederalDiscoveryCandidate, type FederalDiscoveryContinuation } from "./federalDiscoveryState";
import { advanceUsaspendingCursor, isUsaspendingResultWindowError, usaspendingCursorRequest, usaspendingNextCursor,
  USASPENDING_LEGACY_PAGE_BUDGET, type UsaspendingSearchAfter } from "./usaspendingCursor";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
type Stage = "membership" | "award_search" | "award_detail" | "identity" | "persist" | "readback";
export interface FederalDiscoveryReceipt {
  companyId: string;
  status: "matched" | "no_candidate" | "in_progress" | "ambiguous" | "error";
  reason: string;
  stage: Stage;
  elapsedMs: number;
  sourceRequests: number;
  verified: boolean;
  historyComplete: false;
  exhaustive: false;
  mayHaveWritten: boolean;
  failureClass?: string;
  httpStatus?: number;
  searchEndDate?: string;
  entityId?: string;
  awardId?: string;
  continuation?: FederalDiscoveryContinuation;
  candidateDecision?: { candidate: { awardId: string; name: string; uei: string | null; recipientId: string | null }; decision: IdentityDecision };
}
class DiscoveryHold extends Error {
  constructor(readonly outcome: "ambiguous" | "error", readonly reason: string) { super(reason); }
}
function hold(reason: string): never { throw new DiscoveryHold("ambiguous", reason); }
function fail(reason: string): never { throw new DiscoveryHold("error", reason); }
const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
const same = (a: unknown, b: unknown) => text(a)?.toUpperCase() === text(b)?.toUpperCase();

async function checked<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) fail("database_operation_failed");
  return data;
}
async function currentCompany(id: string) {
  const company: any = await checked(serviceClient().from("companies")
    .select("id,name,domain,website_raw,city,state,netsuite_internal_id,lists,status")
    .eq("id", id).contains("lists", ["netsuite_tam"]).maybeSingle());
  if (!company || company.id !== id || !Array.isArray(company.lists) || !company.lists.includes("netsuite_tam")
      || company.status === "removed_from_tam" || !text(company.name)) {
    fail("not_current_canonical_tam");
  }
  return company;
}
const companyIdentity = (c: any) => stableHash([c.id, c.name, c.domain, c.website_raw, c.city, c.state, c.netsuite_internal_id]);

// A bounded discovery read validates source shape and paired sequential cursors.
async function searchPage(name: string, page: number, endDate: string, deadlineMs: number, searchAfter?: UsaspendingSearchAfter, collection: FederalAwardCollection = "contracts") {
  const data = await fetchJson<any>(SEARCH_URL, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filters: { recipient_search_text: [name], award_type_codes: collection === "idvs" ? IDV_CODES : ["A", "B", "C", "D"],
      time_period: [{ start_date: "2007-10-01", end_date: endDate }] },
    fields: ["Award ID", "Recipient Name", "Recipient UEI", "Start Date"], limit: 100, page, sort: "Start Date", order: "desc",
    ...usaspendingCursorRequest(searchAfter) }),
  }, 20_000, 1, deadlineMs);
  if (!data || !Array.isArray(data.results) || data.results.length > 100 || typeof data.page_metadata?.hasNext !== "boolean") {
    fail("invalid_search_response");
  }
  const rows = data.results.map((row: any) => {
    const id = text(row?.generated_internal_id ?? row?.generated_unique_award_id);
    const name = text(row?.["Recipient Name"]);
    const uei = text(row["Recipient UEI"]);
    if (!id || id.length > 500 || !name || name.length > 500
      || (row["Recipient UEI"] != null && (!uei || !/^[A-Z0-9]{12}$/i.test(uei)))) fail("invalid_search_response");
    return { id, name, uei };
  }) as Array<{ id: string; name: string; uei: string | null }>;
  return { rows, hasNext: data.page_metadata.hasNext as boolean, nextCursor: usaspendingNextCursor(data.page_metadata, rows.length, searchAfter) };
}
type Entity = { id: string; uei: string | null; usaspending_recipient_id: string | null; legal_name: string };
async function entityBy(field: string, value: string): Promise<Entity | null> {
  return checked(serviceClient().from("government_entities").select("id,uei,usaspending_recipient_id,legal_name").eq(field, value).maybeSingle());
}
async function resolveEntity(recipient: ReturnType<typeof compactAward>["recipient"], bound?: VerifiedFederalIdentity | null): Promise<Entity | null> {
  const byUei = recipient.uei ? await entityBy("uei", recipient.uei) : null;
  const byRecipient = recipient.recipientId ? await entityBy("usaspending_recipient_id", recipient.recipientId) : null;
  if (byUei && byRecipient && byUei.id !== byRecipient.id) hold("conflicting_entity_identifiers");
  const entity = byUei ?? byRecipient;
  if (entity && ((entity.uei && recipient.uei && !same(entity.uei, recipient.uei))
    || (entity.usaspending_recipient_id && recipient.recipientId && !same(entity.usaspending_recipient_id, recipient.recipientId))
    || (bound && entity.id !== bound.entityId))) hold("conflicting_existing_entity");
  if (bound && !entity) hold("verified_entity_missing");
  return entity;
}
async function companyLinks(companyId: string, entity: Entity | null, allowUnverified = false) {
  if (!entity) return [];
  const links = await checked(serviceClient().from("company_government_matches")
    .select("government_entity_id,match_status").eq("company_id", companyId).eq("government_entity_id", entity.id).limit(2));
  if (!Array.isArray(links) || links.length > 1) fail("invalid_existing_links");
  // Other verified legal entities are legitimate. A pending/rejected link still
  // requires review; discovery never replaces those decisions.
  if (!allowUnverified && links.some((link) => link.match_status !== "verified")) hold("conflicting_existing_link");
  return links;
}
async function existingAward(generatedId: string, entity: Entity | null): Promise<any> {
  const award: any = await checked(serviceClient().from("federal_awards").select("id,government_entity_id,generated_award_id")
    .eq("generated_award_id", generatedId).maybeSingle());
  if (award && (!entity || award.government_entity_id !== entity.id)) hold("conflicting_existing_award");
  return award;
}

// Serialize only the short write section within this process. Every database
// insertion also ignores existing unique keys, so other processes cannot have
// a rejected link or shared entity replaced by this worker.
let writeTail: Promise<void> = Promise.resolve();
async function serialized<T>(deadlineMs: number, operation: () => Promise<T>): Promise<T> {
  const previous = writeTail;
  let release!: () => void;
  writeTail = new Promise<void>((resolve) => { release = resolve; });
  try { await previous; requirePublicGrowthTime(deadlineMs); return await operation(); }
  finally { release(); }
}
async function insertPreserving(table: string, payload: any, onConflict: string) {
  const query = serviceClient().from(table);
  // Entity identifiers use partial unique indexes, which cannot be named by
  // PostgREST on_conflict. A plain insert plus exact collision readback is safe.
  const { error } = table === "government_entities" ? await query.insert(payload)
    : await query.upsert(payload, { onConflict, ignoreDuplicates: true });
  // A different unique key may have won. Only the subsequent exact readback
  // can establish success; an ordinary error never becomes a completed match.
  if (error && error.code !== "23505") fail("database_operation_failed");
}

const candidateKey = (candidate: FederalDiscoveryCandidate) => candidate.uei ? `uei:${candidate.uei.toUpperCase()}` : `award:${candidate.id}`;
/** Move only after every selected candidate on this exact page has a durable
 * decision/enrollment receipt. A legacy candidate leaves its next page intact. */
function advanceDiscovery(state: FederalDiscoveryContinuation): boolean {
  if (state.candidateQueue?.length) {
    state.candidate = state.candidateQueue.shift()!;
    return true;
  }
  const page = state.pendingPage;
  if (!page) { state.candidate = null; delete state.candidateQueue; return true; }
  // Validate the next checkpoint before mutating the saved current candidate.
  if (page.hasNext) {
    if (state.page >= 10000) fail("search_partition_limit_requires_review");
    advanceUsaspendingCursor(state, true, page.nextCursor);
    state.candidate = null; delete state.candidateQueue; delete state.pendingPage;
    state.page++; state.lastPageHash = page.pageHash;
    return true;
  }
  state.candidate = null; delete state.candidateQueue; delete state.pendingPage;
  if (state.targetIndex + 1 < state.targets.length) state.targetIndex++;
  else if (state.collection !== "idvs") { state.collection = "idvs"; state.targetIndex = 0; }
  else return false;
  state.page = 1; state.lastPageHash = null;
  if (state.searchAfter !== undefined || state.collection === "idvs") state.searchAfter = null;
  return true;
}

/** One exact recipient and first award per invocation; the remaining search
 * stays checkpointed. No transaction, metric, grade, or signal writes. */
export async function discoverFederalCompany(companyId: string, options: { deadlineMs?: number; continuation?: FederalDiscoveryContinuation } = {}): Promise<FederalDiscoveryReceipt> {
  const started = Date.now();
  const deadline = Math.min(started + 60_000, options.deadlineMs ?? Infinity);
  let stage: Stage = "membership", sourceRequests = 0, mayHaveWritten = false;
  let state: FederalDiscoveryContinuation | undefined;
  let finished = false;
  let candidateDecision: FederalDiscoveryReceipt["candidateDecision"];
  const receipt = (status: FederalDiscoveryReceipt["status"], reason: string, extra: Partial<FederalDiscoveryReceipt> = {}): FederalDiscoveryReceipt => ({
    companyId, status, reason, stage, elapsedMs: Math.max(0, Date.now() - started), sourceRequests,
    searchEndDate: state?.searchEndDate, verified: status === "matched", historyComplete: false, exhaustive: false, mayHaveWritten,
    ...(state && !finished ? { continuation: structuredClone(state) } : {}),
    ...(candidateDecision ? { candidateDecision } : {}), ...extra,
  });
  try {
    if (!UUID.test(companyId) || !Number.isFinite(deadline)) fail("invalid_request");
    return await withServiceDeadline(deadline, async () => {
      requirePublicGrowthTime(deadline);
      const company = await enrichCompanyIdentity(await currentCompany(companyId));
      const knownNames = companyIdentityNames(company).map(normalizeName);
      const identities = await loadVerifiedFederalIdentities(companyId);
      state = options.continuation ? parseFederalDiscoveryContinuation(options.continuation, companyId) : {
        version: 1, companyId, companyIdentity: companyIdentity(company), searchEndDate: new Date().toISOString().slice(0, 10),
        targets: federalSearchTargets(company.name, identities, company.legalNames), targetIndex: 0, page: 1, candidate: null, lastPageHash: null,
      };
      if (state.companyIdentity !== companyIdentity(company)) hold("company_identity_changed");
      assertFrozenFederalIdentities(state.targets.flatMap((target) => target.identity ? [target.identity] : []), identities);
      const target = state.targets[state.targetIndex];
      if (!target.identity && !knownNames.includes(normalizeName(target.query))) fail("invalid_unbound_query");
      const completed = () => receipt(state?.foundVerified ? "matched" : "no_candidate",
        state?.foundVerified ? "candidate_search_completed_with_verified_matches" : "no_qualifying_candidate_in_contract_and_idv_search_window");
      stage = "award_search"; requirePublicGrowthTime(deadline);
      if (!state.candidate) {
        if (state.searchAfter === undefined && state.page >= USASPENDING_LEGACY_PAGE_BUDGET) {
          state.page = 1; state.lastPageHash = null; state.searchAfter = null;
          return receipt("in_progress", "legacy_search_restarts_with_sequential_cursor");
        }
        sourceRequests++;
        let page: Awaited<ReturnType<typeof searchPage>>;
        try { page = await searchPage(target.query, state.page, state.searchEndDate, deadline, state.searchAfter, state.collection); }
        catch (error) {
          if (state.searchAfter !== undefined || !isUsaspendingResultWindowError(error)) throw error;
          state.page = 1; state.lastPageHash = null; state.searchAfter = null;
          return receipt("in_progress", "provider_window_restarts_with_sequential_cursor");
        }
        const pageHash = stableHash(page.rows);
        if (page.hasNext && (!page.rows.length || pageHash === state.lastPageHash)) fail("search_pagination_did_not_advance");
        const seen = new Set(state.evaluatedRecipients ?? []);
        const candidates = page.rows.filter((row) => {
          const key = candidateKey(row);
          if (!targetAcceptsSearchRow(target, { recipientName: row.name, recipientUei: row.uei }) || seen.has(key)) return false;
          seen.add(key); return true;
        });
        state.candidate = candidates.shift() ?? null;
        state.candidateQueue = candidates;
        state.pendingPage = { hasNext: page.hasNext, pageHash, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        if (!state.candidate) {
          const oldCollection = state.collection, oldTarget = state.targetIndex;
          finished = !advanceDiscovery(state);
          if (finished) return completed();
          return receipt("in_progress", state.collection !== oldCollection ? "searching_contract_vehicles"
            : state.targetIndex !== oldTarget ? "next_verified_alias" : "candidate_search_continues");
        }
      }
      const selected = state.candidate;
      if ((state.evaluatedRecipients?.length ?? 0) >= 1000) fail("discovery_recipient_partition_required");
      const finishCandidate = (verified: boolean) => {
        state!.evaluatedRecipients = [...new Set([...(state!.evaluatedRecipients ?? []), candidateKey(selected)])];
        if (verified) state!.foundVerified = true;
        finished = !advanceDiscovery(state!);
      };
      stage = "award_detail"; requirePublicGrowthTime(deadline); sourceRequests++;
      const detail = await fetchAwardDetail(selected.id, 1, deadline);
      if (!detail || typeof detail !== "object" || !detail.recipient || typeof detail.recipient !== "object") fail("invalid_award_response");
      const award = { ...compactAward(detail), sourceUrl: awardUrl(selected.id) }, recipient = award.recipient;
      if (award.generatedAwardId !== selected.id || (selected.uei && !same(selected.uei, recipient.uei))
        || (recipient.uei ? !/^[A-Z0-9]{12}$/i.test(recipient.uei) : !text(recipient.recipientId))
        || ![award.awardCeiling, award.currentAwardAmount, award.totalObligations].every(Number.isFinite)) fail("award_identity_mismatch");
      stage = "identity";
      if (target.identity && !matchesFederalIdentifiers(target.identity, recipient)) {
        // A broad legal-name result can legitimately belong to another entity.
        // Its intact source identifiers reject this candidate, not the remaining page.
        candidateDecision = { candidate: { awardId: selected.id, name: recipient.legalName, uei: recipient.uei, recipientId: recipient.recipientId },
          decision: { status: "rejected", method: "conflict", confidence: 1,
            evidence: { verifiedEntityId: target.identity.entityId, matchedIdentifiers: false, reason: "different_bound_recipient" } } };
        finishCandidate(false);
        return finished ? completed() : receipt("in_progress", "different_bound_recipient_skipped");
      }
      const existingEntity = await resolveEntity(recipient, target.identity);
      const selectedLinks = await companyLinks(companyId, existingEntity, true);
      const priorDecision = selectedLinks.find(link => link.match_status !== "verified");
      const boundIdentity = target.identity ?? identities.find(identity => identity.entityId === existingEntity?.id
        && matchesFederalIdentifiers(identity, recipient));
      const decision = priorDecision ? { status: priorDecision.match_status === "rejected" ? "rejected" as const : "pending" as const,
        method: "conflict" as const, confidence: 0, evidence: { existingEntityId: existingEntity?.id, existingMatchStatus: priorDecision.match_status } }
        : boundIdentity ? { status: "verified" as const, method: "verified_identifier", confidence: 1,
          evidence: { verifiedEntityId: boundIdentity.entityId, matchedIdentifiers: true } }
        : await resolveFederalIdentity(company, { ...recipient, addressLine1: recipient.address, id: selected.id, sourceUrl: award.sourceUrl }, { deadlineMs: deadline });
      if (!target.identity || priorDecision) candidateDecision = {
        candidate: { awardId: selected.id, name: recipient.legalName, uei: recipient.uei, recipientId: recipient.recipientId },
        decision: decision as IdentityDecision,
      };
      if (decision.status !== "verified") {
        finishCandidate(false);
        if (finished) return completed();
        return receipt("in_progress", priorDecision ? "existing_candidate_decision_preserved" : "candidate_identity_evaluated");
      }
      return serialized(deadline, async () => {
        const fresh = await currentCompany(companyId);
        if (companyIdentity(fresh) !== companyIdentity(company)) hold("company_identity_changed");
        if (boundIdentity) assertFrozenFederalIdentities([boundIdentity], await loadVerifiedFederalIdentities(companyId));
        let entity = await resolveEntity(recipient, target.identity);
        await companyLinks(companyId, entity);
        await existingAward(award.generatedAwardId, entity);
        stage = "persist"; requirePublicGrowthTime(deadline);
        if (!entity) {
          mayHaveWritten = true;
          const payload = { legal_name: recipient.legalName, uei: recipient.uei, usaspending_recipient_id: recipient.recipientId,
            address_line1: recipient.address,
            city: recipient.city, state: recipient.state, postal_code: recipient.postalCode, country_code: recipient.countryCode,
            source: "usaspending", source_url: award.sourceUrl, observed_at: new Date().toISOString(),
            evidence: { discovery: true, generatedAwardId: award.generatedAwardId }, payload_hash: stableHash(recipient) };
          await insertPreserving("government_entities", payload, "uei");
          entity = await resolveEntity(recipient, target.identity);
          if (!entity) fail("entity_readback_missing");
        }
        const verifiedEntity = entity as Entity;
        // Recheck after entity insertion; a concurrent rejected link must win.
        await companyLinks(companyId, verifiedEntity);
        const current = await currentCompany(companyId);
        if (companyIdentity(current) !== companyIdentity(company)) hold("company_identity_changed");
        requirePublicGrowthTime(deadline); mayHaveWritten = true;
        await insertPreserving("company_government_matches", { company_id: companyId, government_entity_id: verifiedEntity.id,
          match_status: "verified", match_method: decision.method, confidence: decision.confidence,
          evidence: { ...decision.evidence, discovery: true, generatedAwardId: award.generatedAwardId },
          verified_by: decision.method === "jev_identity" ? "jev_identity" : "deterministic", verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "company_id,government_entity_id");
        const links = await companyLinks(companyId, verifiedEntity);
        if (links.filter((link) => link.government_entity_id === verifiedEntity.id).length !== 1) fail("match_readback_missing");
        let stored = await existingAward(award.generatedAwardId, verifiedEntity);
        if (!stored) {
          requirePublicGrowthTime(deadline);
          const payload = { government_entity_id: verifiedEntity.id, generated_award_id: award.generatedAwardId, award_id: award.awardId,
            parent_award_id: award.parentAwardId, award_type: award.awardType, description: award.description,
            awarding_agency: award.awardingAgency, awarding_subagency: award.awardingSubagency, funding_agency: award.fundingAgency,
            funding_subagency: award.fundingSubagency, awarding_office: award.awardingOffice, naics_code: award.naicsCode, psc_code: award.pscCode,
            start_date: award.startDate, end_date: award.endDate, potential_end_date: award.potentialEndDate,
            award_ceiling: award.awardCeiling, current_award_amount: award.currentAwardAmount, total_obligations: award.totalObligations,
            source_url: award.sourceUrl, source_updated_at: award.sourceUpdatedAt, observed_at: new Date().toISOString(),
            payload_hash: stableHash(award), evidence: { discovery: true, solicitationIdentifier: award.solicitationIdentifier,
              offersReceived: award.offersReceived, extentCompeted: award.extentCompeted, setAside: award.setAside,
              awardCategory: award.awardCategory, awardTypeCode: award.awardTypeCode, signedDate: award.signedDate,
              orderingEndDate: award.orderingEndDate, optionSchedule: "not_provided_by_source" } };
          await insertPreserving("federal_awards", payload, "generated_award_id");
          stored = await existingAward(award.generatedAwardId, verifiedEntity);
          if (!stored) fail("award_readback_missing");
        }
        stage = "readback"; requirePublicGrowthTime(deadline);
        const finalCompany = await currentCompany(companyId);
        if (companyIdentity(finalCompany) !== companyIdentity(company)) hold("company_identity_changed");
        if ((await companyLinks(companyId, verifiedEntity)).filter((link) => link.government_entity_id === verifiedEntity.id).length !== 1) fail("match_readback_missing");
        const finalEntity = await resolveEntity(recipient, target.identity);
        if (finalEntity?.id !== verifiedEntity.id) fail("entity_readback_missing");
        if (!(await existingAward(award.generatedAwardId, verifiedEntity))) fail("award_readback_missing");
        finishCandidate(true);
        return receipt("matched", "verified_identity_and_first_award_persisted", { entityId: verifiedEntity.id, awardId: String(stored.id) });
      });
    });
  } catch (error) {
    if (error instanceof FederalIdentityDeferredError) return receipt("in_progress", "identity_evaluation_deferred");
    if (error instanceof DiscoveryHold) return receipt(error.outcome, error.reason);
    if (error instanceof PublicGrowthDeadlineError || Date.now() >= deadline) return receipt("error", "deadline_reached", { failureClass: "deadline" });
    const status = error instanceof Error ? Number(error.message.match(/^(\d{3})\s/)?.[1]) : NaN;
    const failureClass = status === 429 ? "rate_limited" : Number.isInteger(status) ? "http_error"
      : error instanceof Error && /abort|timeout/i.test(error.name) ? "request_timeout"
      : error instanceof SyntaxError ? "invalid_json" : "operation_failed";
    return receipt("error", failureClass, { failureClass, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) });
  }
}

/** Finite worker pool; a 429 stops further admissions and preserves untouched IDs. */
export async function discoverFederalBatch(companyIds: readonly string[], options: { deadlineMs?: number; concurrency?: number } = {}) {
  if (companyIds.length > 100 || new Set(companyIds).size !== companyIds.length || companyIds.some((id) => !UUID.test(id))) throw new Error("invalid discovery batch");
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("invalid discovery concurrency");
  const deadlineMs = Math.min(Date.now() + 240_000, options.deadlineMs ?? Infinity);
  if (!Number.isFinite(deadlineMs)) throw new Error("invalid discovery deadline");
  const receipts: Array<FederalDiscoveryReceipt | undefined> = new Array(companyIds.length);
  let next = 0, stopped = false;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!stopped && next < companyIds.length && Date.now() < deadlineMs) {
      const index = next++;
      const result = await discoverFederalCompany(companyIds[index], { deadlineMs });
      receipts[index] = result;
      if (result.httpStatus === 429) stopped = true;
    }
  }));
  return { receipts: receipts.filter((r): r is FederalDiscoveryReceipt => Boolean(r)), notAttemptedCompanyIds: companyIds.filter((_, i) => !receipts[i]) };
}
