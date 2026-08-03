import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { decideIdentityMatch, normalizeName } from "./identity";
import { compactSamEntity, sbaProfileUrl, searchSamEntities } from "./sam";
import { recordPublicGrowthTrigger, saveCompanyGovernmentMatch, saveGovernmentEntity, stableHash } from "./storage";
import { loadTamBatch } from "./usaspendingSweep";
import type { DerivedGrowthEvent, TamIdentity } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function statusValue(value: unknown): "small" | "other_than_small" | "unknown" {
  if (value === true || String(value).toLowerCase() === "yes") return "small";
  if (value === false || String(value).toLowerCase() === "no") return "other_than_small";
  return "unknown";
}

async function saveNaicsAndDerive(entityId: string, companyId: string, sam: ReturnType<typeof compactSamEntity>): Promise<number> {
  const db = serviceClient(), observedOn = new Date().toISOString().slice(0, 10), profileUrl = sbaProfileUrl(sam.uei, sam.cageCode);
  let triggers = 0;
  for (const n of sam.naics) {
    const status = statusValue(n.isSmallBusiness);
    const { data: previous } = await db.from("entity_naics_size_status_snapshots").select("status,has_size_changed,observed_on")
      .eq("government_entity_id", entityId).eq("naics_code", n.code).eq("exception_counter", n.exceptionCounter)
      .order("observed_on", { ascending: false }).limit(1).maybeSingle();
    const snapshot = { government_entity_id: entityId, naics_code: n.code, naics_name: n.name, is_primary: n.isPrimary, status, has_size_changed: n.hasSizeChanged ?? null, has_sba_protest: n.hasSbaProtest ?? null, exception_counter: n.exceptionCounter, source: "SAM.gov / SBA", source_url: profileUrl, observed_on: observedOn, payload_hash: stableHash(n), evidence: n };
    const { error } = await db.from("entity_naics_size_status_snapshots").upsert(snapshot, { onConflict: "government_entity_id,naics_code,exception_counter,observed_on" });
    if (error) throw new Error(`NAICS size snapshot failed: ${error.message}`);

    const events: DerivedGrowthEvent[] = [];
    const statusDate = sam.lastUpdateDate?.slice?.(0, 10) ?? observedOn;
    if (status === "other_than_small" && previous?.status !== "other_than_small") events.push({ family: "company_size", type: "sba_other_than_small", dedupeKey: `sam:${sam.uei}:naics:${n.code}:${n.exceptionCounter}:other-than-small`, strength: n.isPrimary ? 84 : 76, summary: `As of ${statusDate}, classified other than small for ${n.code}${n.name ? ` ${n.name}` : ""}${n.isPrimary ? " (primary NAICS)" : ""}.`, signalDate: statusDate, metadata: { naics: n.code, naicsName: n.name, isPrimary: n.isPrimary, status, previousStatus: previous?.status ?? null, hasSizeChanged: n.hasSizeChanged, hasSbaProtest: n.hasSbaProtest, asOf: statusDate } });
    if (n.hasSizeChanged && previous?.has_size_changed !== true) events.push({ family: "company_size", type: "sba_size_changed", dedupeKey: `sam:${sam.uei}:naics:${n.code}:${n.exceptionCounter}:size-changed`, strength: 82, summary: `As of ${statusDate}, SAM reports a size-status change for NAICS ${n.code}${n.name ? ` ${n.name}` : ""}.`, signalDate: statusDate, metadata: { naics: n.code, naicsName: n.name, isPrimary: n.isPrimary, status, hasSizeChanged: true, asOf: statusDate } });
    for (const event of events) if (await recordPublicGrowthTrigger(companyId, event, "SAM.gov / SBA Small Business Search", `${profileUrl}?signal=${encodeURIComponent(event.type)}&naics=${encodeURIComponent(n.code)}`, 1)) triggers++;
  }
  return triggers;
}

export async function sweepSamCompany(company: TamIdentity) {
  const receipt = { companyId: company.id, companyName: company.name, status: "not_found", entities: 0, naics: 0, triggers: 0, error: undefined as string | undefined };
  try {
    const db = serviceClient();
    const { data: linked } = await db.from("company_government_matches").select("government_entities(uei)").eq("company_id", company.id).eq("match_status", "verified");
    const linkedUeis = (linked ?? []).map((x: any) => x.government_entities?.uei).filter(Boolean);
    const rows = linkedUeis.length ? (await Promise.all(linkedUeis.map((uei: string) => searchSamEntities({ uei })))).flat() : await searchSamEntities({ legalBusinessName: company.name });
    for (const row of rows) {
      const sam = compactSamEntity(row);
      if (!sam.legalName || (linkedUeis.length === 0 && normalizeName(sam.legalName) !== normalizeName(company.name) && normalizeName(sam.dbaName) !== normalizeName(company.name))) continue;
      const decision = decideIdentityMatch(company, { legalName: sam.legalName, dbaName: sam.dbaName, domain: sam.domain, city: sam.city, state: sam.state, uei: sam.uei, cageCode: sam.cageCode });
      const entityId = await saveGovernmentEntity({ uei: sam.uei, cage_code: sam.cageCode, legal_name: sam.legalName, dba_name: sam.dbaName, website: sam.website, domain: sam.domain, address_line1: sam.address, city: sam.city, state: sam.state, postal_code: sam.postalCode, country_code: sam.countryCode, registration_status: sam.registrationStatus, registration_date: sam.registrationDate, expiration_date: sam.expirationDate, entity_start_date: sam.entityStartDate, parent_uei: sam.parentUei, parent_name: sam.parentName, source: "SAM.gov", source_url: `https://sam.gov/entity/${encodeURIComponent(sam.uei ?? sam.cageCode ?? sam.legalName)}/coreData`, source_updated_at: sam.lastUpdateDate, evidence: { psc: sam.psc, businessTypes: sam.businessTypes } });
      await saveCompanyGovernmentMatch(company.id, entityId, decision);
      receipt.entities++;
      if (decision.status !== "verified") { receipt.status = "ambiguous"; continue; }
      receipt.status = "matched"; receipt.naics += sam.naics.length; receipt.triggers += await saveNaicsAndDerive(entityId, company.id, sam);
    }
    if (receipt.triggers) await recomputePriority(company.id);
    return receipt;
  } catch (error) {
    return { ...receipt, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sweepSamTamBatch(limit: number, offset: number) {
  const companies = await loadTamBatch(limit, offset), receipts = [];
  for (const company of companies) receipts.push(await sweepSamCompany(company));
  return { source: "sam-entity", offset, checked: companies.length, nextOffset: offset + companies.length, done: companies.length < limit, matched: receipts.filter((r) => r.status === "matched").length, ambiguous: receipts.filter((r) => r.status === "ambiguous").length, errors: receipts.filter((r) => r.status === "error").length, entities: receipts.reduce((s, r) => s + r.entities, 0), naics: receipts.reduce((s, r) => s + r.naics, 0), triggers: receipts.reduce((s, r) => s + r.triggers, 0), receipts };
}
