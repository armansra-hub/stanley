import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PublicGrowthDetail {
  entities: any[];
  contractMetrics: any | null;
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
  let awards: any[] = [], naicsSize: any[] = [];
  if (entityIds.length) {
    const [a, n] = await Promise.all([
      db.from("federal_awards").select("*").in("government_entity_id", entityIds).order("start_date", { ascending: false }).limit(250),
      db.from("entity_naics_size_status_snapshots").select("*").in("government_entity_id", entityIds).order("observed_on", { ascending: false }).limit(500),
    ]);
    awards = a.data ?? []; naicsSize = n.data ?? [];
  }
  return { entities, contractMetrics: metrics ?? null, awards, naicsSize, headcount: headcount ?? [], revenue: revenue ?? [], opportunities: opportunityMatches ?? [] };
}

