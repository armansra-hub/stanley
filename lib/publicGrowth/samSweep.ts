import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { decideIdentityMatch, normalizeName } from "./identity";
import { compactSamEntity, sbaProfileUrl, searchSamEntitiesPage } from "./sam";
import { recordPublicGrowthTriggersBulk, saveCompanyGovernmentMatch, saveGovernmentEntity, stableHash } from "./storage";
import { loadRecurringTamBatch, loadTamBatch, type PublicGrowthCompanyScope } from "./usaspendingSweep";
import { takeRecurringBatch } from "./sweepState";
import { parseSamEntityContinuation, samBindingMatches, type SamEntityContinuation, type SamEntityTarget } from "./samEntityState";
import { PublicGrowthDeadlineError, requirePublicGrowthTime } from "./http";
import type { DerivedGrowthEvent, TamIdentity } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function statusValue(value: unknown): "small" | "other_than_small" | "unknown" {
  if (value === true || /^(y|yes|true|1)$/i.test(String(value))) return "small";
  if (value === false || /^(n|no|false|0)$/i.test(String(value))) return "other_than_small";
  return "unknown";
}

export async function saveNaicsAndDerive(entityId: string, companyId: string, sam: ReturnType<typeof compactSamEntity>): Promise<number> {
  const db = serviceClient(), observedOn = new Date().toISOString().slice(0, 10), profileUrl = sbaProfileUrl(sam.uei, sam.cageCode);
  if (!sam.naics.length) return 0;
  const snapshots = sam.naics.map((n: any) => ({
    government_entity_id: entityId, naics_code: n.code, naics_name: n.name,
    is_primary: n.isPrimary, status: statusValue(n.isSmallBusiness),
    has_size_changed: n.hasSizeChanged ?? null, has_sba_protest: n.hasSbaProtest ?? null,
    exception_counter: n.exceptionCounter, source: "SAM.gov / SBA", source_url: profileUrl,
    observed_on: observedOn, payload_hash: stableHash(n), evidence: n,
  }));
  const { error } = await db.from("entity_naics_size_status_snapshots")
    .upsert(snapshots, { onConflict: "government_entity_id,naics_code,exception_counter,observed_on" });
  if (error) throw new Error(`NAICS size snapshot bulk upsert failed: ${error.message}`);

  const statusDate = sam.lastUpdateDate?.slice?.(0, 10) ?? observedOn;
  const events: Array<{ companyId: string; event: DerivedGrowthEvent; sourceName: string; sourceUrl: string; confidence: number }> = [];
  for (const n of sam.naics) {
    const status = statusValue(n.isSmallBusiness);
    if (status === "other_than_small") events.push({
      companyId, sourceName: "SAM.gov / SBA Small Business Search", confidence: 1,
      sourceUrl: `${profileUrl}?signal=sba_other_than_small&naics=${encodeURIComponent(n.code)}`,
      event: { family: "company_size", type: "sba_other_than_small", dedupeKey: `sam:${sam.uei}:naics:${n.code}:${n.exceptionCounter}:other-than-small`, strength: n.isPrimary ? 84 : 76, summary: `As of ${statusDate}, classified other than small for ${n.code}${n.name ? ` ${n.name}` : ""}${n.isPrimary ? " (primary NAICS)" : ""}.`, signalDate: statusDate, metadata: { naics: n.code, naicsName: n.name, isPrimary: n.isPrimary, status, hasSizeChanged: n.hasSizeChanged, hasSbaProtest: n.hasSbaProtest, asOf: statusDate } },
    });
    if (n.hasSizeChanged) events.push({
      companyId, sourceName: "SAM.gov / SBA Small Business Search", confidence: 1,
      sourceUrl: `${profileUrl}?signal=sba_size_changed&naics=${encodeURIComponent(n.code)}`,
      event: { family: "company_size", type: "sba_size_changed", dedupeKey: `sam:${sam.uei}:naics:${n.code}:${n.exceptionCounter}:size-changed`, strength: 82, summary: `As of ${statusDate}, SAM reports a size-status change for NAICS ${n.code}${n.name ? ` ${n.name}` : ""}.`, signalDate: statusDate, metadata: { naics: n.code, naicsName: n.name, isPrimary: n.isPrimary, status, hasSizeChanged: true, asOf: statusDate } },
    });
  }
  return recordPublicGrowthTriggersBulk(events);
}

export type SamExtractObservationInput = {
  companyId: string;
  matchMethod?: "uei" | "cage" | "domain" | "name";
  sam: ReturnType<typeof compactSamEntity>;
};

export async function ingestSamExtractObservations(rows: SamExtractObservationInput[]) {
  const db = serviceClient();
  const companyIds = [...new Set(rows.map((row) => row.companyId))];
  const { data: companies, error } = await db.from("companies")
    .select("id,name,city,state,domain,website_raw")
    .in("id", companyIds)
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam");
  if (error) throw new Error(`SAM extract TAM load failed: ${error.message}`);
  const byId = new Map((companies ?? []).map((company: TamIdentity) => [company.id, company]));
  const receipts = await Promise.all(rows.map(async (row) => {
    const company = byId.get(row.companyId);
    if (!company) {
      return { companyId: row.companyId, status: "not_in_tam", entities: 0, naics: 0, triggers: 0 };
    }
    try {
      const sam = row.sam;
      const deterministic = decideIdentityMatch(company, {
        legalName: sam.legalName, dbaName: sam.dbaName, domain: sam.domain,
        city: sam.city, state: sam.state, uei: sam.uei, cageCode: sam.cageCode,
      });
      const decision = row.matchMethod === "uei" || row.matchMethod === "cage"
        ? { status: "verified" as const, method: row.matchMethod, confidence: 1, evidence: { ...deterministic.evidence, identifierMatch: row.matchMethod } }
        : deterministic;
      const entityId = await saveGovernmentEntity({
        uei: sam.uei, cage_code: sam.cageCode, legal_name: sam.legalName,
        dba_name: sam.dbaName, website: sam.website, domain: sam.domain,
        address_line1: sam.address, city: sam.city, state: sam.state,
        postal_code: sam.postalCode, country_code: sam.countryCode,
        registration_status: sam.registrationStatus, registration_date: sam.registrationDate,
        expiration_date: sam.expirationDate, entity_start_date: sam.entityStartDate,
        parent_uei: sam.parentUei, parent_name: sam.parentName, source: "SAM.gov public monthly extract",
        source_url: `https://sam.gov/entity/${encodeURIComponent(sam.uei ?? sam.cageCode ?? sam.legalName)}/coreData`,
        source_updated_at: sam.lastUpdateDate, evidence: { psc: sam.psc, businessTypes: sam.businessTypes, extract: true },
      });
      await saveCompanyGovernmentMatch(company.id, entityId, decision);
      const triggers = decision.status === "verified" ? await saveNaicsAndDerive(entityId, company.id, sam) : 0;
      if (triggers) await recomputePriority(company.id);
      return { companyId: company.id, status: decision.status, entities: 1, naics: decision.status === "verified" ? sam.naics.length : 0, triggers };
    } catch (ingestError) {
      return { companyId: row.companyId, status: "error", entities: 0, naics: 0, triggers: 0, error: ingestError instanceof Error ? ingestError.message : String(ingestError) };
    }
  }));
  return {
    checked: rows.length,
    matched: receipts.filter((row) => row.status === "verified").length,
    ambiguous: receipts.filter((row) => row.status === "pending").length,
    errors: receipts.filter((row) => row.status === "error").length,
    entities: receipts.reduce((sum, row) => sum + row.entities, 0),
    naics: receipts.reduce((sum, row) => sum + row.naics, 0),
    triggers: receipts.reduce((sum, row) => sum + row.triggers, 0),
    receipts,
  };
}

export async function sweepSamCompany(company: TamIdentity, options: { samContinuation?: SamEntityContinuation; deadlineMs?: number } = {}) {
  const receipt = { companyId: company.id, companyName: company.name, status: "not_found", entities: 0, naics: 0, triggers: 0,
    error: undefined as string | undefined, samDone: false, samContinuation: undefined as SamEntityContinuation | undefined };
  try {
    requirePublicGrowthTime(options.deadlineMs);
    const db = serviceClient();
    const { data: linked, error: linkedError } = await db.from("company_government_matches")
      .select("government_entity_id,government_entities(uei,cage_code)").eq("company_id", company.id).eq("match_status", "verified").limit(101);
    if (linkedError || !Array.isArray(linked) || linked.length > 100) throw new Error("SAM verified-link load failed or exceeded supported scope");
    const bindings = linked.map((row: any) => ({ entityId: String(row.government_entity_id),
      uei: row.government_entities?.uei ?? null, cageCode: row.government_entities?.cage_code ?? null }));
    let state = options.samContinuation ? parseSamEntityContinuation(options.samContinuation, company.id) : null;
    if (!state) {
      const targets: SamEntityTarget[] = bindings.flatMap((binding) => [
        ...(binding.uei ? [{ query: { uei: binding.uei }, binding }] : []),
        ...(binding.cageCode ? [{ query: { cageCode: binding.cageCode }, binding }] : []),
      ]);
      // Retrieve additional legitimate recipients even after one is bound.
      targets.push({ query: { legalBusinessName: company.name } }, { query: { dbaName: company.name } });
      state = parseSamEntityContinuation({ version: 1, companyId: company.id, targets, targetIndex: 0, page: 0, lastPageHash: null }, company.id);
    }
    receipt.samContinuation = state;
    for (const target of state.targets) {
      if (target.binding) {
        const current = bindings.find((binding) => binding.entityId === target.binding!.entityId);
        if (!current || target.binding.uei && current.uei !== target.binding.uei || target.binding.cageCode && current.cageCode !== target.binding.cageCode) throw new Error("frozen SAM entity binding changed");
      } else if (normalizeName(target.query.legalBusinessName ?? target.query.dbaName ?? "") !== normalizeName(company.name)) throw new Error("frozen SAM company name changed");
    }
    const target = state.targets[state.targetIndex];
    const page = await searchSamEntitiesPage(target.query, state.page, options.deadlineMs);
    const hash = stableHash(page.rows);
    if (page.hasNext && (!page.rows.length || hash === state.lastPageHash)) throw new Error("SAM entity pagination did not advance");
    for (const row of page.rows) {
      requirePublicGrowthTime(options.deadlineMs);
      const sam = compactSamEntity(row);
      if (!sam.legalName || (!sam.uei && !sam.cageCode)) continue;
      if (target.binding && !samBindingMatches(target.binding, sam)) throw new Error("SAM source identifiers conflict with verified binding");
      if (!target.binding && normalizeName(sam.legalName) !== normalizeName(company.name) && normalizeName(sam.dbaName) !== normalizeName(company.name)) continue;
      const existingBinding = target.binding ?? bindings.find((binding) => samBindingMatches(binding, sam));
      const decision = existingBinding ? { status: "verified" as const, method: "verified_identifier", confidence: 1,
        evidence: { verifiedEntityId: existingBinding.entityId, uei: sam.uei, cageCode: sam.cageCode } }
        : decideIdentityMatch(company, { legalName: sam.legalName, dbaName: sam.dbaName, domain: sam.domain, city: sam.city, state: sam.state, uei: sam.uei, cageCode: sam.cageCode });
      const entityId = await saveGovernmentEntity({ uei: sam.uei, cage_code: sam.cageCode, legal_name: sam.legalName, dba_name: sam.dbaName, website: sam.website, domain: sam.domain, address_line1: sam.address, city: sam.city, state: sam.state, postal_code: sam.postalCode, country_code: sam.countryCode, registration_status: sam.registrationStatus, registration_date: sam.registrationDate, expiration_date: sam.expirationDate, entity_start_date: sam.entityStartDate, parent_uei: sam.parentUei, parent_name: sam.parentName, source: "SAM.gov", source_url: `https://sam.gov/entity/${encodeURIComponent(sam.uei ?? sam.cageCode ?? sam.legalName)}/coreData`, source_updated_at: sam.lastUpdateDate, evidence: { psc: sam.psc, businessTypes: sam.businessTypes } });
      if (existingBinding && entityId !== existingBinding.entityId) throw new Error("SAM entity storage binding changed");
      if (!existingBinding) await saveCompanyGovernmentMatch(company.id, entityId, decision);
      receipt.entities++;
      if (decision.status !== "verified") { receipt.status = "ambiguous"; continue; }
      receipt.status = "matched"; receipt.naics += sam.naics.length; receipt.triggers += await saveNaicsAndDerive(entityId, company.id, sam);
    }
    if (receipt.triggers) await recomputePriority(company.id);
    // Commit only after all entity and NAICS writes on the page succeeded.
    if (page.hasNext) {
      if (state.page >= 999) throw new Error("SAM source result window requires a narrower query");
      state.page++; state.lastPageHash = hash;
    } else if (state.targetIndex + 1 < state.targets.length) {
      state.targetIndex++; state.page = 0; state.lastPageHash = null;
    } else { receipt.samDone = true; receipt.samContinuation = undefined; }
    return receipt;
  } catch (error) {
    if (error instanceof PublicGrowthDeadlineError && receipt.samContinuation) return receipt;
    return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sweepSamTamBatch(
  limit: number,
  offset: number,
  scope: PublicGrowthCompanyScope = "tam",
  afterCompanyId: string | null = null,
  deadlineMs?: number,
) {
  const recurring = scope === "verified"
    ? await loadRecurringTamBatch("sam-entity", limit + 1, afterCompanyId)
    : null;
  const recurringWindow = recurring ? takeRecurringBatch(recurring, limit) : null;
  const companies = recurringWindow ? recurringWindow.rows : await loadTamBatch(limit, offset);
  const receipts = [];
  for (const company of companies) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) break;
    receipts.push(await sweepSamCompany(company, { deadlineMs }));
  }
  const attempted = companies.slice(0, receipts.length);
  return { source: "sam-entity", offset, checked: attempted.length, nextOffset: offset + attempted.length, done: attempted.length === companies.length && (recurringWindow ? recurringWindow.done : companies.length < limit), ...(recurringWindow ? { advanceCursor: false, cursorPatch: { afterCompanyId: recurringWindow.done && attempted.length === companies.length ? null : attempted.at(-1)?.id ?? afterCompanyId } } : {}), matched: receipts.filter((r) => r.status === "matched").length, ambiguous: receipts.filter((r) => r.status === "ambiguous").length, errors: receipts.filter((r) => r.status === "error").length, entities: receipts.reduce((s, r) => s + r.entities, 0), naics: receipts.reduce((s, r) => s + r.naics, 0), triggers: receipts.reduce((s, r) => s + r.triggers, 0), receipts };
}
