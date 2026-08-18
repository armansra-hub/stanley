import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { fetchSamOpportunityBulk } from "./samBulk";
import { recordPublicGrowthTrigger, saveOpportunityMatch, saveSamOpportunity } from "./storage";
import type { DerivedGrowthEvent } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function sweepSamOpportunities(days = 31, offset = 0, limit = 1000) {
  void limit;
  const bulk = await fetchSamOpportunityBulk(days);
  const rows = bulk.rows;
  const db = serviceClient();
  let stored = 0, matches = 0, triggers = 0;
  const touched = new Set<string>();

  const entityLinks: any[] = [];
  for (let page = 0; ; page += 1000) {
    const { data, error } = await db.from("company_government_matches")
      .select("company_id,government_entity_id,government_entities!inner(uei,legal_name,dba_name,city,state)")
      .eq("match_status", "verified").range(page, page + 999);
    if (error) throw new Error(`SAM bulk entity index failed: ${error.message}`);
    entityLinks.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  const entityCompanies = new Map<string, string[]>(), namesByFirst = new Map<string, Array<{ name: string; companyId: string; city: string; state: string }>>();
  const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  for (const link of entityLinks) {
    const companyId = String(link.company_id), entity = link.government_entities ?? {};
    if (entity.uei) entityCompanies.set(String(entity.uei).toUpperCase(), [...(entityCompanies.get(String(entity.uei).toUpperCase()) ?? []), companyId]);
    for (const rawName of [entity.legal_name, entity.dba_name]) {
      const name = norm(rawName); if (!name) continue;
      const first = name.split(" ")[0];
      namesByFirst.set(first, [...(namesByFirst.get(first) ?? []), { name, companyId, city: norm(entity.city), state: norm(entity.state) }]);
    }
  }
  const companyByEntity = new Map<string, string[]>();
  for (const link of entityLinks) companyByEntity.set(String(link.government_entity_id), [...(companyByEntity.get(String(link.government_entity_id)) ?? []), String(link.company_id)]);
  const awardsByKey = new Map<string, any[]>();
  for (let page = 0; ; page += 1000) {
    const { data, error } = await db.from("federal_awards")
      .select("government_entity_id,awarding_agency,awarding_office,naics_code,psc_code,end_date")
      .not("naics_code", "is", null).range(page, page + 999);
    if (error) throw new Error(`SAM bulk incumbent index failed: ${error.message}`);
    for (const award of data ?? []) {
      const companies = companyByEntity.get(String(award.government_entity_id)) ?? [];
      if (!companies.length) continue;
      const key = `${norm(award.awarding_agency)}|${String(award.naics_code)}`;
      awardsByKey.set(key, [...(awardsByKey.get(key) ?? []), { ...award, companies }]);
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  for (const row of rows) {
    if (!row.noticeId) continue;
    const candidates = new Map<string, { relationship: string; confidence: number; evidence: Record<string, unknown> }>();
    if (row.awardeeUei) {
      for (const companyId of entityCompanies.get(String(row.awardeeUei).toUpperCase()) ?? []) candidates.set(companyId, { relationship: "awardee", confidence: 1, evidence: { method: "exact_awardee_uei", uei: row.awardeeUei } });
    } else if (row.awardeeName) {
      const awardee = norm(row.awardeeName), first = awardee.split(" ")[0];
      const matching = (namesByFirst.get(first) ?? []).filter((entry) => awardee === entry.name || awardee.startsWith(`${entry.name} `));
      const uniqueCompanies = [...new Set(matching.map((entry) => entry.companyId))];
      if (uniqueCompanies.length === 1) {
        const evidence = matching.find((entry) => entry.companyId === uniqueCompanies[0])!;
        const locationMatch = (!evidence.city || awardee.includes(` ${evidence.city} `)) && (!evidence.state || awardee.includes(` ${evidence.state} `));
        if (locationMatch) candidates.set(uniqueCompanies[0], { relationship: "awardee", confidence: 0.97, evidence: { method: "verified_legal_name_and_location", awardee: row.awardeeName } });
      }
    }
    if (/^(p|o|k|r)$|solicitation|presolicitation|sources sought|combined synopsis/i.test(String(row.noticeType ?? "")) && row.naicsCode && row.agency) {
      for (const award of awardsByKey.get(`${norm(row.agency)}|${String(row.naicsCode)}`) ?? []) {
        const office = row.office && award.awarding_office && norm(row.office) === norm(award.awarding_office);
        const psc = row.pscCode && award.psc_code && row.pscCode === award.psc_code;
        if (!office && !psc) continue;
        for (const companyId of award.companies) candidates.set(String(companyId), { relationship: "incumbent_recompete", confidence: office && psc ? 0.92 : 0.82, evidence: { method: "verified_incumbent_agency_naics_plus_office_or_psc", officeMatch: Boolean(office), pscMatch: Boolean(psc), priorAwardEnd: award.end_date } });
      }
    }
    if (!candidates.size) continue;
    const opportunityId = await saveSamOpportunity(row); stored++;
    for (const [companyId, candidate] of candidates) {
      await saveOpportunityMatch(companyId, opportunityId, candidate.relationship, candidate.confidence, candidate.evidence); matches++; touched.add(companyId);
      const awarded = candidate.relationship === "awardee";
      const event: DerivedGrowthEvent = { family: "federal_opportunity", type: awarded ? "sam_award_notice" : "sam_incumbent_recompete", dedupeKey: `sam-opportunity:${row.noticeId}:${candidate.relationship}`, strength: awarded ? 88 : 78, summary: awarded ? `SAM award notice posted ${row.postedDate ?? "date unavailable"}: ${row.awardAmount == null ? "amount not reported" : `${Math.round(row.awardAmount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} awarded`} — ${row.title}.` : `Possible incumbent recompete posted ${row.postedDate ?? "date unavailable"}${row.responseDeadline ? `, response due ${String(row.responseDeadline).slice(0, 10)}` : ""}: ${row.title} (${row.agency}${row.naicsCode ? `, NAICS ${row.naicsCode}` : ""}).`, signalDate: row.postedDate, metadata: { noticeId: row.noticeId, relationship: candidate.relationship, awardAmount: row.awardAmount, agency: row.agency, office: row.office, naics: row.naicsCode, psc: row.pscCode, postedDate: row.postedDate, responseDeadline: row.responseDeadline, matchEvidence: candidate.evidence } };
      if (await recordPublicGrowthTrigger(companyId, event, "SAM.gov Contract Opportunities", row.sourceUrl, candidate.confidence)) triggers++;
    }
  }
  for (const companyId of touched) await recomputePriority(companyId);
  return { source: "sam-opportunities", mode: "public_bulk", offset, checked: rows.length, scanned: bulk.scanned, nextOffset: rows.length, done: true, total: rows.length, stored, matches, triggers, bulkEtag: bulk.etag, bulkLastModified: bulk.lastModified };
}
