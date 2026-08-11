import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { decideIdentityMatch, normalizeName } from "./identity";
import { calculateContractMetrics, deriveContractEvents } from "./metrics";
import { awardUrl, autocompleteRecipients, compactAward, fetchAwardDetail, fetchAwardTransactionsPage, recipientProfileUrl, searchContractAwardsPage, searchReceivedContractSubawards } from "./usaspending";
import { recordPublicGrowthTrigger, saveCompanyGovernmentMatch, saveFederalAward, saveFederalSubaward, saveFederalTransactions, saveGovernmentEntity, stableHash } from "./storage";
import { collectPublicGrowthKeysetPages, matchesFrozenPublicGrowthRecipient, stableIdPageDecision, takeRecurringBatch, type PublicGrowthAwardContinuation } from "./sweepState";
import type { AwardFact, TamIdentity, TransactionFact } from "./types";

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
}

const STORED_METRIC_PAGE_SIZE = 1000;
const STORED_METRIC_MAX_ROWS = 100_000;

export async function loadStoredContractFacts(entityId: string): Promise<{ awards: AwardFact[]; transactions: TransactionFact[]; agencies: string[] }> {
  const db = serviceClient();
  const storedAwards = await collectPublicGrowthKeysetPages<any>(async (afterId, limit) => {
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

/** One bounded search page and one bounded transaction page per invocation. */
export async function sweepUsaspendingCompany(
  company: TamIdentity,
  options: { awardContinuation?: PublicGrowthAwardContinuation } = {},
): Promise<CompanySweepReceipt> {
  const receipt: CompanySweepReceipt = { companyId: company.id, companyName: company.name, status: "no_awards", awards: 0, transactions: 0, triggers: 0 };
  try {
    let state = options.awardContinuation ? structuredClone(options.awardContinuation) : null;
    let currentSearchPage: Awaited<ReturnType<typeof searchContractAwardsPage>> | null = null;
    if (!state) {
      const suggestions = await autocompleteRecipients(company.name, 1);
      const exactNames = [...new Set(suggestions.map((x) => x.recipient_name).filter((name) => normalizeName(name) === normalizeName(company.name)))];
      if (!exactNames.includes(company.name)) exactNames.push(company.name);
      for (const recipientName of exactNames.slice(0, 4)) {
        const candidate = initialAwardContinuation(recipientName);
        const page = await searchContractAwardsPage(recipientName, 1, candidate.searchEndDate, AWARD_SEARCH_PAGE_SIZE);
        if (page.rows.some((row) => normalizeName(row.recipientName) === normalizeName(recipientName))) {
          state = candidate; currentSearchPage = page; break;
        }
      }
      if (!state) { receipt.awardDone = true; return receipt; }
    }
    receipt.awardContinuation = state;

    if (!state.pendingAwardId) {
      const page = currentSearchPage ?? await searchContractAwardsPage(state.recipientName, state.searchPage, state.searchEndDate, AWARD_SEARCH_PAGE_SIZE);
      const exactRows = page.rows.filter((row) => normalizeName(row.recipientName) === normalizeName(state.recipientName));
      const decision = stableIdPageDecision({ page: state.searchPage, passFoundNew: state.searchPassFoundNew, seenIds: state.seenAwardIds, pageIds: exactRows.map((row) => row.generatedId), hasNext: page.hasNext });
      const nextAward = decision.nextId ? exactRows.find((row) => row.generatedId === decision.nextId) : null;
      if (!nextAward) {
        state.searchPage = decision.page;
        state.searchPassFoundNew = decision.passFoundNew;
        if (decision.done) {
          receipt.awardDone = true; delete receipt.awardContinuation;
          if (state.entityId) {
            const stored = await loadStoredContractFacts(state.entityId);
            const metrics = calculateContractMetrics(stored.awards, stored.transactions);
            await saveMetrics(company.id, metrics, stored.agencies);
            for (const event of deriveContractEvents(metrics)) {
              const profile = recipientProfileUrl({ recipientId: state.recipientId, uei: state.uei, name: state.recipientName });
              const eventUrl = `${profile}?signal=${encodeURIComponent(event.type)}&asof=${encodeURIComponent(event.signalDate ?? "unknown")}`;
              if (await recordPublicGrowthTrigger(company.id, event, "USAspending", eventUrl, 1)) receipt.triggers++;
            }
            if (receipt.triggers) await recomputePriority(company.id);
            receipt.status = "matched";
          }
          return receipt;
        }
        receipt.status = state.entityId ? "matched" : "no_awards";
        receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
      }
      state.pendingAwardId = nextAward.generatedId;
      state.transactionPage = 1; state.transactionPassFoundNew = false; state.seenTransactionIds = [];
      state.searchPassFoundNew = true; receipt.awardContinuation = state;
    }

    const pendingAwardId = state.pendingAwardId;
    if (!pendingAwardId) throw new Error("USAspending continuation omitted its pending award");
    const seed = compactAward(await fetchAwardDetail(pendingAwardId, 1));
    if (state.entityId && !matchesFrozenPublicGrowthRecipient(
      { uei: state.uei, recipientId: state.recipientId },
      { uei: seed.recipient.uei, recipientId: seed.recipient.recipientId },
    )) {
      state.seenAwardIds = [...new Set([...state.seenAwardIds, pendingAwardId])];
      state.pendingAwardId = null; state.seenTransactionIds = [];
      receipt.status = "ambiguous"; receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
    }
    const decision = decideIdentityMatch(company, { legalName: seed.recipient.legalName, city: seed.recipient.city, state: seed.recipient.state, uei: seed.recipient.uei });
    const entityId = await saveGovernmentEntity({
      uei: seed.recipient.uei, usaspending_recipient_id: seed.recipient.recipientId, legal_name: seed.recipient.legalName,
      city: seed.recipient.city, state: seed.recipient.state, postal_code: seed.recipient.postalCode, country_code: seed.recipient.countryCode,
      address_line1: seed.recipient.address, parent_uei: seed.recipient.parentUei, parent_name: seed.recipient.parentName,
      source: "USAspending", source_url: awardUrl(seed.generatedAwardId), evidence: { businessCategories: seed.recipient.businessCategories },
    });
    await saveCompanyGovernmentMatch(company.id, entityId, decision);
    if (decision.status !== "verified") {
      state.seenAwardIds = [...new Set([...state.seenAwardIds, pendingAwardId])];
      state.pendingAwardId = null; state.seenTransactionIds = [];
      receipt.status = "ambiguous"; receipt.awardDone = false; receipt.awardContinuation = state; return receipt;
    }

    state.entityId = entityId; state.uei = seed.recipient.uei; state.recipientId = seed.recipient.recipientId;
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

    const transactionPage = await fetchAwardTransactionsPage(seed.generatedAwardId, state.transactionPage);
    const seenTransactions = new Set(state.seenTransactionIds);
    const unseenTransactions = transactionPage.rows.filter((row) => !seenTransactions.has(transactionId(row)));
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
    return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sweepUsaspendingCompanySteps(
  company: TamIdentity,
  options: { awardContinuation?: PublicGrowthAwardContinuation } = {},
  maxSteps = 3,
): Promise<CompanySweepReceipt> {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 3) throw new Error("USAspending step limit must be between 1 and 3");
  let continuation = options.awardContinuation;
  let aggregate: CompanySweepReceipt | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const current = await sweepUsaspendingCompany(company, continuation ? { awardContinuation: continuation } : {});
    aggregate = aggregate
      ? { ...current, awards: aggregate.awards + current.awards, transactions: aggregate.transactions + current.transactions, triggers: aggregate.triggers + current.triggers }
      : current;
    if (current.status === "error" || current.awardDone !== false || !current.awardContinuation) break;
    continuation = current.awardContinuation;
  }
  if (!aggregate) throw new Error("USAspending bounded step runner produced no receipt");
  return aggregate;
}

export async function sweepUsaspendingSubawardsCompany(company: TamIdentity) {
  const receipt = { companyId: company.id, checked: 0, stored: 0, triggers: 0, status: "not_linked", error: undefined as string | undefined };
  try {
    const db = serviceClient();
    const { data: links, error: linksError } = await db.from("company_government_matches").select("government_entity_id,government_entities!inner(legal_name,dba_name)").eq("company_id", company.id).eq("match_status", "verified");
    if (linksError) throw new Error(`subaward verified-link load failed: ${linksError.message}`);
    if (!links?.length) return receipt;
    const entityId = String(links[0].government_entity_id), names = new Set([company.name, ...(links ?? []).flatMap((x: any) => [x.government_entities?.legal_name, x.government_entities?.dba_name])].filter(Boolean).map(String));
    receipt.status = "linked";
    const seen = new Set<string>();
    for (const name of names) for (const row of await searchReceivedContractSubawards(name)) {
      const recipientName = String(row["Sub-Awardee Name"] ?? row["Recipient Name"] ?? row.subawardee_name ?? ""), primeName = String(row["Prime Recipient Name"] ?? "");
      const receivedMatch = normalizeName(recipientName) === normalizeName(name), primeMatch = normalizeName(primeName) === normalizeName(name);
      if (!receivedMatch && !primeMatch) continue;
      const actionDate = String(row["Sub-Award Date"] ?? row["Action Date"] ?? row.action_date ?? "").slice(0, 10), amount = Number(row["Sub-Award Amount"] ?? row.Amount ?? row["Award Amount"] ?? row.subaward_amount ?? 0);
      const description = row["Sub-Award Description"] ?? row.Description ?? row.description ?? null;
      const externalId = String(row["Sub-Award ID"] ?? row.subaward_number ?? row.id ?? stableHash({ recipientName, actionDate, amount, description, prime: row.primeAwardId }).slice(0, 32));
      if (seen.has(externalId)) continue; seen.add(externalId); receipt.checked++;
      const sourceUrl = `https://www.usaspending.gov/search/?hash=contract-subaward&subaward=${encodeURIComponent(externalId)}`;
      await saveFederalSubaward({ externalSubawardId: externalId, primeAwardGeneratedId: row.primeAwardGeneratedId ?? row.primeAwardId, primeGovernmentEntityId: primeMatch ? entityId : null, subawardGovernmentEntityId: receivedMatch ? entityId : null, subawardeeName: recipientName, amount, actionDate: actionDate || null, description, awardingAgency: row.awardingAgency, sourceUrl, evidence: row });
      receipt.stored++;
      const event = { family: "federal_contract", type: receivedMatch ? "federal_subaward" : "federal_prime_subaward_activity", dedupeKey: `usaspending:subaward:${externalId}:${receivedMatch ? "received" : "issued"}`, strength: amount >= 1_000_000 ? 86 : 74, summary: receivedMatch ? `${actionDate ? `${actionDate}: ` : ""}${Math.round(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} federal subcontract obligated to the company${row.awardingAgency ? ` under ${row.awardingAgency}` : ""}.` : `${actionDate ? `${actionDate}: ` : ""}Prime contract issued a ${Math.round(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} subcontract to ${recipientName}, indicating active contract delivery scale.`, signalDate: actionDate || null, metadata: { externalSubawardId: externalId, amount, valueKind: receivedMatch ? "subaward_obligation_received" : "prime_subaward_issued", primeAwardId: row.primeAwardId, agency: row.awardingAgency, actionDate: actionDate || null } };
      if (await recordPublicGrowthTrigger(company.id, event, "USAspending Subawards", sourceUrl, 0.95)) receipt.triggers++;
    }
    const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const { data: subRows, error: subRowsError } = await db.from("federal_subawards").select("prime_government_entity_id,subaward_government_entity_id,subaward_amount").or(`prime_government_entity_id.eq.${entityId},subaward_government_entity_id.eq.${entityId}`).gte("action_date", cutoff);
    if (subRowsError) throw new Error(`subaward metric load failed: ${subRowsError.message}`);
    const primeDollars = (subRows ?? []).filter((x) => x.prime_government_entity_id === entityId).reduce((s, x) => s + Number(x.subaward_amount ?? 0), 0);
    const receivedDollars = (subRows ?? []).filter((x) => x.subaward_government_entity_id === entityId).reduce((s, x) => s + Number(x.subaward_amount ?? 0), 0);
    const { error: metricError } = await db.from("company_contract_metric_snapshots").upsert({ company_id: company.id, as_of_date: new Date().toISOString().slice(0, 10), prime_subaward_dollars_365d: primeDollars, received_subaward_dollars_365d: receivedDollars }, { onConflict: "company_id,as_of_date" });
    if (metricError) throw new Error(`subaward metric upsert failed: ${metricError.message}`);
    if (receipt.triggers) await recomputePriority(company.id);
    return receipt;
  } catch (error) { return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) }; }
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
  for (const company of companies) receipts.push(await sweepUsaspendingCompanySteps(company, options, 3));
  const totals = receipts.reduce((s, r) => ({ matched: s.matched + (r.status === "matched" ? 1 : 0), ambiguous: s.ambiguous + (r.status === "ambiguous" ? 1 : 0), errors: s.errors + (r.status === "error" ? 1 : 0), awards: s.awards + r.awards, transactions: s.transactions + r.transactions, triggers: s.triggers + r.triggers }), { matched: 0, ambiguous: 0, errors: 0, awards: 0, transactions: 0, triggers: 0 });
  return {
    source: "usaspending",
    offset,
    checked: companies.length,
    nextOffset: offset + companies.length,
    done: recurringWindow ? recurringWindow.done : companies.length < limit,
    ...(recurringWindow ? {
      advanceCursor: false,
      cursorPatch: { afterCompanyId: recurringWindow.done ? null : companies.at(-1)?.id ?? null },
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
) {
  const recurring = scope === "verified"
    ? await loadRecurringTamBatch("usaspending-subawards", limit + 1, afterCompanyId)
    : null;
  const recurringWindow = recurring ? takeRecurringBatch(recurring, limit) : null;
  const companies = recurringWindow ? recurringWindow.rows : await loadTamBatch(limit, offset);
  const receipts = [];
  // Most TAM companies have no verified federal identity. Resolve the whole
  // batch in one query so empty companies do not each pay a database round trip.
  const companyIds = companies.map((company) => company.id);
  const { data: verified, error } = companyIds.length
    ? await serviceClient().from("company_government_matches").select("company_id").in("company_id", companyIds).eq("match_status", "verified")
    : { data: [], error: null };
  if (error) throw new Error(`subaward match prefetch failed: ${error.message}`);
  const linked = new Set((verified ?? []).map((row) => String(row.company_id)));
  for (const company of companies) if (linked.has(company.id)) receipts.push(await sweepUsaspendingSubawardsCompany(company));
  return { source: "usaspending-subawards", offset, checked: companies.length, nextOffset: offset + companies.length, done: recurringWindow ? recurringWindow.done : companies.length < limit, ...(recurringWindow ? { advanceCursor: false, cursorPatch: { afterCompanyId: recurringWindow.done ? null : companies.at(-1)?.id ?? null } } : {}), matched: receipts.filter((r) => r.status === "linked").length, errors: receipts.filter((r) => r.status === "error").length, stored: receipts.reduce((s, r) => s + r.stored, 0), triggers: receipts.reduce((s, r) => s + r.triggers, 0), receipts };
}
