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
  detected_at: string;
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
  sources: string[];
  notes: string | null;
  first_seen_at: string;
  last_updated_at: string;
  exported_at: string | null;
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
