/** Shared domain types — mirror supabase/migrations/0001_init.sql. */

export type CompanySource = "discovered" | "imported";

export type CompanyStatus =
  | "new"
  | "reviewed"
  | "dismissed"
  | "exported_csv"
  | "exported_sql";

export type ScoreTier = "A" | "B" | "C";

export type SignalType =
  | "finance_hire"
  | "pain_job_post"
  | "hiring_velocity"
  | "funding"
  | "m_and_a"
  // complexity-spike events (NetSuite wins when complexity outgrows QuickBooks)
  | "new_entity" // new legal entity / subsidiary / DBA → multi-entity consolidation
  | "gov_contract" // federal/government award → revenue step-change + audit/DCAA
  | "new_facility" // new warehouse / DC / terminal / office → multi-location
  | "fleet_expansion" // new operating authority / power-unit growth (FMCSA)
  | "new_service_line" // new practice / advisory / revenue stream → rev rec
  | "new_location"
  | "new_service"
  | "ex_netsuite_alum"
  | "tech_stack"
  | "intent"
  | "job_post"
  | "news";

export type SignalStrength = "weak" | "medium" | "strong";

export interface Signal {
  id: string;
  company_id: string;
  type: SignalType;
  strength: SignalStrength;
  weight: number;
  source_name?: string | null;
  source_url: string; // REQUIRED — never fabricate
  raw_excerpt?: string | null;
  signal_summary?: string | null;
  subindustry_relevant: boolean;
  detected_at: string; // when WE ingested it
  signal_date?: string | null; // when the event/post actually happened (from the source), if known
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  website_raw: string | null;
  description: string | null;
  subindustry: string | null;
  ns_industry: string | null;
  in_territory: boolean;
  territory_fit: number | null;
  source: CompanySource;
  status: CompanyStatus;
  state: string | null;
  city: string | null;
  employee_band: string | null;
  revenue_band: string | null;
  signal_score: number; // deterministic 0–100
  score_tier: ScoreTier | null; // independent LLM tier
  score_reason: string | null;
  has_new_signal: boolean;
  already_on_netsuite: boolean;
  starred: boolean;
  thumbs_down?: boolean; // per-lead downvote (no tab) — migration 0024
  rating: number | null; // 1..5 quality rating from the AE
  rating_comment: string | null;
  sources: string[];
  notes: string | null;
  first_seen_at: string;
  last_updated_at: string;
  exported_at: string | null;
  // TAM Base (vendor-imported) fields — migration 0015
  is_base?: boolean;
  lead_vendor?: string | null;
  fit_weight?: number;
  technologies?: string[];
  erp_ready?: boolean;
  employee_count?: number | null;
  // Silo/list membership — migration 0016
  lists?: string[];
  claimable?: boolean;
  netsuite_internal_id?: string | null; // migration 0018
  // ERP-readiness signals — migration 0020
  erp_incumbent?: string | null; // 'quickbooks' (ready) | 'erp' (already on ERP) | null
  pe_owned?: boolean;
  tal_claimed?: boolean; // on the AE's Target Account List — migration 0022
  tal_dq?: boolean; // was on a prior TAL, dropped from the latest → previously DQ'd — migration 0023
  tal_alert?: boolean; // claimed account has a new unseen signal (in-app notification) — migration 0025
  headcount_growth_pct?: number | null; // DOL 5500 within-year participant growth % — migration 0028
  has_parent?: boolean; // subsidiary of a larger parent — migration 0029
  parent_name?: string | null;
  parent_confidence?: string | null; // 'high' | 'low'
  // Old Gold: qual-note + NetSuite-record intelligence — migration 0030
  last_sql_date?: string | null; // last time their team met with NetSuite (BDR SQL)
  qual_note?: string | null; // raw qualification note from the TAM CSV
  oldgold_score?: number | null; // 0-100 revival score — ONLY for true Old Gold leads (qual note + SQL date)
  tam_score?: number | null; // 0-100 holistic lead-record grade for EVERY lead — TAM Base ranks on this (migration 0031)
  tam_provisional?: boolean; // true = free formula floor (capped 39), deep read pending
  oldgold_class?: string | null; // timing_arrived | contract_clock | stalled_warm | lost_to_competitor | dead | insufficient
  oldgold_reasons?: string[] | null; // explicit quoted reasons; "⚠" prefix = undated evidence
  record_digest?: string | null; // tight summary of the full NetSuite lead record (PDF)
  record_dead?: boolean; // record says dead (explicit rejection / hard disqualify) — shown EVERYWHERE
  record_dead_reason?: string | null;
  revisit_on?: string | null; // computed "their stated timing arrives" date
  signals: Signal[];
}

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  finance_hire: "Finance hire",
  pain_job_post: "Pain job post",
  hiring_velocity: "Hiring velocity",
  funding: "Funding",
  m_and_a: "M&A / PE",
  new_entity: "New entity",
  gov_contract: "Gov contract",
  new_facility: "New facility",
  fleet_expansion: "Fleet expansion",
  new_service_line: "New service line",
  new_location: "New location",
  new_service: "New service",
  ex_netsuite_alum: "Ex-NetSuite alum",
  tech_stack: "Tech stack",
  intent: "Intent",
  job_post: "Job post",
  news: "News",
};
