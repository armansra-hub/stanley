import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { enrichCompanyIdentity, isCompanyIdentitySource } from "@/lib/companyIdentity";
import { evaluateNativeCached, type NativeQuestion } from "@/lib/intelligence/nativeJev";
import { IDENTITY_RELATIONS, visibleIdentityClaims, type SiteIdentityClaim, type IdentityRelation } from "@/lib/sources/companyIdentityEvidence";
import { decideIdentityMatch, companyIdentityNames, normalizeName } from "./identity";
import { matchesFederalIdentifiers } from "./federalIdentity";
import { searchContractAwardsPage, fetchAwardDetail, compactAward, awardUrl, type FederalAwardCollection, type AwardSearchRow } from "./usaspending";
import { stableHash, saveFederalAward } from "./storage";
import type { TamIdentity } from "./types";
import type { UsaspendingSearchCursor } from "./usaspendingCursor";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { sitePageEvidence, sameCompanySite } from "@/lib/sources/siteDiscovery";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DIRECT = new Set<IdentityRelation>(["legal_name", "dba", "former_name"]);
type Observation = { id: string; source_url: string; observed_at: string; evidence_text: string; metadata: Record<string, any> };
type Claim = { id: string; company_id: string; observation_id: string; candidate_name: string; subject_name: string;
  relationship: IdentityRelation; source_url: string; captured_at: string; evidence: { candidate: SiteIdentityClaim;
    candidateSource?: { url: string; capturedAt: string; attempted: boolean } }; recipient_cursor: unknown };
type SearchState = { version: 1; page: number; collection: FederalAwardCollection; through: string;
  searchAfter: UsaspendingSearchCursor | null; queue: Array<Pick<AwardSearchRow, "generatedId" | "recipientName" | "recipientUei">>;
  seenUeis: string[]; pageLoaded: boolean; hasNext: boolean; nextCursor: UsaspendingSearchCursor | null; lastPageHash: string | null };
async function data<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query; if (result.error) throw new Error("federal_identity_database_unavailable"); return result.data;
}

export function accountIdentityCandidates(company: TamIdentity, observation: Observation): SiteIdentityClaim[] {
  if (!isCompanyIdentitySource(observation.source_url, company.domain || company.website_raw)) return [];
  const names = companyIdentityNames(company), normalized = names.map(normalizeName);
  const structured = Array.isArray(observation.metadata?.identityClaims) ? observation.metadata.identityClaims : [];
  const all = [...structured, ...visibleIdentityClaims(observation.evidence_text, names)] as SiteIdentityClaim[];
  return all.filter(c => c && typeof c.subjectName === "string" && normalized.includes(normalizeName(c.subjectName))
    && typeof c.candidateName === "string" && c.candidateName.trim().length >= 3 && c.candidateName.length <= 180
    && typeof c.sourceQuote === "string" && c.sourceQuote.length <= 1800 && IDENTITY_RELATIONS.includes(c.relationshipHint)
    && (c.sourceFormat === "json_ld" || c.sourceFormat === "visible" && observation.evidence_text.includes(c.sourceQuote)))
    .filter((c, i, all) => all.findIndex(other => normalizeName(other.candidateName) === normalizeName(c.candidateName)
      && other.relationshipHint === c.relationshipHint) === i).slice(0, 12);
}

/** First interpretation of real, account-anchored declarations. Jev's native
 * answer and probability fields are stored untouched; no second-model judge. */
async function ingestIdentityClaims(company: TamIdentity, observations: Observation[]) {
  const db = serviceClient(); let added = 0, processed = 0;
  for (const observation of observations) {
    processed++;
    const candidates = accountIdentityCandidates(company, observation);
    if (!candidates.length) continue;
    const fingerprints = candidates.map(candidate => stableHash([observation.id, candidate]));
    const existing: any[] = (await data(db.from("company_federal_identity_claims").select("fingerprint").eq("company_id", company.id).in("fingerprint", fingerprints))) ?? [];
    const pending = candidates.map((candidate, index) => ({ candidate, fingerprint: fingerprints[index] })).filter(row => !existing.some(x => x.fingerprint === row.fingerprint));
    if (!pending.length) continue;
    const questions: Record<string, NativeQuestion> = Object.fromEntries(pending.map(({ candidate }, index) => [`candidate_${index}`, {
      type: "choice", instructions: `Interpret the explicit relationship from the supplied official source between the account and candidate ${candidate.candidateName}. Direction is candidate relative to account. A customer, contractor, portfolio investment without ownership evidence, or merely similar name is unrelated. A former name means the same legal/business identity under a prior name, not a sold division. Do not infer missing facts.`,
      criteria: { legal_name: "The account's own legal entity name", dba: "The account's own trade/DBA name", former_name: "Former name of the same business identity",
        parent: "A separate entity that owns the account", subsidiary: "A separate entity owned by the account", joint_venture: "A named separate joint venture involving the account",
        division: "A separately named operating division; related context until legal identity is established", unrelated: "No relevant identity relationship", unknown: "The source does not establish the relationship" },
    }]));
    const result = await evaluateNativeCached({ state: { account: { name: company.name, domain: company.domain }, sourceUrl: observation.source_url,
      capturedAt: observation.observed_at, candidates: pending.map(row => row.candidate) }, questions },
    { purpose: "federal_identity", companyId: company.id, observationId: observation.id, sourceKind: "federal_identity", workload: "monitoring" });
    if (result.status !== "complete" || !result.evaluation.ok) throw new Error(result.status === "complete" ? "identity_interpretation_unavailable" : result.status);
    const raw = result.evaluation.provider_result;
    for (let index = 0; index < pending.length; index++) {
      const relationship = raw.answers[`candidate_${index}`]?.choice as IdentityRelation;
      if (!IDENTITY_RELATIONS.includes(relationship)) continue;
      const { candidate, fingerprint } = pending[index];
      await data(db.from("company_federal_identity_claims").upsert({ company_id: company.id, observation_id: observation.id, fingerprint,
        subject_name: candidate.subjectName, candidate_name: candidate.candidateName, relationship, source_url: observation.source_url,
        source_quote: candidate.sourceQuote, captured_at: observation.observed_at,
        evidence: { candidate, nativeJev: raw, answerId: `candidate_${index}`, researchPurpose: observation.metadata?.researchPurpose ?? null } },
      { onConflict: "company_id,fingerprint", ignoreDuplicates: true })); added++;
    }
    // At most one paid interpretation per invocation. Remaining observations
    // retain their place in the exact (observed_at,id) source cursor.
    return { added, processed };
  }
  return { added, processed };
}

export function readIdentityRecipientCursor(value: unknown, now = new Date()): SearchState {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return { version: 1, page: 1, collection: "contracts", through: now.toISOString().slice(0, 10),
    searchAfter: null, queue: [], seenUeis: [], pageLoaded: false, hasNext: false, nextCursor: null, lastPageHash: null };
  const s = value as SearchState;
  if (s.version !== 1 || !Number.isInteger(s.page) || s.page < 1 || s.page > 10000 || !["contracts", "idvs"].includes(s.collection)
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.through) || !Array.isArray(s.queue) || s.queue.length > 100
    || !Array.isArray(s.seenUeis) || s.seenUeis.length > 2000 || s.seenUeis.some(uei => !/^[A-Z0-9]{12}$/.test(uei))
    || s.queue.some(row => !row || typeof row.generatedId !== "string" || !row.generatedId || row.generatedId.length > 500 || typeof row.recipientName !== "string"
      || !/^[A-Z0-9]{12}$/.test(row.recipientUei ?? "")) || typeof s.pageLoaded !== "boolean" || typeof s.hasNext !== "boolean") throw new Error("invalid_identity_recipient_cursor");
  return structuredClone(s);
}

export function candidateAccount(company: TamIdentity, claim: Claim): TamIdentity {
  if (DIRECT.has(claim.relationship)) return { ...company, legalNames: [...(company.legalNames ?? []), claim.candidate_name] };
  // Never lend the account's CRM address to a parent/subsidiary/JV. Only an
  // address explicitly attached to the named candidate may support that entity.
  const candidate = claim.evidence.candidate;
  return { id: company.id, name: claim.candidate_name, domain: candidate.candidateDomain ?? null,
    addresses: candidate.candidateAddress ? [{ ...candidate.candidateAddress, sourceKind: "company_website", sourceId: claim.observation_id,
      sourceUrl: claim.evidence.candidateSource?.url ?? claim.source_url, capturedAt: claim.evidence.candidateSource?.capturedAt ?? claim.captured_at }] : [] };
}

export async function advanceIdentityClaim(company: TamIdentity, claim: Claim, lease: string, deadline: number) {
  const db = serviceClient(), state = readIdentityRecipientCursor(claim.recipient_cursor);
  const source = await data(db.from("intelligence_observations").select("is_current,feedback_excluded,source_url").eq("id", claim.observation_id).single());
  if (!source || !source.is_current || source.feedback_excluded || !isCompanyIdentitySource(source.source_url, company.domain || company.website_raw)) {
    await data(db.from("company_federal_identity_claims").update({ status: "needs_evidence", updated_at: new Date().toISOString() }).eq("id", claim.id));
    return { pending: false, status: "source_changed" };
  }
  let outcome = "searching", complete = false;
  const declared = claim.evidence.candidate;
  if (!DIRECT.has(claim.relationship) && !declared.candidateAddress && declared.candidateDomain && !claim.evidence.candidateSource?.attempted) {
    const url = `https://${declared.candidateDomain}`;
    claim.evidence.candidateSource = { url, capturedAt: new Date().toISOString(), attempted: true };
    try {
      const response = await fetchPublicHttpText(url, { timeoutMs: 6000, maxBytes: 1_000_000, accept: "text/html,application/xhtml+xml" });
      if (response.status >= 200 && response.status < 300 && sameCompanySite(response.finalUrl, url)) {
        const identity = sitePageEvidence(response.body, response.finalUrl).companyIdentity;
        if (identity?.names.some(name => normalizeName(name) === normalizeName(claim.candidate_name))) {
          const address = identity.addresses.find(address => address.addressLine1 && (address.postalCode || address.city && address.state));
          if (address?.addressLine1) declared.candidateAddress = { ...address, addressLine1: address.addressLine1 };
          claim.evidence.candidateSource.url = response.finalUrl;
        }
      }
    } catch { /* A missing candidate address stays unresolved; no borrowed HQ. */ }
    await data(db.from("company_federal_identity_claims").update({ evidence: claim.evidence }).eq("id", claim.id));
  }
  if (!state.pageLoaded) {
    const page = await searchContractAwardsPage(claim.candidate_name, state.page, state.through, 100, deadline, state.searchAfter, state.collection);
    const pageHash = stableHash(page.rows);
    if (page.hasNext && (!page.rows.length || pageHash === state.lastPageHash)) throw new Error("identity_search_did_not_advance");
    state.queue = [...new Map(page.rows.filter(row => normalizeName(row.recipientName) === normalizeName(claim.candidate_name)
      && /^[A-Z0-9]{12}$/i.test(row.recipientUei ?? "") && !state.seenUeis.includes(row.recipientUei!.toUpperCase()))
      .map(row => [row.recipientUei!.toUpperCase(), { generatedId: row.generatedId, recipientName: row.recipientName, recipientUei: row.recipientUei!.toUpperCase() }])).values()];
    state.hasNext = page.hasNext; state.nextCursor = page.nextCursor ?? null; state.pageLoaded = true; state.lastPageHash = pageHash;
  }
  const candidate = state.queue[0];
  if (candidate) {
    const award = { ...compactAward(await fetchAwardDetail(candidate.generatedId, 1, deadline)), sourceUrl: awardUrl(candidate.generatedId) };
    const recipient = award.recipient;
    if (award.generatedAwardId !== candidate.generatedId || recipient.uei?.toUpperCase() !== candidate.recipientUei
      || normalizeName(recipient.legalName) !== normalizeName(claim.candidate_name)) throw new Error("identity_candidate_changed");
    const decision = decideIdentityMatch(candidateAccount(company, claim), { ...recipient, addressLine1: recipient.address });
    if (decision.status === "verified") {
      const entityId = await data(db.rpc("federal_identity_bind_candidate", { p_company: company.id, p_lease: lease, p_claim: claim.id,
        p_entity: { uei: recipient.uei?.toUpperCase(), usaspending_recipient_id: recipient.recipientId, legal_name: recipient.legalName,
          address_line1: recipient.address, city: recipient.city, state: recipient.state, postal_code: recipient.postalCode, country_code: recipient.countryCode, source_url: award.sourceUrl }, p_decision: decision }));
      const prior = await data(db.from("federal_awards").select("government_entity_id").eq("generated_award_id", award.generatedAwardId).maybeSingle());
      if (prior && prior.government_entity_id !== entityId) throw new Error("identity_award_owner_conflict");
      await saveFederalAward(entityId, award); outcome = DIRECT.has(claim.relationship) ? "direct_recipient_enrolled" : "related_recipient_enrolled";
    } else outcome = "recipient_needs_evidence";
    state.seenUeis.push(candidate.recipientUei!); state.queue.shift();
    // Each candidate gets its own durable receipt, including unsupported peers.
    await data(db.from("federal_identity_candidate_receipts").upsert({ claim_id: claim.id, uei: candidate.recipientUei,
      generated_award_id: candidate.generatedId, outcome, decision, source_url: award.sourceUrl }, { onConflict: "claim_id,uei", ignoreDuplicates: true }));
  }
  if (!state.queue.length) {
    if (state.hasNext) { if (!state.nextCursor || state.page >= 10000) throw new Error("identity_search_partition_limit"); state.page++; state.searchAfter = state.nextCursor; state.pageLoaded = false; }
    else if (state.collection === "contracts") { state.collection = "idvs"; state.page = 1; state.searchAfter = null; state.pageLoaded = false; state.lastPageHash = null; }
    else complete = true;
  }
  await data(db.from("company_federal_identity_claims").update({ recipient_cursor: state, status: complete ? "complete" : "searching", updated_at: new Date().toISOString() }).eq("id", claim.id));
  return { pending: !complete, status: outcome, completeSearch: complete, historyComplete: false };
}

export function isWeakHistoricalMatch(match: { match_method: string; evidence?: Record<string, any> }) {
  const e = match.evidence ?? {};
  return ["name_only", "exact_name_state", "exact_name_city_state", "domain_only"].includes(match.match_method)
    || match.match_method === "exact_name_address" && !(e.nameMatch === true && e.addressMatch === true && Array.isArray(e.addressEvidence) && e.addressEvidence.some((a: any) => a.streetMatch && a.supportsIdentity))
    || match.match_method === "domain" && !(e.nameMatch === true && e.domainMatch === true);
}

export async function remediateOne(company: TamIdentity, lease: string, deadline: number) {
  const db = serviceClient();
  // Selection/exclusion happens against the complete database set under the
  // existing company lease. Large recipient families never require a truncated
  // client-side match list or capped receipt list to decide the next exact ID.
  const selection: any = await data(db.rpc("federal_identity_next_repair_match", { p_company: company.id, p_lease: lease }));
  const match = selection?.match;
  if (!match) return { status: selection?.hasWeakMatches ? "awaiting_new_evidence" : "no_weak_matches", pending: false };
  const entity: any = await data(db.from("government_entities").select("*").eq("id", match.government_entity_id).single());
  const latest = await data(db.from("federal_awards").select("generated_award_id").eq("government_entity_id", entity.id).order("observed_at", { ascending: false }).limit(1).maybeSingle());
  let decision: ReturnType<typeof decideIdentityMatch> | null = null, sourceUrl: string | null = null;
  if (latest) {
    const fresh = compactAward(await fetchAwardDetail(latest.generated_award_id, 1, deadline));
    if (fresh.generatedAwardId !== latest.generated_award_id || !matchesFederalIdentifiers({ uei: entity.uei, recipientId: entity.usaspending_recipient_id }, fresh.recipient)) throw new Error("remediation_source_identifier_changed");
    decision = decideIdentityMatch(company, { ...fresh.recipient, addressLine1: fresh.recipient.address });
    sourceUrl = awardUrl(latest.generated_award_id);
  }
  const relatedRows: any[] = (await data(db.from("company_related_government_entities")
    .select("id,claim_id,company_federal_identity_claims!inner(intelligence_observations!inner(is_current,feedback_excluded))")
    .eq("company_id", company.id).eq("government_entity_id", entity.id).limit(100))) ?? [];
  const related = relatedRows.filter(row => row.company_federal_identity_claims?.intelligence_observations?.is_current === true
    && row.company_federal_identity_claims.intelligence_observations.feedback_excluded === false);
  const outcome = decision?.status === "verified" ? "strengthened_direct" : related.length ? "related_context" : "needs_evidence";
  const result = await data(db.rpc("federal_identity_repair_match", { p_company: company.id, p_lease: lease, p_match: match.id, p_before: match,
    p_outcome: outcome, p_decision: decision ?? {}, p_evidence: { sourceUrl, sourceReadAt: new Date().toISOString(),
      candidateDecision: decision, relatedBindingIds: related.map(row => row.id), missing: latest ? null : "No stored award supplies a fresh source identifier/address; no demotion performed." } }));
  return { ...result, matchId: match.id, pending: result.outcome === "stale" || selection.pending === true };
}

/** One persisted company lease; source discovery, each recipient, and historical
 * repairs are bounded and resumable. Never touches federal discovery fences. */
export async function runFederalIdentityResearch() {
  const db = serviceClient(), job: any = await data(db.rpc("federal_identity_claim_job"));
  if (!job) return { status: "idle" };
  const cursor = job.cursor ?? {}, deadline = Date.now() + 100_000;
  try {
    const raw = await data(db.from("companies").select("id,name,domain,website_raw,city,state,lists,status").eq("id", job.company_id).single());
    if (!raw) throw new Error("identity_company_unavailable");
    if (!raw.lists?.includes("netsuite_tam") || raw.lists.includes("tam_duplicate") || raw.status === "removed_from_tam") throw new Error("identity_company_not_current_tam");
    let company = await enrichCompanyIdentity(raw);
    let query = db.from("intelligence_observations").select("id,source_url,observed_at,evidence_text,metadata").eq("company_id", job.company_id)
      .eq("is_current", true).eq("feedback_excluded", false).order("observed_at").order("id").limit(6);
    if (cursor.observedAfter && cursor.observationId && Number.isFinite(Date.parse(cursor.observedAfter)) && /^[a-f0-9-]{36}$/i.test(cursor.observationId))
      query = query.or(`observed_at.gt.${cursor.observedAfter},and(observed_at.eq.${cursor.observedAfter},id.gt.${cursor.observationId})`);
    const observations: Observation[] = (await data(query)) ?? [];
    const { added, processed } = await ingestIdentityClaims(company, observations);
    if (processed) { cursor.observedAfter = observations[processed - 1].observed_at; cursor.observationId = observations[processed - 1].id; }
    if (added) company = await enrichCompanyIdentity(raw);
    const claims: Claim[] = (await data(db.from("company_federal_identity_claims").select("*").eq("company_id", job.company_id)
      .in("status", ["pending", "searching"]).order("updated_at").limit(2))) ?? [];
    const discovery = claims[0] ? await advanceIdentityClaim(company, claims[0], job.lease_token, deadline) : { pending: false, status: "no_pending_claim" };
    const remediation = Date.now() < deadline - 25_000 ? await remediateOne(company, job.lease_token, deadline) : { status: "deferred_for_time", pending: true };
    const receipt = { status: "complete", companyId: job.company_id, observations: observations.length, added, discovery, remediation };
    const completed = await data(db.rpc("federal_identity_finish_job", { p_company: job.company_id, p_lease: job.lease_token, p_cursor: cursor,
      p_receipt: receipt, p_pending: observations.length === 6 || processed < observations.length || discovery.pending || claims.length > 1 || remediation.pending === true }));
    if (!completed) throw new Error("identity_lease_lost");
    return receipt;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "identity_worker_unavailable";
    await data(db.rpc("federal_identity_finish_job", { p_company: job.company_id, p_lease: job.lease_token, p_cursor: cursor,
      p_receipt: { status: "failed", reason }, p_pending: true }));
    return { status: "failed", companyId: job.company_id, reason };
  }
}

/** Finite legacy repair through the same company leases and receipt transaction.
 * No source discovery or paid inference, and no concurrent account worker. */
export async function runHistoricalFederalRemediation(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid remediation limit");
  const db = serviceClient(), deadline = Date.now() + 220_000;
  const receipts: Array<Record<string, unknown>> = [];
  let exhausted = false;
  for (let index = 0; index < limit && Date.now() < deadline - 25_000; index++) {
    const job: any = await data(db.rpc("federal_identity_claim_job", { p_weak_only: true }));
    if (!job) { exhausted = true; break; }
    try {
      const raw = await data(db.from("companies").select("id,name,domain,website_raw,city,state").eq("id", job.company_id).single());
      if (!raw) throw new Error("identity_company_unavailable");
      const company = await enrichCompanyIdentity(raw);
      const result = await remediateOne(company, job.lease_token, deadline);
      const receipt = { companyId: job.company_id, ...result };
      const complete = await data(db.rpc("federal_identity_finish_job", { p_company: job.company_id, p_lease: job.lease_token,
        p_cursor: job.cursor ?? {}, p_receipt: { mode: "historical_remediation", ...receipt }, p_pending: result.pending === true }));
      if (!complete) throw new Error("identity_lease_lost");
      receipts.push(receipt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "remediation_unavailable";
      await data(db.rpc("federal_identity_finish_job", { p_company: job.company_id, p_lease: job.lease_token, p_cursor: job.cursor ?? {},
        p_receipt: { mode: "historical_remediation", status: "failed", reason }, p_pending: true }));
      receipts.push({ companyId: job.company_id, status: "failed", reason }); break;
    }
  }
  return { status: receipts.some(row => row.status === "failed") ? "failed" : "complete", exhausted, attempted: receipts.length, receipts,
    scope: "Eligible historical weak matches only; unresolved evidence remains unchanged and is receipted." };
}

export async function historicalFederalRepairSnapshot(offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("Invalid repair offset");
  return data(serviceClient().rpc("federal_identity_repair_snapshot", { p_offset: offset }));
}
