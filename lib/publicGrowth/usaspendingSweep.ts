import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { decideIdentityMatch, normalizeName } from "./identity";
import { calculateContractMetrics, deriveContractEvents } from "./metrics";
import { awardUrl, autocompleteRecipients, compactAward, fetchAwardDetail, fetchAwardTransactionsPage, recipientProfileUrl, searchContractAwardsPage, searchReceivedContractSubawardsPage } from "./usaspending";
import { PublicGrowthDeadlineError, requirePublicGrowthTime } from "./http";
import { recordPublicGrowthTrigger, saveCompanyGovernmentMatch, saveFederalAward, saveFederalSubaward, saveFederalTransactions, saveGovernmentEntity, stableHash } from "./storage";
import { collectPublicGrowthKeysetPages, parsePublicGrowthSubawardContinuation, stableIdPageDecision, takeRecurringBatch, type PublicGrowthAwardContinuation, type PublicGrowthSubawardContinuation } from "./sweepState";
import type { AwardFact, TamIdentity, TransactionFact } from "./types";
import { assertFrozenFederalIdentities, federalSearchTargets, loadVerifiedFederalIdentities, matchesFederalIdentifiers,
  targetAcceptsSearchRow, type VerifiedFederalIdentity } from "./federalIdentity";
import { currentSubawardWindow, isSubawardResultWindowError, splitSubawardWindow,
  SUBAWARD_PARTITION_PAGE_BUDGET, SUBAWARD_SEARCH_PAGE_SIZE } from "./subawardPartitions";
import { advanceUsaspendingCursor, isUsaspendingResultWindowError, usaspendingCursorField,
  USASPENDING_LEGACY_PAGE_BUDGET } from "./usaspendingCursor";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompanySweepReceipt {
  companyId: string;
  companyName: string;
  status: "matched" | "no_awards" | "ambiguous" | "error";
  entityId?: string;
  uei?: string | null;
  awards: number;
  transactions: number;
  triggers: number;
  awardDone?: boolean;
  awardContinuation?: PublicGrowthAwardContinuation;
  error?: string;
  requestDiagnostic?: PrimeRequestDiagnostic;
}

type PrimeRequestOperation = "recipient_autocomplete" | "initial_award_search" | "continuation_award_search" | "award_detail" | "award_transactions";
interface PrimeRequestDiagnostic {
  operation: PrimeRequestOperation;
  elapsedMs: number;
  failureClass: "request_timeout" | "rate_limited" | "http_error" | "transport_error" | "invalid_json" | "request_error";
  httpStatus: number | null;
}

class PrimeRequestError extends Error {
  constructor(error: unknown, readonly diagnostic: PrimeRequestDiagnostic) {
    super(error instanceof Error ? error.message : String(error));
    this.name = error instanceof Error ? error.name : "Error";
  }
}

/** Adds fixed-label diagnostics without altering provider attempts or deadlines. */
async function observePrimeRequest<T>(operation: PrimeRequestOperation, request: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await request();
  } catch (error) {
    // The outer worker already treats overall-budget exhaustion as resumable
    // progress. Preserve that exact error object and control flow.
    if (error instanceof PublicGrowthDeadlineError) throw error;
    const name = error instanceof Error ? error.name : "";
    const statusMatch = error instanceof Error ? /^([45]\d\d)(?:\s|:)/.exec(error.message) : null;
    const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
    const failureClass: PrimeRequestDiagnostic["failureClass"] = name === "AbortError" || name === "TimeoutError"
      ? "request_timeout" : httpStatus === 429 ? "rate_limited" : httpStatus != null ? "http_error"
        : name === "SyntaxError" ? "invalid_json" : name === "TypeError" ? "transport_error" : "request_error";
    throw new PrimeRequestError(error, { operation, elapsedMs: Math.max(0, Math.trunc(Date.now() - started)), failureClass, httpStatus });
  }
}

const STORED_METRIC_PAGE_SIZE = 1000;
const STORED_METRIC_MAX_ROWS = 100_000;

export async function loadStoredContractFacts(entityId: string, deadlineMs?: number): Promise<{ awards: AwardFact[]; transactions: TransactionFact[]; agencies: string[] }> {
  const db = serviceClient();
  const storedAwards = await collectPublicGrowthKeysetPages<any>(async (afterId, limit) => {
    requirePublicGrowthTime(deadlineMs);
    let query = db.from("federal_awards")
      .select("id,generated_award_id,start_date,end_date,award_ceiling,current_award_amount,total_obligations,awarding_agency")
      .eq("government_entity_id", entityId)
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw new Error(`stored award metrics load failed: ${error.message}`);
    return data ?? [];
  }, { pageSize: STORED_METRIC_PAGE_SIZE, maxRows: STORED_METRIC_MAX_ROWS });
  const awards: AwardFact[] = storedAwards.map((award: any) => ({ generatedAwardId: String(award.generated_award_id), startDate: award.start_date, endDate: award.end_date, awardCeiling: Number(award.award_ceiling ?? 0), currentAwardAmount: Number(award.current_award_amount ?? 0), totalObligations: Number(award.total_obligations ?? 0), awardingAgency: award.awarding_agency }));
  const transactions: TransactionFact[] = [];
  const ids = storedAwards.map((award: any) => String(award.id));
  const generatedById = new Map(storedAwards.map((award: any) => [String(award.id), String(award.generated_award_id)]));
  for (let start = 0; start < ids.length; start += 100) {
    const awardIds = ids.slice(start, start + 100);
    const rows = await collectPublicGrowthKeysetPages<any>(async (afterId, limit) => {
      requirePublicGrowthTime(deadlineMs);
      let query = db.from("federal_award_transactions")
        .select("id,external_transaction_id,action_date,federal_action_obligation,modification_number,federal_award_id")
        .in("federal_award_id", awardIds)
        .order("id", { ascending: true })
        .limit(limit);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query;
      if (error) throw new Error(`stored transaction metrics load failed: ${error.message}`);
      return data ?? [];
    }, { pageSize: STORED_METRIC_PAGE_SIZE, maxRows: STORED_METRIC_MAX_ROWS });
    transactions.push(...rows.map((transaction: any) => ({ externalTransactionId: String(transaction.external_transaction_id), generatedAwardId: generatedById.get(String(transaction.federal_award_id)) ?? "", actionDate: String(transaction.action_date), obligation: Number(transaction.federal_action_obligation ?? 0), modificationNumber: transaction.modification_number ?? null })));
  }
  return { awards, transactions, agencies: [...new Set(awards.map((award) => award.awardingAgency).filter((agency): agency is string => Boolean(agency)))] };
}

async function saveMetrics(companyId: string, metrics: ReturnType<typeof calculateContractMetrics>, newAgencies: string[]) {
  const db = serviceClient(), asOf = new Date().toISOString().slice(0, 10);
  const { error } = await db.from("company_contract_metric_snapshots").upsert({
    company_id: companyId, as_of_date: asOf,
    obligations_30d: metrics.obligations30d, prior_obligations_30d: metrics.priorObligations30d,
    obligations_90d: metrics.obligations90d, prior_obligations_90d: metrics.priorObligations90d,
    obligations_365d: metrics.obligations365d, prior_obligations_365d: metrics.priorObligations365d,
    ttm_delta: metrics.ttmDelta, ttm_growth_pct: metrics.ttmGrowthPct,
    new_awards_30d: metrics.newAwards30d, new_awards_90d: metrics.newAwards90d, new_awards_365d: metrics.newAwards365d,
    transaction_count_90d: metrics.transactionCount90d, positive_modifications_90d: metrics.positiveModifications90d,
    positive_modification_dollars_90d: metrics.positiveModificationDollars90d, deobligation_dollars_90d: metrics.deobligationDollars90d,
    active_award_count: metrics.activeAwardCount, active_award_ceiling: metrics.activeAwardCeiling,
    active_award_obligations: metrics.activeAwardObligations, agency_count_365d: metrics.agencyCount365d, new_agencies: newAgencies,
    largest_award_ceiling: metrics.largestAwardCeiling, largest_award_obligations: metrics.largestAwardObligations,
    largest_transaction: metrics.largestTransaction, first_award_date: metrics.firstAwardDate, latest_award_date: metrics.latestAwardDate,
    expiring_awards_180d: metrics.expiringAwards180d, metrics,
  }, { onConflict: "company_id,as_of_date" });
  if (error) throw new Error(`contract metrics upsert failed: ${error.message}`);
}

const AWARD_SEARCH_PAGE_SIZE = 100;

function initialAwardContinuation(recipientName: string): PublicGrowthAwardContinuation {
  return {
    version: 1, recipientName,
    searchEndDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
    searchPage: 1, searchPassFoundNew: false, seenAwardIds: [], entityId: null, uei: null, recipientId: null,
    pendingAwardId: null, transactionPage: 1, transactionPassFoundNew: false, seenTransactionIds: [],
  };
}

function transactionId(row: any): string {
  const exact = String(row?.id ?? "").trim();
  return exact || `hash:${stableHash(row)}`;
}

function ignoreAwardForTarget(state: PublicGrowthAwardContinuation, id: string) {
  const ignored = new Set(state.ignoredAwardIds ?? []);
  if (!ignored.has(id) && ignored.size >= 25_000) throw new Error("award identity exclusions reached the supported 25000-ID bound");
  ignored.add(id); state.ignoredAwardIds = [...ignored];
}

/** One bounded search page and one bounded transaction page per invocation. */
export async function sweepUsaspendingCompany(
  company: TamIdentity,
  options: { awardContinuation?: PublicGrowthAwardContinuation; deadlineMs?: number } = {},
): Promise<CompanySweepReceipt> {
  const receipt: CompanySweepReceipt = { companyId: company.id, companyName: company.name, status: "no_awards", awards: 0, transactions: 0, triggers: 0 };
  try {
    let state = options.awardContinuation ? structuredClone(options.awardContinuation) : null;
    if (state) Object.assign(state, usaspendingCursorField(state));
    let currentSearchPage: Awaited<ReturnType<typeof searchContractAwardsPage>> | null = null;
    if (!state) {
      const identities = await loadVerifiedFederalIdentities(company.id);
      let targets = federalSearchTargets(company.name, identities);
      if (!identities.length) {
        const suggestions = await observePrimeRequest("recipient_autocomplete", () => autocompleteRecipients(company.name, 1, options.deadlineMs));
        const names = [...new Set([company.name, ...suggestions.map((x) => x.recipient_name)
          .filter((name) => normalizeName(name) === normalizeName(company.name))])];
        if (names.length > 300) throw new Error("recipient alias set exceeds supported continuation bound");
        targets = names.map((query) => ({ query, identity: null }));
      }
      state = initialAwardContinuation(targets[0].query);
      state.searchTargets = targets; state.searchTargetIndex = 0;
      const identity = targets[0].identity;
      if (identity) { state.entityId = identity.entityId; state.uei = identity.uei; state.recipientId = identity.recipientId; }
      receipt.awardContinuation = state;
      currentSearchPage = await observePrimeRequest("initial_award_search", () => searchContractAwardsPage(state!.recipientName, 1, state!.searchEndDate, AWARD_SEARCH_PAGE_SIZE, options.deadlineMs));
    }
    receipt.awardContinuation = state;
    const target = state.searchTargets?.[state.searchTargetIndex ?? 0];
    if (state.searchTargets) {
      if (!target || target.query !== state.recipientName) throw new Error("federal search target differs from continuation");
      const frozen = state.searchTargets.flatMap((entry) => entry.identity ? [entry.identity] : []);
      if (frozen.length) assertFrozenFederalIdentities(frozen, await loadVerifiedFederalIdentities(company.id));
      if (target.identity && (state.entityId !== target.identity.entityId || state.uei !== target.identity.uei
          || state.recipientId !== target.identity.recipientId)) throw new Error("federal search target binding changed");
    }

    if (!state.pendingAwardId) {
      // Legacy offset cursors can be beyond the provider window. Replay the same
      // frozen scope in sequential mode, retaining completed and excluded IDs.
      if (state.searchAfter === undefined && state.searchPage >= USASPENDING_LEGACY_PAGE_BUDGET) {
        state.searchPage = 1; state.searchPassFoundNew = false; state.searchAfter = null;
        receipt.awardDone = false; return receipt;
      }
      let page: Awaited<ReturnType<typeof searchContractAwardsPage>>;
      try {
        page = currentSearchPage ?? await observePrimeRequest("continuation_award_search", () => state!.searchAfter === undefined
          ? searchContractAwardsPage(state!.recipientName, state!.searchPage, state!.searchEndDate, AWARD_SEARCH_PAGE_SIZE, options.deadlineMs)
          : searchContractAwardsPage(state!.recipientName, state!.searchPage, state!.searchEndDate, AWARD_SEARCH_PAGE_SIZE, options.deadlineMs, state!.searchAfter));
      } catch (error) {
        if (state.searchAfter !== undefined || !isUsaspendingResultWindowError(error)) throw error;
        state.searchPage = 1; state.searchPassFoundNew = false; state.searchAfter = null;
        receipt.awardDone = false; return receipt;
      }
      const exactRows = page.rows.filter((row) => target
        ? targetAcceptsSearchRow(target, row) : normalizeName(row.recipientName) === normalizeName(state.recipientName));
      const decision = stableIdPageDecision({ page: state.searchPage, passFoundNew: state.searchPassFoundNew,
        seenIds: [...state.seenAwardIds, ...(state.ignoredAwardIds ?? [])], pageIds: exactRows.map((row) => row.generatedId), hasNext: page.hasNext });
      const nextAward = decision.nextId ? exactRows.find((row) => row.generatedId === decision.nextId) : null;
      if (!nextAward) {
        // Keep the terminal page's request anchor until metric finalization
        // succeeds; a database failure must replay that exact page, not an
        // unanchored high offset. Alias transitions reset it explicitly below.
        if (!decision.done) advanceUsaspendingCursor(state, page.hasNext, page.nextCursor);
        state.searchPage = decision.page;
        state.searchPassFoundNew = decision.passFoundNew;
        if (decision.done) {
          if (state.searchTargets && (state.searchTargetIndex ?? 0) + 1 < state.searchTargets.length) {
            state.searchTargetIndex = (state.searchTargetIndex ?? 0) + 1;
            const next = state.searchTargets[state.searchTargetIndex];
            state.recipientName = next.query; state.searchPage = 1; state.searchPassFoundNew = false;
            if (state.searchAfter !== undefined) state.searchAfter = null;
            state.ignoredAwardIds = [];
            state.entityId = next.identity?.entityId ?? null; state.uei = next.identity?.uei ?? null; state.recipientId = next.identity?.recipientId ?? null;
            receipt.awardDone = false; return receipt;
          }
          if (state.entityId || state.searchTargets?.some((entry) => entry.identity)) {
            const entityIds = [...new Set([...(state.entityId ? [state.entityId] : []), ...(state.searchTargets ?? []).flatMap((entry) => entry.identity ? [entry.identity.entityId] : [])])];
            const stored = { awards: [] as AwardFact[], transactions: [] as TransactionFact[], agencies: [] as string[] };
            for (const id of entityIds) {
              const facts = await loadStoredContractFacts(id, options.deadlineMs);
              stored.awards.push(...facts.awards); stored.transactions.push(...facts.transactions); stored.agencies.push(...facts.agencies);
            }
            stored.agencies = [...new Set(stored.agencies)];
            const metrics = calculateContractMetrics(stored.awards, stored.transactions);
            requirePublicGrowthTime(options.deadlineMs);
            await saveMetrics(company.id, metrics, stored.agencies);
            for (const event of deriveContractEvents(metrics)) {
              requirePublicGrowthTime(options.deadlineMs);
              const profile = recipientProfileUrl({ recipientId: state.recipientId, uei: state.uei, name: state.recipientName });
              const eventUrl = `${profile}?signal=${encodeURIComponent(event.type)}&asof=${encodeURIComponent(event.signalDate ?? "unknown")}`;
              if (await recordPublicGrowthTrigger(company.id, event, "USAspending", eventUrl, 1)) receipt.triggers++;
            }
            if (receipt.triggers) await recomputePriority(company.id);
            receipt.status = "matched";
          }
          receipt.awardDone = true; delete receipt.awardContinuation;
          return receipt;
        }
        receipt.status = state.entityId ? "matched" : "no_awards";
        receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
      }
      if (state.seenAwardIds.length >= 25_000) throw new Error("award continuation reached the supported 25000-ID bound");
      state.pendingAwardId = nextAward.generatedId;
      state.transactionPage = 1; state.transactionPassFoundNew = false; state.seenTransactionIds = [];
      state.searchPassFoundNew = true; receipt.awardContinuation = state;
    }

    const pendingAwardId = state.pendingAwardId;
    if (!pendingAwardId) throw new Error("USAspending continuation omitted its pending award");
    const seed = compactAward(await observePrimeRequest("award_detail", () => fetchAwardDetail(pendingAwardId, 1, options.deadlineMs)));
    if (seed.generatedAwardId !== pendingAwardId) throw new Error("award detail differs from requested stable ID");
    if (state.entityId && !matchesFederalIdentifiers(
      { uei: state.uei, recipientId: state.recipientId },
      { uei: seed.recipient.uei, recipientId: seed.recipient.recipientId },
    )) {
      ignoreAwardForTarget(state, pendingAwardId);
      state.pendingAwardId = null; state.seenTransactionIds = [];
      receipt.status = "ambiguous"; receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
    }
    const decision = target?.identity ? { status: "verified" as const, method: "verified_identifier", confidence: 1,
      evidence: { verifiedEntityId: target.identity.entityId, matchedIdentifiers: true } }
      : decideIdentityMatch(company, { legalName: seed.recipient.legalName, city: seed.recipient.city, state: seed.recipient.state, uei: seed.recipient.uei });
    const entityId = target?.identity?.entityId ?? await saveGovernmentEntity({
      uei: seed.recipient.uei, usaspending_recipient_id: seed.recipient.recipientId, legal_name: seed.recipient.legalName,
      city: seed.recipient.city, state: seed.recipient.state, postal_code: seed.recipient.postalCode, country_code: seed.recipient.countryCode,
      address_line1: seed.recipient.address, parent_uei: seed.recipient.parentUei, parent_name: seed.recipient.parentName,
      source: "USAspending", source_url: awardUrl(seed.generatedAwardId), evidence: { businessCategories: seed.recipient.businessCategories },
    });
    if (!target?.identity) await saveCompanyGovernmentMatch(company.id, entityId, decision);
    if (decision.status !== "verified") {
      ignoreAwardForTarget(state, pendingAwardId);
      state.pendingAwardId = null; state.seenTransactionIds = [];
      receipt.status = "ambiguous"; receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
    }

    state.entityId = entityId;
    if (!target?.identity) { state.uei = seed.recipient.uei; state.recipientId = seed.recipient.recipientId; }
    if (target && !target.identity) target.identity = { entityId, legalName: seed.recipient.legalName, dbaName: null,
      uei: seed.recipient.uei, recipientId: seed.recipient.recipientId };
    receipt.status = "matched"; receipt.entityId = entityId; receipt.uei = seed.recipient.uei;
    const sourceUrl = awardUrl(seed.generatedAwardId);
    const storedAwardId = await saveFederalAward(entityId, { ...seed, sourceUrl });
    if (seed.naicsCode && seed.businessSizeStatus !== "unknown") {
      const observedOn = String(seed.sourceUpdatedAt ?? seed.startDate ?? new Date().toISOString()).slice(0, 10);
      const sizeSnapshot = { government_entity_id: entityId, naics_code: seed.naicsCode, naics_name: null, is_primary: false, status: seed.businessSizeStatus, has_size_changed: null, has_sba_protest: null, exception_counter: "", source: "USAspending award recipient size", source_url: sourceUrl, observed_on: observedOn, payload_hash: stableHash({ generatedAwardId: seed.generatedAwardId, naics: seed.naicsCode, size: seed.businessSizeStatus }), evidence: { generatedAwardId: seed.generatedAwardId, awardId: seed.awardId, businessCategories: seed.recipient.businessCategories, naics: seed.naicsCode } };
      const { error: sizeError } = await serviceClient().from("entity_naics_size_status_snapshots").upsert(sizeSnapshot, { onConflict: "government_entity_id,naics_code,exception_counter,observed_on" });
      if (sizeError) throw new Error(`USAspending size snapshot failed: ${sizeError.message}`);
      if (seed.businessSizeStatus === "other_than_small") {
        const sizeEvent = { family: "company_size", type: "sba_other_than_small", dedupeKey: `usaspending:size:${seed.recipient.uei ?? entityId}:naics:${seed.naicsCode}:other-than-small`, strength: 82, summary: `As of ${observedOn}, federal award data classifies the recipient as other than small for an award under NAICS ${seed.naicsCode}.`, signalDate: observedOn, metadata: { naics: seed.naicsCode, status: "other_than_small", awardId: seed.awardId, generatedAwardId: seed.generatedAwardId, businessCategories: seed.recipient.businessCategories, asOf: observedOn } };
        if (await recordPublicGrowthTrigger(company.id, sizeEvent, "USAspending / SBA size status", sourceUrl, decision.confidence)) receipt.triggers++;
      }
    }

    const transactionPage = await observePrimeRequest("award_transactions", () => fetchAwardTransactionsPage(seed.generatedAwardId, state!.transactionPage, options.deadlineMs));
    const seenTransactions = new Set(state.seenTransactionIds);
    const unseenTransactions = transactionPage.rows.filter((row) => !seenTransactions.has(transactionId(row)));
    if (new Set([...seenTransactions, ...unseenTransactions.map(transactionId)]).size > 25_000) throw new Error("transaction continuation reached the supported 25000-ID bound");
    receipt.transactions += await saveFederalTransactions(storedAwardId, sourceUrl, unseenTransactions);
    for (const row of transactionPage.rows) seenTransactions.add(transactionId(row));
    state.seenTransactionIds = [...seenTransactions];
    state.transactionPassFoundNew ||= unseenTransactions.length > 0;
    let awardComplete = false;
    if (transactionPage.hasNext) state.transactionPage += 1;
    else if (state.transactionPassFoundNew) { state.transactionPage = 1; state.transactionPassFoundNew = false; }
    else awardComplete = true;

    if (awardComplete) {
      const awardEvent = {
        family: "federal_contract", type: "federal_award", dedupeKey: `usaspending:award:${seed.generatedAwardId}`,
        strength: seed.totalObligations >= 10_000_000 ? 92 : seed.totalObligations >= 1_000_000 ? 84 : 72,
        summary: `${seed.startDate ? `Awarded ${seed.startDate}. ` : ""}${seed.awardingAgency ? `${seed.awardingAgency}: ` : ""}${Math.round(seed.awardCeiling).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} ceiling; ${Math.round(seed.totalObligations).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} obligated — ${seed.description || seed.awardId}`,
        signalDate: seed.startDate, metadata: { awardId: seed.awardId, generatedAwardId: seed.generatedAwardId, ceiling: seed.awardCeiling, obligations: seed.totalObligations, currentAwardAmount: seed.currentAwardAmount, valueKind: "ceiling_vs_obligations", agency: seed.awardingAgency, subagency: seed.awardingSubagency, office: seed.awardingOffice, naics: seed.naicsCode, psc: seed.pscCode, endDate: seed.endDate },
      };
      if (await recordPublicGrowthTrigger(company.id, awardEvent, "USAspending", sourceUrl, decision.confidence)) receipt.triggers++;
      state.seenAwardIds = [...new Set([...state.seenAwardIds, seed.generatedAwardId])];
      state.pendingAwardId = null; state.transactionPage = 1; state.transactionPassFoundNew = false; state.seenTransactionIds = [];
      receipt.awards = 1;
    }
    if (receipt.triggers) await recomputePriority(company.id);
    receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
  } catch (error) {
    if (error instanceof PublicGrowthDeadlineError && receipt.awardContinuation) {
      return { ...receipt, awardDone: false };
    }
    const requestDiagnostic = error instanceof PrimeRequestError ? error.diagnostic : undefined;
    const message = error instanceof Error ? error.message : String(error);
    // lastError already survives in the exact source retry cursor. Append only
    // fixed labels/numbers so saved failures can be classified without exposing
    // source URLs, request bodies, or response text in the diagnostic object.
    const suffix = requestDiagnostic
      ? ` [usaspending_operation=${requestDiagnostic.operation}; elapsed_ms=${requestDiagnostic.elapsedMs}; failure_class=${requestDiagnostic.failureClass}]`
      : "";
    return { ...receipt, status: "error", error: message + suffix, ...(requestDiagnostic ? { requestDiagnostic } : {}) };
  }
}

export async function sweepUsaspendingCompanySteps(
  company: TamIdentity,
  options: { awardContinuation?: PublicGrowthAwardContinuation; deadlineMs?: number } = {},
  maxSteps = 3,
): Promise<CompanySweepReceipt> {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 3) throw new Error("USAspending step limit must be between 1 and 3");
  let continuation = options.awardContinuation;
  let aggregate: CompanySweepReceipt | null = null;
  for (let step = 0; step < maxSteps; step++) {
    if (aggregate && options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
    const current = await sweepUsaspendingCompany(company, { ...(continuation ? { awardContinuation: continuation } : {}), deadlineMs: options.deadlineMs });
    aggregate = aggregate
      ? { ...current, awards: aggregate.awards + current.awards, transactions: aggregate.transactions + current.transactions, triggers: aggregate.triggers + current.triggers }
      : current;
    if (current.status === "error" || current.awardDone !== false || !current.awardContinuation) break;
    continuation = current.awardContinuation;
  }
  if (!aggregate) throw new Error("USAspending bounded step runner produced no receipt");
  return aggregate;
}

export interface SubawardCompanyReceipt {
  companyId: string;
  checked: number;
  stored: number;
  triggers: number;
  status: "not_linked" | "linked" | "error";
  subawardDone: boolean;
  subawardContinuation?: PublicGrowthSubawardContinuation;
  error?: string;
}

const SUBAWARD_ROWS_PER_STEP = 20;

function partitionOrRestartSubaward(state: PublicGrowthSubawardContinuation, reason: "local_page_budget" | "provider_result_window") {
  const window = currentSubawardWindow(state);
  if (window.startDate === window.endDate && state.searchAfter === undefined) {
    // Same-day searches cannot be split. Replay their exact scope using the
    // provider pair; never construct a cursor from display dates or award IDs.
    state.searchPage = 1; state.searchPassFoundNew = false; state.searchAfter = null;
    return;
  }
  splitSubawardWindow(state, reason);
}

function subawardFields(row: any) {
  const recipientName = String(row["Sub-Awardee Name"] ?? row["Recipient Name"] ?? row.subawardee_name ?? "");
  const primeName = String(row["Prime Recipient Name"] ?? "");
  const actionDate = String(row["Sub-Award Date"] ?? row["Action Date"] ?? row.action_date ?? "").slice(0, 10);
  const amount = Number(row["Sub-Award Amount"] ?? row.Amount ?? row["Award Amount"] ?? row.subaward_amount ?? 0);
  const description = row["Sub-Award Description"] ?? row.Description ?? row.description ?? null;
  const externalId = String(row["Sub-Award ID"] ?? row.subaward_number ?? row.id ?? stableHash({ recipientName, actionDate, amount, description, prime: row.primeAwardId }).slice(0, 32));
  return { recipientName, primeName, actionDate, amount, description, externalId };
}

/** At most3 source pages and20 persisted subawards, with a frozen identity. */
export async function sweepUsaspendingSubawardsCompany(
  company: TamIdentity,
  options: { subawardContinuation?: PublicGrowthSubawardContinuation; deadlineMs?: number } = {},
): Promise<SubawardCompanyReceipt> {
  const receipt: SubawardCompanyReceipt = { companyId: company.id, checked: 0, stored: 0, triggers: 0, status: "not_linked", subawardDone: false };
  let state: PublicGrowthSubawardContinuation | undefined;
  try {
    if (options.subawardContinuation) {
      state = parsePublicGrowthSubawardContinuation(options.subawardContinuation);
      receipt.subawardContinuation = state;
      if (state.companyId !== company.id) throw new Error("subaward continuation company identity differs from exact company");
    }
    requirePublicGrowthTime(options.deadlineMs);
    const db = serviceClient();
    const currentIdentities = await loadVerifiedFederalIdentities(company.id);
    const entityIds = currentIdentities.map((identity) => identity.entityId);
    if (!entityIds.length && !state) { receipt.subawardDone = true; return receipt; }
    if (state && !entityIds.includes(state.entityId)) {
      throw new Error("subaward frozen verified government identity is absent, ambiguous, or changed");
    }
    const namesFor = (identity: VerifiedFederalIdentity) => [...new Set([identity.uei, identity.legalName, identity.dbaName]
      .filter((value): value is string => Boolean(value)))];
    if (!state) {
      const names = namesFor(currentIdentities[0]);
      state = parsePublicGrowthSubawardContinuation({ version: 1, companyId: company.id, entityId: entityIds[0], names,
        nameIndex: 0, searchEndDate: new Date().toISOString().slice(0, 10), searchPage: 1,
        searchPassFoundNew: false, seenSubawardIds: [], identities: currentIdentities, identityIndex: 0 });
      receipt.subawardContinuation = state;
    }
    const identities = state.identities ?? currentIdentities.filter((identity) => identity.entityId === state!.entityId);
    assertFrozenFederalIdentities(identities, currentIdentities);
    if (identities.some((identity) => !identity.uei)) throw new Error("subaward verified identity lacks a UEI; identity research required");
    const byUei = new Map(identities.map((identity) => [identity.uei!.toUpperCase(), identity.entityId]));
    if (byUei.size !== identities.length) throw new Error("subaward identities have conflicting UEIs");
    receipt.status = "linked";
    for (let sourceStep = 0; sourceStep < 3 && state.nameIndex < state.names.length && receipt.stored < SUBAWARD_ROWS_PER_STEP; sourceStep++) {
      requirePublicGrowthTime(options.deadlineMs);
      // Old cursors may already be past the local work budget. Replay within
      // smaller date scopes while retaining every previously persisted ID.
      if (state.searchAfter === undefined && state.searchPage > SUBAWARD_PARTITION_PAGE_BUDGET) {
        partitionOrRestartSubaward(state, "local_page_budget");
        continue;
      }
      const name = state.names[state.nameIndex];
      const window = currentSubawardWindow(state);
      let page: Awaited<ReturnType<typeof searchReceivedContractSubawardsPage>>;
      try {
        page = state.searchAfter !== undefined
          ? await searchReceivedContractSubawardsPage(name, state.searchPage, window.endDate, options.deadlineMs, window.startDate, state.searchAfter)
          : state.searchWindows
          ? await searchReceivedContractSubawardsPage(name, state.searchPage, window.endDate, options.deadlineMs, window.startDate)
          : await searchReceivedContractSubawardsPage(name, state.searchPage, state.searchEndDate, options.deadlineMs);
      } catch (error) {
        if (state.searchAfter !== undefined || !isSubawardResultWindowError(error)) throw error;
        partitionOrRestartSubaward(state, "provider_result_window");
        continue;
      }
      const exactRows = page.rows.filter((row) => {
        const fields = subawardFields(row);
        const subUei = String(row["Sub-Recipient UEI"] ?? "").trim().toUpperCase();
        const primeUei = String(row["Prime Award Recipient UEI"] ?? "").trim().toUpperCase();
        if (byUei.has(subUei) || byUei.has(primeUei)) return true;
        if (subUei || primeUei) return false;
        return normalizeName(fields.recipientName) === normalizeName(name) || normalizeName(fields.primeName) === normalizeName(name);
      });
      const seen = new Set(state.seenSubawardIds);
      for (const row of exactRows) {
        const { recipientName, primeName, actionDate, amount, description, externalId } = subawardFields(row);
        if (seen.has(externalId)) continue;
        if (receipt.stored >= SUBAWARD_ROWS_PER_STEP) break;
        if (seen.size >= 25_000) throw new Error("subaward continuation reached its supported25000 stable-ID bound");
        requirePublicGrowthTime(options.deadlineMs);
        const receivedEntity = byUei.get(String(row["Sub-Recipient UEI"] ?? "").trim().toUpperCase());
        const primeEntity = byUei.get(String(row["Prime Award Recipient UEI"] ?? "").trim().toUpperCase());
        // A verified company link does not make another same-named subrecipient ours.
        if (!receivedEntity && !primeEntity) {
          if (!row["Sub-Recipient UEI"] && !row["Prime Award Recipient UEI"]) throw new Error("subaward recipient identifiers missing; row remains unresolved");
          continue;
        }
        const receivedMatch = Boolean(receivedEntity);
        receipt.checked++;
        const sourceUrl = `https://www.usaspending.gov/search/?hash=contract-subaward&subaward=${encodeURIComponent(externalId)}`;
        await saveFederalSubaward({ externalSubawardId: externalId, primeAwardGeneratedId: row.primeAwardGeneratedId ?? row.primeAwardId,
          primeGovernmentEntityId: primeEntity ?? null, subawardGovernmentEntityId: receivedEntity ?? null,
          subawardeeName: recipientName, amount, actionDate: actionDate || null, description, awardingAgency: row.awardingAgency, sourceUrl, evidence: row });
        const event = { family: "federal_contract", type: receivedMatch ? "federal_subaward" : "federal_prime_subaward_activity",
          dedupeKey: `usaspending:subaward:${externalId}:${receivedMatch ? "received" : "issued"}`, strength: amount >= 1_000_000 ? 86 : 74,
          summary: receivedMatch ? `${actionDate ? `${actionDate}: ` : ""}${Math.round(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} federal subcontract obligated to the company${row.awardingAgency ? ` under ${row.awardingAgency}` : ""}.`
            : `${actionDate ? `${actionDate}: ` : ""}Prime contract issued a ${Math.round(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} subcontract to ${recipientName}, indicating active contract delivery scale.`,
          signalDate: actionDate || null, metadata: { externalSubawardId: externalId, amount, valueKind: receivedMatch ? "subaward_obligation_received" : "prime_subaward_issued", primeAwardId: row.primeAwardId, agency: row.awardingAgency, actionDate: actionDate || null } };
        if (await recordPublicGrowthTrigger(company.id, event, "USAspending Subawards", sourceUrl, 0.95)) receipt.triggers++;
        // A failed persistence/trigger step leaves this ID unseen for safe replay.
        seen.add(externalId); state.seenSubawardIds = [...seen]; state.searchPassFoundNew = true; receipt.stored++;
      }
      // A full last budget page is never a completeness claim, even if provider
      // hit-count metadata stops there. Unprocessed page rows recur in a child
      // window; global stable IDs prevent replay from duplicating stored rows.
      if (state.searchAfter === undefined && !page.nextCursor && state.searchPage >= SUBAWARD_PARTITION_PAGE_BUDGET
          && (page.hasNext || (page.sourceResultCount ?? page.rows.length) >= SUBAWARD_SEARCH_PAGE_SIZE)) {
        partitionOrRestartSubaward(state, "local_page_budget");
        continue;
      }
      const decision = stableIdPageDecision({ page: state.searchPage, passFoundNew: state.searchPassFoundNew,
        seenIds: state.seenSubawardIds, pageIds: exactRows.map((row) => subawardFields(row).externalId), hasNext: page.hasNext });
      if (!decision.nextId) advanceUsaspendingCursor(state, page.hasNext, page.nextCursor);
      state.searchPage = decision.page; state.searchPassFoundNew = decision.passFoundNew;
      if (decision.done) {
        if (state.searchWindows && (state.searchWindowIndex ?? 0) + 1 < state.searchWindows.length) {
          state.searchWindowIndex = (state.searchWindowIndex ?? 0) + 1;
          state.searchPage = 1; state.searchPassFoundNew = false;
          if (state.searchAfter !== undefined) state.searchAfter = null;
          continue;
        }
        state.nameIndex++; state.searchPage = 1; state.searchPassFoundNew = false;
        if (state.searchAfter !== undefined) state.searchAfter = null;
        if (state.searchWindows) state.searchWindowIndex = 0;
        if (state.nameIndex === state.names.length && state.identities && (state.identityIndex ?? 0) + 1 < state.identities.length) {
          state.identityIndex = (state.identityIndex ?? 0) + 1;
          const next = state.identities[state.identityIndex]; state.entityId = next.entityId;
          state.names = namesFor(next); state.nameIndex = 0;
        }
      }
    }
    // Light histories and empty aliases finalize in this invocation; only an
    // unfinished stable pass or an exhausted shared budget creates retry debt.
    if (state.nameIndex < state.names.length) {
      if (receipt.triggers) { requirePublicGrowthTime(options.deadlineMs); await recomputePriority(company.id); }
      return receipt;
    }
    const cutoff = new Date(Date.parse(`${state.searchEndDate}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    const metricEntityIds = identities.map((identity) => identity.entityId);
    const subRows = await collectPublicGrowthKeysetPages<any>(async (afterId, limit) => {
      requirePublicGrowthTime(options.deadlineMs);
      let query = db.from("federal_subawards").select("id,prime_government_entity_id,subaward_government_entity_id,subaward_amount")
        .or(`prime_government_entity_id.in.(${metricEntityIds.join(",")}),subaward_government_entity_id.in.(${metricEntityIds.join(",")})`)
        .gte("action_date", cutoff).lte("action_date", state!.searchEndDate).order("id", { ascending: true }).limit(limit);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query;
      if (error) throw new Error(`subaward metric load failed: ${error.message}`);
      return data ?? [];
    }, { pageSize: STORED_METRIC_PAGE_SIZE, maxRows: STORED_METRIC_MAX_ROWS });
    const primeDollars = subRows.filter((row) => metricEntityIds.includes(row.prime_government_entity_id)).reduce((sum, row) => sum + Number(row.subaward_amount ?? 0), 0);
    const receivedDollars = subRows.filter((row) => metricEntityIds.includes(row.subaward_government_entity_id)).reduce((sum, row) => sum + Number(row.subaward_amount ?? 0), 0);
    requirePublicGrowthTime(options.deadlineMs);
    const { error: metricError } = await db.from("company_contract_metric_snapshots").upsert({ company_id: company.id,
      as_of_date: state.searchEndDate, prime_subaward_dollars_365d: primeDollars, received_subaward_dollars_365d: receivedDollars }, { onConflict: "company_id,as_of_date" });
    if (metricError) throw new Error(`subaward metric upsert failed: ${metricError.message}`);
    requirePublicGrowthTime(options.deadlineMs);
    await recomputePriority(company.id);
    receipt.subawardDone = true; delete receipt.subawardContinuation;
    return receipt;
  } catch (error) {
    if (error instanceof PublicGrowthDeadlineError && state) return receipt;
    return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadTamBatch(limit: number, offset: number): Promise<TamIdentity[]> {
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("id,name,domain,website_raw,city,state")
    .contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam")
    .order("id", { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw new Error(`TAM batch load failed: ${error.message}`);
  return (data ?? []) as TamIdentity[];
}

/** Exact-ID retry loader. Missing/removed companies are deliberately omitted so
 * the caller can resolve their queue entries as no longer current. */
export async function loadTamCompaniesByIds(companyIds: string[]): Promise<TamIdentity[]> {
  if (!companyIds.length) return [];
  const uniqueIds = [...new Set(companyIds)];
  if (uniqueIds.length !== companyIds.length || uniqueIds.length > 10) {
    throw new Error("exact public-growth retry load requires 1-10 unique company IDs");
  }
  const { data, error } = await serviceClient().from("companies")
    .select("id,name,domain,website_raw,city,state")
    .in("id", uniqueIds)
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam");
  if (error) throw new Error(`exact public-growth retry load failed: ${error.message}`);
  const byId = new Map(((data ?? []) as TamIdentity[]).map((row) => [row.id, row]));
  return uniqueIds.flatMap((id) => {
    const company = byId.get(id);
    return company ? [company] : [];
  });
}

export type RecurringPublicGrowthCompanySource = "usaspending" | "usaspending-subawards" | "sam-entity";
export type PublicGrowthCompanyScope = "tam" | "verified";

/**
 * Recurring source checks operate on the exact identities established by the
 * foundation ingest. The service-role RPC owns the stable eligible-set query;
 * explicit-offset recovery calls can still use the complete TAM via loadTamBatch.
 */
export async function loadRecurringTamBatch(
  source: RecurringPublicGrowthCompanySource,
  limit: number,
  afterCompanyId: string | null,
): Promise<TamIdentity[]> {
  const { data, error } = await serviceClient().rpc("list_public_growth_recurring_tam_batch_v2", {
    p_source: source,
    p_limit: limit,
    p_after_company_id: afterCompanyId,
  });
  if (error) throw new Error(`recurring ${source} TAM batch load failed: ${error.message}`);
  return (data ?? []) as TamIdentity[];
}

export interface UsaspendingBatchOptions {
  awardContinuation?: PublicGrowthAwardContinuation;
  scope?: PublicGrowthCompanyScope;
  afterCompanyId?: string | null;
  deadlineMs?: number;
}

export async function sweepUsaspendingTamBatch(limit: number, offset: number, options: UsaspendingBatchOptions = {}) {
  const recurring = options.scope === "verified"
    ? await loadRecurringTamBatch("usaspending", limit + 1, options.afterCompanyId ?? null)
    : null;
  const recurringWindow = recurring ? takeRecurringBatch(recurring, limit) : null;
  const companies = recurringWindow ? recurringWindow.rows : await loadTamBatch(limit, offset);
  const receipts: CompanySweepReceipt[] = [];
  // Deliberately serial: each company can fan out to award and transaction calls;
  // bounded execution and clean checkpointing are more valuable than burst speed.
  const attempted: TamIdentity[] = [];
  for (const company of companies) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
    receipts.push(await sweepUsaspendingCompanySteps(company, options, 3));
    attempted.push(company);
  }
  const done = attempted.length === companies.length && (recurringWindow ? recurringWindow.done : companies.length < limit);
  const totals = receipts.reduce((s, r) => ({ matched: s.matched + (r.status === "matched" ? 1 : 0), ambiguous: s.ambiguous + (r.status === "ambiguous" ? 1 : 0), errors: s.errors + (r.status === "error" ? 1 : 0), awards: s.awards + r.awards, transactions: s.transactions + r.transactions, triggers: s.triggers + r.triggers }), { matched: 0, ambiguous: 0, errors: 0, awards: 0, transactions: 0, triggers: 0 });
  return {
    source: "usaspending",
    offset,
    checked: attempted.length,
    nextOffset: offset + attempted.length,
    done,
    ...(recurringWindow ? {
      advanceCursor: false,
      cursorPatch: { afterCompanyId: done ? null : attempted.at(-1)?.id ?? options.afterCompanyId ?? null },
    } : {}),
    ...totals,
    receipts,
  };
}

export async function sweepUsaspendingSubawardsTamBatch(
  limit: number,
  offset: number,
  scope: PublicGrowthCompanyScope = "tam",
  afterCompanyId: string | null = null,
  options: { deadlineMs?: number } = {},
) {
  const recurring = scope === "verified"
    ? await loadRecurringTamBatch("usaspending-subawards", limit + 1, afterCompanyId)
    : null;
  const recurringWindow = recurring ? takeRecurringBatch(recurring, limit) : null;
  const companies = recurringWindow ? recurringWindow.rows : await loadTamBatch(limit, offset);
  const receipts: SubawardCompanyReceipt[] = [];
  // Most TAM companies have no verified federal identity. Resolve the whole
  // batch in one query so empty companies do not each pay a database round trip.
  const companyIds = companies.map((company) => company.id);
  const { data: verified, error } = companyIds.length
    ? await serviceClient().from("company_government_matches").select("company_id").in("company_id", companyIds).eq("match_status", "verified")
    : { data: [], error: null };
  if (error) throw new Error(`subaward match prefetch failed: ${error.message}`);
  const linked = new Set((verified ?? []).map((row) => String(row.company_id)));
  const attempted: TamIdentity[] = [];
  for (const company of companies) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) break;
    if (linked.has(company.id)) receipts.push(await sweepUsaspendingSubawardsCompany(company, options));
    attempted.push(company);
  }
  const done = attempted.length === companies.length && (recurringWindow ? recurringWindow.done : companies.length < limit);
  return { source: "usaspending-subawards", offset, checked: attempted.length, nextOffset: offset + attempted.length, done,
    ...(recurringWindow ? { advanceCursor: false, cursorPatch: { afterCompanyId: done ? null : attempted.at(-1)?.id ?? afterCompanyId } } : {}),
    matched: receipts.filter((r) => r.status === "linked").length, errors: receipts.filter((r) => r.status === "error").length,
    stored: receipts.reduce((sum, receipt) => sum + receipt.stored, 0), triggers: receipts.reduce((sum, receipt) => sum + receipt.triggers, 0), receipts };
}
