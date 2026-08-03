import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { summarizeContractRevenueByYear, type AnnualContractRevenue } from "./metrics";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PublicGrowthDetail {
  entities: any[];
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
  const [{ data: matches }, { data: metrics }, { data: headcount }, { data: revenue }, { data: opportunityMatches }] = await Promise.all([
    db.from("company_government_matches").select("match_status,match_method,confidence,evidence,government_entities(*)").eq("company_id", companyId).neq("match_status", "rejected").order("confidence", { ascending: false }),
    db.from("company_contract_metric_snapshots").select("*").eq("company_id", companyId).order("as_of_date", { ascending: false }).limit(1).maybeSingle(),
    db.from("form5500_headcount_observations").select("*").eq("company_id", companyId).order("form_year", { ascending: false }).limit(100),
    db.from("company_revenue_observations").select("*").eq("company_id", companyId).order("observed_on", { ascending: false }).limit(100),
    db.from("company_opportunity_matches").select("relationship,confidence,evidence,status,sam_opportunities(*)").eq("company_id", companyId).eq("status", "active").order("confidence", { ascending: false }).limit(100),
  ]);
  const entities = (matches ?? []).map((m: any) => ({ ...m.government_entities, match_status: m.match_status, match_method: m.match_method, match_confidence: Number(m.confidence ?? 0), match_evidence: m.evidence }));
  const entityIds = entities.map((e: any) => e.id);
  let awards: any[] = [], naicsSize: any[] = [], contractRevenueByYear: AnnualContractRevenue[] = [];
  if (entityIds.length) {
    const { data: n } = await db.from("entity_naics_size_status_snapshots").select("*").in("government_entity_id", entityIds).order("observed_on", { ascending: false }).limit(500);
    naicsSize = n ?? [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await db.from("federal_awards")
        .select("id,generated_award_id,award_id,start_date,end_date,award_ceiling,current_award_amount,total_obligations,awarding_agency,description,source_url")
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
  return { entities, contractMetrics: metrics ?? null, contractRevenueByYear, awards, naicsSize, headcount: headcount ?? [], revenue: revenue ?? [], opportunities: opportunityMatches ?? [] };
}
