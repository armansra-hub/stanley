import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { decideIdentityMatch, normalizeName } from "./identity";
import { calculateContractMetrics, deriveContractEvents } from "./metrics";
import { awardUrl, autocompleteRecipients, compactAward, fetchAwardDetail, fetchAwardTransactions, searchContractAwards, searchReceivedContractSubawards } from "./usaspending";
import { recordPublicGrowthTrigger, saveCompanyGovernmentMatch, saveFederalAward, saveFederalSubaward, saveFederalTransactions, saveGovernmentEntity, stableHash } from "./storage";
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
  error?: string;
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

export async function sweepUsaspendingCompany(company: TamIdentity): Promise<CompanySweepReceipt> {
  const receipt: CompanySweepReceipt = { companyId: company.id, companyName: company.name, status: "no_awards", awards: 0, transactions: 0, triggers: 0 };
  try {
    const suggestions = await autocompleteRecipients(company.name);
    const exactNames = [...new Set(suggestions.map((x) => x.recipient_name).filter((name) => normalizeName(name) === normalizeName(company.name)))];
    if (!exactNames.length) exactNames.push(company.name);

    for (const recipientName of exactNames.slice(0, 4)) {
      const searchRows = (await searchContractAwards(recipientName)).filter((row) => normalizeName(row.recipientName) === normalizeName(recipientName));
      if (!searchRows.length) continue;
      const seed = compactAward(await fetchAwardDetail(searchRows[0].generatedId));
      const decision = decideIdentityMatch(company, { legalName: seed.recipient.legalName, city: seed.recipient.city, state: seed.recipient.state, uei: seed.recipient.uei });
      const entityId = await saveGovernmentEntity({
        uei: seed.recipient.uei, usaspending_recipient_id: seed.recipient.recipientId, legal_name: seed.recipient.legalName,
        city: seed.recipient.city, state: seed.recipient.state, postal_code: seed.recipient.postalCode, country_code: seed.recipient.countryCode,
        address_line1: seed.recipient.address, parent_uei: seed.recipient.parentUei, parent_name: seed.recipient.parentName,
        source: "USAspending", source_url: awardUrl(seed.generatedAwardId), evidence: { businessCategories: seed.recipient.businessCategories },
      });
      await saveCompanyGovernmentMatch(company.id, entityId, decision);
      if (decision.status !== "verified") { receipt.status = "ambiguous"; continue; }

      receipt.status = "matched"; receipt.entityId = entityId; receipt.uei = seed.recipient.uei;
      const awardFacts: AwardFact[] = [], transactionFacts: TransactionFact[] = [];
      const agencies = new Set<string>();
      for (const row of searchRows) {
        const detail = row.generatedId === seed.generatedAwardId ? seed : compactAward(await fetchAwardDetail(row.generatedId));
        if (seed.recipient.uei && detail.recipient.uei && seed.recipient.uei !== detail.recipient.uei) continue;
        const sourceUrl = awardUrl(detail.generatedAwardId);
        const storedAwardId = await saveFederalAward(entityId, { ...detail, sourceUrl });
        if (detail.naicsCode && detail.businessSizeStatus !== "unknown") {
          const observedOn = String(detail.sourceUpdatedAt ?? detail.startDate ?? new Date().toISOString()).slice(0, 10);
          const sizeSnapshot = { government_entity_id: entityId, naics_code: detail.naicsCode, naics_name: null, is_primary: false, status: detail.businessSizeStatus, has_size_changed: null, has_sba_protest: null, exception_counter: "", source: "USAspending award recipient size", source_url: sourceUrl, observed_on: observedOn, payload_hash: stableHash({ generatedAwardId: detail.generatedAwardId, naics: detail.naicsCode, size: detail.businessSizeStatus }), evidence: { generatedAwardId: detail.generatedAwardId, awardId: detail.awardId, businessCategories: detail.recipient.businessCategories, naics: detail.naicsCode } };
          const { error: sizeError } = await serviceClient().from("entity_naics_size_status_snapshots").upsert(sizeSnapshot, { onConflict: "government_entity_id,naics_code,exception_counter,observed_on" });
          if (sizeError) throw new Error(`USAspending size snapshot failed: ${sizeError.message}`);
          if (detail.businessSizeStatus === "other_than_small") {
            const sizeEvent = { family: "company_size", type: "sba_other_than_small", dedupeKey: `usaspending:size:${seed.recipient.uei ?? entityId}:naics:${detail.naicsCode}:other-than-small`, strength: 82, summary: `As of ${observedOn}, federal award data classifies the recipient as other than small for an award under NAICS ${detail.naicsCode}.`, signalDate: observedOn, metadata: { naics: detail.naicsCode, status: "other_than_small", awardId: detail.awardId, generatedAwardId: detail.generatedAwardId, businessCategories: detail.recipient.businessCategories, asOf: observedOn } };
            if (await recordPublicGrowthTrigger(company.id, sizeEvent, "USAspending / SBA size status", sourceUrl, decision.confidence)) receipt.triggers++;
          }
        }
        const transactions = await fetchAwardTransactions(detail.generatedAwardId);
        receipt.transactions += await saveFederalTransactions(storedAwardId, sourceUrl, transactions);
        receipt.awards++;
        if (detail.awardingAgency) agencies.add(detail.awardingAgency);
        awardFacts.push({ generatedAwardId: detail.generatedAwardId, startDate: detail.startDate, endDate: detail.endDate, awardCeiling: detail.awardCeiling, currentAwardAmount: detail.currentAwardAmount, totalObligations: detail.totalObligations, awardingAgency: detail.awardingAgency });
        transactionFacts.push(...transactions.map((t: any) => ({ externalTransactionId: String(t.id), generatedAwardId: detail.generatedAwardId, actionDate: String(t.action_date), obligation: Number(t.federal_action_obligation ?? 0), modificationNumber: t.modification_number ?? null })));

        const awardEvent = {
          family: "federal_contract", type: "federal_award", dedupeKey: `usaspending:award:${detail.generatedAwardId}`,
          strength: detail.totalObligations >= 10_000_000 ? 92 : detail.totalObligations >= 1_000_000 ? 84 : 72,
          summary: `${detail.startDate ? `Awarded ${detail.startDate}. ` : ""}${detail.awardingAgency ? `${detail.awardingAgency}: ` : ""}${Math.round(detail.awardCeiling).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} ceiling; ${Math.round(detail.totalObligations).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} obligated — ${detail.description || detail.awardId}`,
          signalDate: detail.startDate, metadata: { awardId: detail.awardId, generatedAwardId: detail.generatedAwardId, ceiling: detail.awardCeiling, obligations: detail.totalObligations, currentAwardAmount: detail.currentAwardAmount, valueKind: "ceiling_vs_obligations", agency: detail.awardingAgency, subagency: detail.awardingSubagency, office: detail.awardingOffice, naics: detail.naicsCode, psc: detail.pscCode, endDate: detail.endDate },
        };
        if (await recordPublicGrowthTrigger(company.id, awardEvent, "USAspending", sourceUrl, decision.confidence)) receipt.triggers++;
      }
      const metrics = calculateContractMetrics(awardFacts, transactionFacts);
      await saveMetrics(company.id, metrics, [...agencies]);
      for (const event of deriveContractEvents(metrics)) {
        const profile = `https://www.usaspending.gov/recipient/${encodeURIComponent(seed.recipient.recipientId ?? seed.recipient.uei ?? seed.recipient.legalName)}`;
        const eventUrl = `${profile}?signal=${encodeURIComponent(event.type)}&asof=${encodeURIComponent(event.signalDate ?? "unknown")}`;
        if (await recordPublicGrowthTrigger(company.id, event, "USAspending", eventUrl, decision.confidence)) receipt.triggers++;
      }
      if (receipt.triggers) await recomputePriority(company.id);
      return receipt;
    }
    return receipt;
  } catch (error) {
    return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sweepUsaspendingSubawardsCompany(company: TamIdentity) {
  const receipt = { companyId: company.id, checked: 0, stored: 0, triggers: 0, status: "not_linked", error: undefined as string | undefined };
  try {
    const db = serviceClient();
    const { data: links } = await db.from("company_government_matches").select("government_entity_id,government_entities!inner(legal_name,dba_name)").eq("company_id", company.id).eq("match_status", "verified");
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
    const { data: subRows } = await db.from("federal_subawards").select("prime_government_entity_id,subaward_government_entity_id,subaward_amount").or(`prime_government_entity_id.eq.${entityId},subaward_government_entity_id.eq.${entityId}`).gte("action_date", cutoff);
    const primeDollars = (subRows ?? []).filter((x) => x.prime_government_entity_id === entityId).reduce((s, x) => s + Number(x.subaward_amount ?? 0), 0);
    const receivedDollars = (subRows ?? []).filter((x) => x.subaward_government_entity_id === entityId).reduce((s, x) => s + Number(x.subaward_amount ?? 0), 0);
    await db.from("company_contract_metric_snapshots").upsert({ company_id: company.id, as_of_date: new Date().toISOString().slice(0, 10), prime_subaward_dollars_365d: primeDollars, received_subaward_dollars_365d: receivedDollars }, { onConflict: "company_id,as_of_date" });
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

export async function sweepUsaspendingTamBatch(limit: number, offset: number) {
  const companies = await loadTamBatch(limit, offset), receipts: CompanySweepReceipt[] = [];
  // Deliberately serial: each company can fan out to award and transaction calls;
  // bounded execution and clean checkpointing are more valuable than burst speed.
  for (const company of companies) receipts.push(await sweepUsaspendingCompany(company));
  const totals = receipts.reduce((s, r) => ({ matched: s.matched + (r.status === "matched" ? 1 : 0), ambiguous: s.ambiguous + (r.status === "ambiguous" ? 1 : 0), errors: s.errors + (r.status === "error" ? 1 : 0), awards: s.awards + r.awards, transactions: s.transactions + r.transactions, triggers: s.triggers + r.triggers }), { matched: 0, ambiguous: 0, errors: 0, awards: 0, transactions: 0, triggers: 0 });
  return { source: "usaspending", offset, checked: companies.length, nextOffset: offset + companies.length, done: companies.length < limit, ...totals, receipts };
}

export async function sweepUsaspendingSubawardsTamBatch(limit: number, offset: number) {
  const companies = await loadTamBatch(limit, offset), receipts = [];
  // Most TAM companies have no verified federal identity. Resolve the whole
  // batch in one query so empty companies do not each pay a database round trip.
  const companyIds = companies.map((company) => company.id);
  const { data: verified, error } = companyIds.length
    ? await serviceClient().from("company_government_matches").select("company_id").in("company_id", companyIds).eq("match_status", "verified")
    : { data: [], error: null };
  if (error) throw new Error(`subaward match prefetch failed: ${error.message}`);
  const linked = new Set((verified ?? []).map((row) => String(row.company_id)));
  for (const company of companies) if (linked.has(company.id)) receipts.push(await sweepUsaspendingSubawardsCompany(company));
  return { source: "usaspending-subawards", offset, checked: companies.length, nextOffset: offset + companies.length, done: companies.length < limit, matched: receipts.filter((r) => r.status === "linked").length, errors: receipts.filter((r) => r.status === "error").length, stored: receipts.reduce((s, r) => s + r.stored, 0), triggers: receipts.reduce((s, r) => s + r.triggers, 0), receipts };
}
