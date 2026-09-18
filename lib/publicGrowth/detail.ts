import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { summarizeContractRevenueByYear, type AnnualContractRevenue } from "./metrics";
import { form5500ObservationExclusion } from "./form5500ObservationSafety";
import { bindRelatedFederalEntities, federalCoverage, federalRelationshipWitness, type FederalCoverage, type RelatedFederalEntity } from "./federalPresentation";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PublicGrowthDetail {
  entities: any[];
  pendingEntities: any[];
  relatedEntities: RelatedFederalEntity[];
  federalCoverage: FederalCoverage;
  contractMetrics: any | null;
  contractRevenueByYear: AnnualContractRevenue[];
  awards: any[];
  naicsSize: any[];
  headcount: any[];
  revenue: any[];
  opportunities: any[];
}

export async function getPublicGrowthDetail(companyId: string): Promise<PublicGrowthDetail> {
  const db = serviceClient();
  const [{ data: matches, error: matchesError }, { data: metrics, error: metricsError }, { data: headcount, error: headcountError }, { data: revenue }, { data: opportunityMatches }, { data: company, error: companyError }] = await Promise.all([
    db.from("company_government_matches").select("match_status,match_method,confidence,evidence,government_entities(*)").eq("company_id", companyId).neq("match_status", "rejected").order("confidence", { ascending: false }),
    db.from("company_contract_metric_snapshots").select("*").eq("company_id", companyId).order("as_of_date", { ascending: false }).limit(1).maybeSingle(),
    db.from("form5500_headcount_observations").select("*").eq("company_id", companyId).order("form_year", { ascending: false }).limit(100),
    db.from("company_revenue_observations").select("*").eq("company_id", companyId).order("observed_on", { ascending: false }).limit(100),
    db.from("company_opportunity_matches").select("relationship,confidence,evidence,status,sam_opportunities(*)").eq("company_id", companyId).eq("status", "active").order("confidence", { ascending: false }).limit(100),
    db.from("companies").select("state").eq("id", companyId).maybeSingle(),
  ]);
  if (companyError) throw new Error(`Form 5500 detail company read failed: ${companyError.message}`);
  if (headcountError) throw new Error(`Form 5500 detail history read failed: ${headcountError.message}`);
  if (matchesError) throw new Error(`federal identity detail load failed: ${matchesError.message}`);
  if (metricsError) throw new Error(`federal metric detail load failed: ${metricsError.message}`);
  const visibleHeadcount = company ? (headcount ?? []).filter((row) => !form5500ObservationExclusion(company.state, row)) : [];
  const allEntities = (matches ?? []).filter((m: any) => m.government_entities?.id).map((m: any) => ({ ...m.government_entities, match_status: m.match_status, match_method: m.match_method, match_confidence: Number(m.confidence ?? 0), match_evidence: m.evidence }));
  const entities = allEntities.filter((entity: any) => entity.match_status === "verified");
  const pendingEntities = allEntities.filter((entity: any) => entity.match_status === "pending");
  const entityIds = entities.map((e: any) => e.id);
  let awards: any[] = [], naicsSize: any[] = [], contractRevenueByYear: AnnualContractRevenue[] = [];
  if (entityIds.length) {
    const { data: n, error: naicsError } = await db.from("entity_naics_size_status_snapshots").select("*").in("government_entity_id", entityIds).order("observed_on", { ascending: false }).limit(500);
    if (naicsError) throw new Error(`federal NAICS detail load failed: ${naicsError.message}`);
    naicsSize = n ?? [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await db.from("federal_awards")
        .select("id,government_entity_id,generated_award_id,award_id,parent_award_id,award_type,start_date,end_date,award_ceiling,current_award_amount,total_obligations,awarding_agency,description,source_url,observed_at")
        .in("government_entity_id", entityIds).order("start_date", { ascending: false }).range(start, start + 999);
      if (error) throw new Error(`federal award detail load failed: ${error.message}`);
      awards.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const awardIds = awards.map((award: any) => award.id).filter(Boolean);
    if (awardIds.length) {
      const transactions: Array<{ action_date: string; federal_action_obligation: number }> = [];
      for (let awardStart = 0; awardStart < awardIds.length; awardStart += 100) {
        const ids = awardIds.slice(awardStart, awardStart + 100);
        for (let rowStart = 0; ; rowStart += 1000) {
          const { data, error } = await db.from("federal_award_transactions").select("action_date,federal_action_obligation")
            .in("federal_award_id", ids).order("action_date", { ascending: false }).range(rowStart, rowStart + 999);
          if (error) throw new Error(`federal transaction detail load failed: ${error.message}`);
          transactions.push(...((data ?? []) as Array<{ action_date: string; federal_action_obligation: number }>));
          if ((data ?? []).length < 1000) break;
        }
      }
      contractRevenueByYear = summarizeContractRevenueByYear(transactions.map((transaction, index) => ({
        externalTransactionId: String(index), generatedAwardId: "", actionDate: transaction.action_date,
        obligation: Number(transaction.federal_action_obligation ?? 0), modificationNumber: null,
      })));
    }
  }
  // Exact provider-reported UEI edges only. Related rows never enter direct
  // awards, metrics, chronology or triggers, and never create a company match.
  const directUeis = [...new Set(entities.map((entity: any) => String(entity.uei ?? "")).filter((value: string) => /^[A-Z0-9]{12}$/i.test(value)))];
  const parentUeis = [...new Set(entities.flatMap((entity: any) => {
    const witness = federalRelationshipWitness(entity); return witness ? [witness.reportedParentUei] : [];
  }))];
  const relatedCandidates: any[] = [];
  let relatedEntitiesTruncated = false;
  for (const [field, ids] of [["uei", parentUeis], ["parent_uei", directUeis]] as const) {
    if (!ids.length) continue;
    const { data, error } = await db.from("government_entities").select("*").in(field, ids).order("id").limit(101);
    if (error) throw new Error(`related federal identity load failed: ${error.message}`);
    if ((data ?? []).length > 100) relatedEntitiesTruncated = true;
    relatedCandidates.push(...(data ?? []).slice(0, 100));
  }
  const relatedEntities = bindRelatedFederalEntities(entities, relatedCandidates);
  // Bounded related context is separate from the complete stored direct-history read.
  if (relatedEntities.length > 20) relatedEntitiesTruncated = true;
  const visibleRelated = relatedEntities.slice(0, 20);
  await Promise.all(visibleRelated.map(async (related) => {
    const { data, error } = await db.from("federal_awards")
      .select("id,government_entity_id,generated_award_id,award_id,parent_award_id,award_type,start_date,award_ceiling,total_obligations,awarding_agency,description,source_url,observed_at")
      .eq("government_entity_id", String(related.entity.id)).order("start_date", { ascending: false }).limit(21);
    if (error) throw new Error(`related federal award detail load failed: ${error.message}`);
    related.awards = (data ?? []).slice(0, 20); related.awardsTruncated = (data ?? []).length > 20;
  }));
  return { entities, pendingEntities, relatedEntities: visibleRelated,
    federalCoverage: federalCoverage(entities, pendingEntities, awards, relatedEntitiesTruncated),
    contractMetrics: entities.length ? metrics ?? null : null, contractRevenueByYear, awards, naicsSize,
    headcount: visibleHeadcount, revenue: revenue ?? [], opportunities: opportunityMatches ?? [] };
}
