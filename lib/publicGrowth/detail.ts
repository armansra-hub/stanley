import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { summarizeContractRevenueByYear, type AnnualContractRevenue } from "./metrics";
import { form5500ObservationExclusion } from "./form5500ObservationSafety";
import { bindRelatedFederalEntities, mergeSourcedRelatedEntities, federalCoverage, federalRelationshipWitness, type FederalCoverage, type FederalSourceCoverage, type RelatedFederalEntity } from "./federalPresentation";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PublicGrowthDetail {
  entities: any[];
  pendingEntities: any[];
  relatedEntities: RelatedFederalEntity[];
  federalCoverage: FederalCoverage;
  contractMetrics: any | null;
  contractRevenueByYear: AnnualContractRevenue[];
  contractActions: any[];
  awards: any[];
  naicsSize: any[];
  headcount: any[];
  revenue: any[];
  opportunities: any[];
}

export async function getPublicGrowthDetail(companyId: string): Promise<PublicGrowthDetail> {
  const db = serviceClient();
  const [{ data: matches, error: matchesError }, { data: metrics, error: metricsError }, { data: headcount, error: headcountError }, { data: revenue }, { data: opportunityMatches }, { data: company, error: companyError }, { data: sourceCoverage, error: coverageError }] = await Promise.all([
    db.from("company_government_matches").select("match_status,match_method,confidence,evidence,government_entities(*)").eq("company_id", companyId).neq("match_status", "rejected").order("confidence", { ascending: false }),
    db.from("company_contract_metric_snapshots").select("*").eq("company_id", companyId).order("as_of_date", { ascending: false }).limit(1).maybeSingle(),
    db.from("form5500_headcount_observations").select("*").eq("company_id", companyId).order("form_year", { ascending: false }).limit(100),
    db.from("company_revenue_observations").select("*").eq("company_id", companyId).order("observed_on", { ascending: false }).limit(100),
    db.from("company_opportunity_matches").select("relationship,confidence,evidence,status,sam_opportunities(*)").eq("company_id", companyId).eq("status", "active").order("confidence", { ascending: false }).limit(100),
    db.from("companies").select("state").eq("id", companyId).maybeSingle(),
    db.from("company_federal_source_coverage").select("source,status,scope,searched_from,searched_through,last_attempted_at,last_completed_at").eq("company_id", companyId),
  ]);
  if (companyError) throw new Error(`Form 5500 detail company read failed: ${companyError.message}`);
  if (headcountError) throw new Error(`Form 5500 detail history read failed: ${headcountError.message}`);
  if (matchesError) throw new Error(`federal identity detail load failed: ${matchesError.message}`);
  if (metricsError) throw new Error(`federal metric detail load failed: ${metricsError.message}`);
  if (coverageError) throw new Error(`federal source coverage load failed: ${coverageError.message}`);
  const visibleHeadcount = company ? (headcount ?? []).filter((row) => !form5500ObservationExclusion(company.state, row)) : [];
  const allEntities = (matches ?? []).filter((m: any) => m.government_entities?.id).map((m: any) => ({ ...m.government_entities, match_status: m.match_status, match_method: m.match_method, match_confidence: Number(m.confidence ?? 0), match_evidence: m.evidence }));
  const entities = allEntities.filter((entity: any) => entity.match_status === "verified");
  const pendingEntities = allEntities.filter((entity: any) => entity.match_status === "pending");
  const entityIds = entities.map((e: any) => e.id);
  let awards: any[] = [], naicsSize: any[] = [], contractRevenueByYear: AnnualContractRevenue[] = [];
  let contractActions: any[] = [];
  if (entityIds.length) {
    const { data: n, error: naicsError } = await db.from("entity_naics_size_status_snapshots").select("*").in("government_entity_id", entityIds).order("observed_on", { ascending: false }).limit(500);
    if (naicsError) throw new Error(`federal NAICS detail load failed: ${naicsError.message}`);
    naicsSize = n ?? [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await db.from("federal_awards")
        .select("id,government_entity_id,generated_award_id,award_id,parent_award_id,award_type,start_date,end_date,potential_end_date,evidence,award_ceiling,current_award_amount,total_obligations,awarding_agency,description,source_url,observed_at")
        .in("government_entity_id", entityIds).order("start_date", { ascending: false }).order("id").range(start, start + 999);
      if (error) throw new Error(`federal award detail load failed: ${error.message}`);
      awards.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const awardIds = awards.map((award: any) => award.id).filter(Boolean);
    if (awardIds.length) {
      const transactions: any[] = [];
      for (let awardStart = 0; awardStart < awardIds.length; awardStart += 100) {
        const ids = awardIds.slice(awardStart, awardStart + 100);
        for (let rowStart = 0; ; rowStart += 1000) {
          const { data, error } = await db.from("federal_award_transactions").select("id,federal_award_id,external_transaction_id,action_date,federal_action_obligation,action_type,modification_number,description,source_url")
            .in("federal_award_id", ids).order("id").range(rowStart, rowStart + 999);
          if (error) throw new Error(`federal transaction detail load failed: ${error.message}`);
          transactions.push(...(data ?? []));
          if ((data ?? []).length < 1000) break;
        }
      }
      contractRevenueByYear = summarizeContractRevenueByYear(transactions.map((transaction, index) => ({
        externalTransactionId: String(index), generatedAwardId: "", actionDate: transaction.action_date,
        obligation: Number(transaction.federal_action_obligation ?? 0), modificationNumber: null,
      })));
      const awardsById = new Map(awards.map((award) => [award.id, award]));
      contractActions = [...transactions].sort((a, b) => String(b.action_date).localeCompare(String(a.action_date)) || String(a.id).localeCompare(String(b.id)))
        .slice(0, 50).map((transaction) => ({ ...transaction,
          award_id: awardsById.get(transaction.federal_award_id)?.award_id ?? null,
          award_type: awardsById.get(transaction.federal_award_id)?.award_type ?? null }));
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
  const { data: sourcedLinks, error: sourcedError } = await db.from("company_related_government_entities")
    .select("relationship,evidence,government_entities(*),company_federal_identity_claims!inner(intelligence_observations!inner(is_current,feedback_excluded))")
    .eq("company_id", companyId).order("id").limit(101);
  if (sourcedError) throw new Error(`sourced federal relationship load failed: ${sourcedError.message}`);
  if ((sourcedLinks ?? []).length > 100) relatedEntitiesTruncated = true;
  const relatedEntities = mergeSourcedRelatedEntities(entities, bindRelatedFederalEntities(entities, relatedCandidates), (sourcedLinks ?? []).slice(0, 100));
  // Bounded related context is separate from the complete stored direct-history read.
  if (relatedEntities.length > 20) relatedEntitiesTruncated = true;
  const visibleRelated = relatedEntities.slice(0, 20);
  await Promise.all(visibleRelated.map(async (related) => {
    const { data, error } = await db.from("federal_awards")
      .select("id,government_entity_id,generated_award_id,award_id,parent_award_id,award_type,start_date,end_date,potential_end_date,evidence,current_award_amount,award_ceiling,total_obligations,awarding_agency,description,source_url,observed_at")
      .eq("government_entity_id", String(related.entity.id)).order("start_date", { ascending: false }).limit(21);
    if (error) throw new Error(`related federal award detail load failed: ${error.message}`);
    related.awards = (data ?? []).slice(0, 20); related.awardsTruncated = (data ?? []).length > 20;
  }));
  const { data: repairs, error: repairError } = await db.from("federal_identity_remediation_receipts")
    .select("created_at").eq("company_id", companyId).eq("outcome", "related_context").order("created_at", { ascending: false }).limit(1);
  if (repairError) throw new Error(`federal identity repair load failed: ${repairError.message}`);
  const staleMetrics = repairs?.[0] && (!metrics?.observed_at || Date.parse(metrics.observed_at) <= Date.parse(repairs[0].created_at));
  return { entities, pendingEntities, relatedEntities: visibleRelated,
    federalCoverage: federalCoverage(entities, pendingEntities, awards, relatedEntitiesTruncated, (sourceCoverage ?? []) as FederalSourceCoverage[]),
    contractMetrics: entities.length && !staleMetrics ? metrics ?? null : null, contractRevenueByYear, contractActions, awards, naicsSize,
    headcount: visibleHeadcount, revenue: revenue ?? [], opportunities: opportunityMatches ?? [] };
}
