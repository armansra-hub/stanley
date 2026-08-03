import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { searchSamOpportunities } from "./sam";
import { recordPublicGrowthTrigger, saveOpportunityMatch, saveSamOpportunity } from "./storage";
import type { DerivedGrowthEvent } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function sweepSamOpportunities(days = 31, offset = 0, limit = 1000) {
  const postedTo = new Date(), postedFrom = new Date(postedTo.getTime() - days * 86_400_000);
  const { total, rows } = await searchSamOpportunities({ postedFrom, postedTo, offset, limit });
  const db = serviceClient();
  let stored = 0, matches = 0, triggers = 0;
  const touched = new Set<string>();
  for (const row of rows) {
    if (!row.noticeId) continue;
    const opportunityId = await saveSamOpportunity(row); stored++;
    const candidates = new Map<string, { relationship: string; confidence: number; evidence: Record<string, unknown> }>();
    if (row.awardeeUei) {
      const { data } = await db.from("company_government_matches").select("company_id,government_entities!inner(uei)").eq("match_status", "verified").eq("government_entities.uei", row.awardeeUei);
      for (const x of data ?? []) candidates.set(String(x.company_id), { relationship: "awardee", confidence: 1, evidence: { method: "exact_awardee_uei", uei: row.awardeeUei } });
    }
    if (["p", "o", "k", "r"].includes(String(row.noticeType ?? "").toLowerCase()) && row.naicsCode && row.agency) {
      const { data } = await db.from("federal_awards").select("government_entity_id,awarding_agency,awarding_office,naics_code,psc_code,end_date,company_government_matches!inner(company_id,match_status)")
        .eq("company_government_matches.match_status", "verified").eq("naics_code", row.naicsCode).ilike("awarding_agency", row.agency);
      for (const award of data ?? []) for (const match of (award as any).company_government_matches ?? []) {
        const office = row.office && award.awarding_office && String(row.office).toLowerCase() === String(award.awarding_office).toLowerCase();
        const psc = row.pscCode && award.psc_code && row.pscCode === award.psc_code;
        if (!office && !psc) continue;
        candidates.set(String(match.company_id), { relationship: "incumbent_recompete", confidence: office && psc ? 0.92 : 0.82, evidence: { method: "verified_incumbent_agency_naics_plus_office_or_psc", officeMatch: Boolean(office), pscMatch: Boolean(psc), priorAwardEnd: award.end_date } });
      }
    }
    for (const [companyId, candidate] of candidates) {
      await saveOpportunityMatch(companyId, opportunityId, candidate.relationship, candidate.confidence, candidate.evidence); matches++; touched.add(companyId);
      const awarded = candidate.relationship === "awardee";
      const event: DerivedGrowthEvent = { family: "federal_opportunity", type: awarded ? "sam_award_notice" : "sam_incumbent_recompete", dedupeKey: `sam-opportunity:${row.noticeId}:${candidate.relationship}`, strength: awarded ? 88 : 78, summary: awarded ? `SAM award notice posted ${row.postedDate ?? "date unavailable"}: ${row.awardAmount == null ? "amount not reported" : `${Math.round(row.awardAmount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} awarded`} — ${row.title}.` : `Possible incumbent recompete posted ${row.postedDate ?? "date unavailable"}${row.responseDeadline ? `, response due ${String(row.responseDeadline).slice(0, 10)}` : ""}: ${row.title} (${row.agency}${row.naicsCode ? `, NAICS ${row.naicsCode}` : ""}).`, signalDate: row.postedDate, metadata: { noticeId: row.noticeId, relationship: candidate.relationship, awardAmount: row.awardAmount, agency: row.agency, office: row.office, naics: row.naicsCode, psc: row.pscCode, postedDate: row.postedDate, responseDeadline: row.responseDeadline, matchEvidence: candidate.evidence } };
      if (await recordPublicGrowthTrigger(companyId, event, "SAM.gov Contract Opportunities", row.sourceUrl, candidate.confidence)) triggers++;
    }
  }
  for (const companyId of touched) await recomputePriority(companyId);
  return { source: "sam-opportunities", offset, checked: rows.length, nextOffset: offset + rows.length, done: offset + rows.length >= total, total, stored, matches, triggers };
}
