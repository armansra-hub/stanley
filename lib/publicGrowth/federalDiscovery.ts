import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { fetchJson, PublicGrowthDeadlineError, requirePublicGrowthTime } from "./http";
import { decideIdentityMatch, normalizeName } from "./identity";
import { awardUrl, compactAward, fetchAwardDetail } from "./usaspending";
import { stableHash } from "./storage";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
type Stage = "membership" | "award_search" | "award_detail" | "identity" | "persist" | "readback";
export interface FederalDiscoveryReceipt {
  companyId: string;
  status: "matched" | "no_candidate" | "ambiguous" | "error";
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
  entityId?: string;
  awardId?: string;
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

// A bounded discovery read deliberately validates the provider shape. The older
// history search adapter defaults absent results/pagination to an empty page.
async function searchPage(name: string, deadlineMs: number) {
  const data = await fetchJson<any>(SEARCH_URL, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filters: { recipient_search_text: [name], award_type_codes: ["A", "B", "C", "D"],
      time_period: [{ start_date: "2007-10-01", end_date: new Date().toISOString().slice(0, 10) }] },
    fields: ["Award ID", "Recipient Name", "Recipient UEI"], limit: 100, page: 1, sort: "Start Date", order: "desc" }),
  }, 20_000, 1, deadlineMs);
  if (!data || !Array.isArray(data.results) || data.results.length > 100 || typeof data.page_metadata?.hasNext !== "boolean") {
    fail("invalid_search_response");
  }
  const rows = data.results.map((row: any) => {
    const id = text(row?.generated_internal_id ?? row?.generated_unique_award_id);
    const name = text(row?.["Recipient Name"]);
    if (!id || id.length > 500 || !name || (row["Recipient UEI"] != null && !text(row["Recipient UEI"]))) fail("invalid_search_response");
    return { id, name, uei: text(row["Recipient UEI"]) };
  }) as Array<{ id: string; name: string; uei: string | null }>;
  return { rows, hasNext: data.page_metadata.hasNext as boolean };
}
type Entity = { id: string; uei: string | null; usaspending_recipient_id: string | null; legal_name: string };
async function entityBy(field: string, value: string): Promise<Entity | null> {
  return checked(serviceClient().from("government_entities").select("id,uei,usaspending_recipient_id,legal_name").eq(field, value).maybeSingle());
}
async function resolveEntity(recipient: ReturnType<typeof compactAward>["recipient"]): Promise<Entity | null> {
  const byUei = recipient.uei ? await entityBy("uei", recipient.uei) : null;
  const byRecipient = recipient.recipientId ? await entityBy("usaspending_recipient_id", recipient.recipientId) : null;
  if (byUei && byRecipient && byUei.id !== byRecipient.id) hold("conflicting_entity_identifiers");
  const entity = byUei ?? byRecipient;
  if (entity && ((entity.uei && recipient.uei && !same(entity.uei, recipient.uei))
    || (entity.usaspending_recipient_id && recipient.recipientId && !same(entity.usaspending_recipient_id, recipient.recipientId))
    || normalizeName(entity.legal_name) !== normalizeName(recipient.legalName))) hold("conflicting_existing_entity");
  return entity;
}
async function companyLinks(companyId: string, entity: Entity | null) {
  const links = await checked(serviceClient().from("company_government_matches")
    .select("government_entity_id,match_status").eq("company_id", companyId).limit(101));
  if (!Array.isArray(links) || links.length > 100) fail("invalid_existing_links");
  if (links.some((link) => !entity || link.government_entity_id !== entity.id || link.match_status !== "verified")) hold("conflicting_existing_link");
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

/** First-award discovery only: no transaction, metric, grade, or signal writes. */
export async function discoverFederalCompany(companyId: string, options: { deadlineMs?: number } = {}): Promise<FederalDiscoveryReceipt> {
  const started = Date.now();
  const deadline = Math.min(started + 60_000, options.deadlineMs ?? Infinity);
  let stage: Stage = "membership", sourceRequests = 0, mayHaveWritten = false;
  const receipt = (status: FederalDiscoveryReceipt["status"], reason: string, extra: Partial<FederalDiscoveryReceipt> = {}): FederalDiscoveryReceipt => ({
    companyId, status, reason, stage, elapsedMs: Math.max(0, Date.now() - started), sourceRequests,
    verified: status === "matched", historyComplete: false, exhaustive: false, mayHaveWritten, ...extra,
  });
  try {
    if (!UUID.test(companyId) || !Number.isFinite(deadline)) fail("invalid_request");
    return await withServiceDeadline(deadline, async () => {
      requirePublicGrowthTime(deadline);
      const company = await currentCompany(companyId);
      stage = "award_search"; requirePublicGrowthTime(deadline); sourceRequests++;
      const page = await searchPage(company.name, deadline);
      const candidates = page.rows.filter((row) => normalizeName(row.name) === normalizeName(company.name));
      // Pagination cannot establish uniqueness or absence for an unlinked name.
      if (page.hasNext) hold("candidate_page_truncated");
      if (!candidates.length) return receipt("no_candidate", "no_qualifying_candidate_in_bounded_page");
      const recipientKeys = new Set(candidates.map((row) => row.uei?.toUpperCase() ?? "unknown"));
      if (recipientKeys.size !== 1 || recipientKeys.has("unknown")) hold("recipient_identity_ambiguous");
      const selected = candidates[0];
      stage = "award_detail"; requirePublicGrowthTime(deadline); sourceRequests++;
      const detail = await fetchAwardDetail(selected.id, 1, deadline);
      if (!detail || typeof detail !== "object" || !detail.recipient || typeof detail.recipient !== "object") fail("invalid_award_response");
      const award = { ...compactAward(detail), sourceUrl: awardUrl(selected.id) }, recipient = award.recipient;
      if (award.generatedAwardId !== selected.id || !same(selected.uei, recipient.uei)
        || normalizeName(recipient.legalName) !== normalizeName(company.name)
        || !/^[A-Z0-9]{12}$/i.test(recipient.uei ?? "")
        || ![award.awardCeiling, award.currentAwardAmount, award.totalObligations].every(Number.isFinite)) fail("award_identity_mismatch");
      stage = "identity";
      const decision = decideIdentityMatch(company, recipient);
      if (decision.status !== "verified") hold("identity_not_verified");
      return serialized(deadline, async () => {
        const fresh = await currentCompany(companyId);
        if (companyIdentity(fresh) !== companyIdentity(company)) hold("company_identity_changed");
        let entity = await resolveEntity(recipient);
        await companyLinks(companyId, entity);
        await existingAward(award.generatedAwardId, entity);
        stage = "persist"; requirePublicGrowthTime(deadline);
        if (!entity) {
          mayHaveWritten = true;
          const payload = { legal_name: recipient.legalName, uei: recipient.uei, usaspending_recipient_id: recipient.recipientId,
            city: recipient.city, state: recipient.state, postal_code: recipient.postalCode, country_code: recipient.countryCode,
            source: "usaspending", source_url: award.sourceUrl, observed_at: new Date().toISOString(),
            evidence: { discovery: true, generatedAwardId: award.generatedAwardId }, payload_hash: stableHash(recipient) };
          await insertPreserving("government_entities", payload, "uei");
          entity = await resolveEntity(recipient);
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
          verified_by: "deterministic", verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }, "company_id,government_entity_id");
        const links = await companyLinks(companyId, verifiedEntity);
        if (links.length !== 1) fail("match_readback_missing");
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
              offersReceived: award.offersReceived, extentCompeted: award.extentCompeted, setAside: award.setAside } };
          await insertPreserving("federal_awards", payload, "generated_award_id");
          stored = await existingAward(award.generatedAwardId, verifiedEntity);
          if (!stored) fail("award_readback_missing");
        }
        stage = "readback"; requirePublicGrowthTime(deadline);
        const finalCompany = await currentCompany(companyId);
        if (companyIdentity(finalCompany) !== companyIdentity(company)) hold("company_identity_changed");
        if ((await companyLinks(companyId, verifiedEntity)).length !== 1) fail("match_readback_missing");
        const finalEntity = await resolveEntity(recipient);
        if (finalEntity?.id !== verifiedEntity.id) fail("entity_readback_missing");
        if (!(await existingAward(award.generatedAwardId, verifiedEntity))) fail("award_readback_missing");
        return receipt("matched", "verified_identity_and_first_award_persisted", { entityId: verifiedEntity.id, awardId: String(stored.id) });
      });
    });
  } catch (error) {
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
