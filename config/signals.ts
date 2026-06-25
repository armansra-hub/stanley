import type { SignalType } from "@/lib/types";

/**
 * THE THESIS (drives everything): NetSuite wins when operational/financial
 * complexity outgrows QuickBooks/spreadsheets. Every signal is a proxy for a
 * spike in one of these complexity dimensions. Detect the event → infer which
 * dimension it stresses → score it. Subindustry-specific events outrank
 * generic growth.
 */
export type ComplexityDriver =
  | "multi_entity"
  | "multi_location"
  | "multi_currency"
  | "project_job_costing"
  | "revenue_recognition"
  | "audit_compliance";

export const COMPLEXITY_DRIVERS: Record<ComplexityDriver, string> = {
  multi_entity: "Multiple legal entities/subsidiaries needing consolidation — the #1 QuickBooks-killer.",
  multi_location: "Multiple offices/warehouses/terminals — inventory, location P&L, payroll nexus.",
  multi_currency: "Cross-border operations — multi-currency + foreign tax.",
  project_job_costing: "Project/job-based billing — WIP, utilization, PSA, time & expense.",
  revenue_recognition: "Multiple/complex revenue streams — ASC 606, retainers, subscriptions.",
  audit_compliance: "Audit-readiness / regulatory compliance — PE/board pressure, DCAA, GAAP close.",
};

/** Which complexity driver(s) each signal type is evidence of (for the LLM 'why NetSuite' line + scoring nudges). */
export const SIGNAL_DRIVERS: Record<SignalType, ComplexityDriver[]> = {
  new_entity: ["multi_entity"],
  m_and_a: ["multi_entity", "audit_compliance"],
  funding: ["audit_compliance", "revenue_recognition"],
  new_facility: ["multi_location"],
  fleet_expansion: ["multi_location", "audit_compliance"],
  gov_contract: ["audit_compliance", "revenue_recognition"],
  new_service_line: ["revenue_recognition", "project_job_costing"],
  new_service: ["revenue_recognition", "project_job_costing"],
  new_location: ["multi_location"],
  finance_hire: ["audit_compliance", "revenue_recognition"],
  pain_job_post: ["project_job_costing", "revenue_recognition"],
  hiring_velocity: ["multi_location"],
  ex_netsuite_alum: ["audit_compliance"],
  tech_stack: ["revenue_recognition"],
  intent: [],
  job_post: [],
  news: [],
};

export type Vertical = "cross" | "business_services" | "transportation";

export interface CatalogEntry {
  event: string;
  signal_type: SignalType;
  drivers: ComplexityDriver[];
  vertical: Vertical;
  /** How to catch it. */
  how: string;
  /** Source ids (see config/sources.ts FREE_SOURCES + config/actors.ts). */
  sources: string[];
  free: boolean;
}

/**
 * The catalog of buying-trigger events. This is the map from "what happened in
 * the world" → "which signal we record" → "how we detect it (free where
 * possible)".
 */
export const SIGNAL_CATALOG: CatalogEntry[] = [
  // ── Cross-vertical ──────────────────────────────────────────────────────
  {
    event: "New legal entity / subsidiary / DBA formed",
    signal_type: "new_entity",
    drivers: ["multi_entity"],
    vertical: "cross",
    how: "State business registries / OpenCorporates; foreign-entity registration for cross-border.",
    sources: ["opencorporates", "google_news"],
    free: true,
  },
  {
    event: "M&A — acquired a company, or acquired by PE",
    signal_type: "m_and_a",
    drivers: ["multi_entity", "audit_compliance"],
    vertical: "cross",
    how: "Newswire/Google News RSS; LinkedIn posts; (Crunchbase if available).",
    sources: ["google_news", "business_wire", "pr_newswire", "globenewswire", "linkedin_posts"],
    free: true,
  },
  {
    event: "Funding round / recapitalization",
    signal_type: "funding",
    drivers: ["audit_compliance", "revenue_recognition"],
    vertical: "cross",
    how: "SEC EDGAR Form D + news RSS.",
    sources: ["edgar_form_d", "google_news"],
    free: true,
  },
  {
    event: "Going international / first cross-border op",
    signal_type: "new_entity",
    drivers: ["multi_currency"],
    vertical: "cross",
    how: "News, job posts in a new country, foreign entity registration.",
    sources: ["google_news", "opencorporates"],
    free: true,
  },
  {
    event: "New finance leader (Controller/CFO/VP Finance/Acctg Mgr)",
    signal_type: "finance_hire",
    drivers: ["audit_compliance", "revenue_recognition"],
    vertical: "cross",
    how: "Job posts; LinkedIn / Sales Navigator. Re-evaluate the stack in their first 6–12 months.",
    sources: ["indeed", "linkedin_jobs", "google_jobs", "linkedin_sales_nav"],
    free: false,
  },
  {
    event: 'The explicit tell — "transitioning off QuickBooks", "ERP implementation", "Business Systems Analyst", "RevOps", "FP&A", "ASC 606 / audit-ready"',
    signal_type: "pain_job_post",
    drivers: ["revenue_recognition", "audit_compliance", "project_job_costing"],
    vertical: "cross",
    how: "Job-post keyword match — the single strongest signal.",
    sources: ["indeed", "linkedin_jobs", "google_jobs", "career_sites", "builtin_jobs"],
    free: false,
  },
  {
    event: "Federal/government contract win",
    signal_type: "gov_contract",
    drivers: ["revenue_recognition", "audit_compliance"],
    vertical: "cross",
    how: "USASpending.gov API (free, no auth, 'new awards only' via date filter).",
    sources: ["usaspending"],
    free: true,
  },
  {
    event: "Named to Inc. 5000 / fast-growth list",
    signal_type: "intent",
    drivers: ["revenue_recognition", "multi_location"],
    vertical: "cross",
    how: "Inc. 5000 list (free) — filter to subindustries + states = a ready-made target list.",
    sources: ["inc5000"],
    free: true,
  },

  // ── Business Services–specific ──────────────────────────────────────────
  {
    event: "New service line / practice launch (advisory vertical, retainer→SaaS)",
    signal_type: "new_service_line",
    drivers: ["revenue_recognition"],
    vertical: "business_services",
    how: "Newswire/news RSS; LinkedIn.",
    sources: ["google_news", "business_wire", "linkedin_posts"],
    free: true,
  },
  {
    event: 'Project-accounting / PSA hiring ("project accountant", "billing manager", "WIP", "utilization", "PSA", "resource manager")',
    signal_type: "pain_job_post",
    drivers: ["project_job_costing", "revenue_recognition"],
    vertical: "business_services",
    how: "Job-post keyword — QB chokes on project-based billing (agencies, consulting, law, staffing).",
    sources: ["indeed", "linkedin_jobs", "google_jobs", "career_sites"],
    free: false,
  },
  {
    event: "Roll-up / multi-office growth (facilities, staffing, agencies acquiring shops)",
    signal_type: "m_and_a",
    drivers: ["multi_entity"],
    vertical: "business_services",
    how: "M&A news, registries.",
    sources: ["google_news", "pr_newswire", "opencorporates"],
    free: true,
  },
  {
    event: "Staffing/HR firm scaling placements (high open-req volume on own boards)",
    signal_type: "hiring_velocity",
    drivers: ["multi_location"],
    vertical: "business_services",
    how: "Their own job-post volume + new-state job locations (payroll/billing volume + multi-state tax).",
    sources: ["career_sites", "indeed"],
    free: false,
  },
  {
    event: "Opening ops in new states",
    signal_type: "new_facility",
    drivers: ["multi_location"],
    vertical: "business_services",
    how: "Job-post locations, new state registrations (multi-state payroll/nexus/tax).",
    sources: ["indeed", "google_jobs", "opencorporates"],
    free: false,
  },

  // ── Transportation / Logistics–specific ─────────────────────────────────
  {
    event: "New warehouse / DC / terminal / cross-dock",
    signal_type: "new_facility",
    drivers: ["multi_location"],
    vertical: "transportation",
    how: 'News RSS ("opens distribution center/terminal"); warehouse job posts in a new city; Google Maps.',
    sources: ["google_news", "business_wire", "google_places", "indeed"],
    free: true,
  },
  {
    event: "New operating authority / new MC number + fleet growth (power units/drivers)",
    signal_type: "fleet_expansion",
    drivers: ["audit_compliance", "multi_location"],
    vertical: "transportation",
    how: "FMCSA Motor Carrier Census — free public download. Gold transportation-specific source (asset/maintenance/fuel/depreciation accounting).",
    sources: ["fmcsa"],
    free: true,
  },
  {
    event: "New 3PL/contract-logistics client or new capability (cold chain, reefer, hazmat, last-mile)",
    signal_type: "new_service_line",
    drivers: ["revenue_recognition", "audit_compliance"],
    vertical: "transportation",
    how: "Newswire/news RSS.",
    sources: ["google_news", "business_wire", "globenewswire"],
    free: true,
  },
  {
    event: "Acquiring another carrier/terminal",
    signal_type: "m_and_a",
    drivers: ["multi_entity"],
    vertical: "transportation",
    how: "M&A news.",
    sources: ["google_news", "pr_newswire"],
    free: true,
  },
  {
    event: 'TMS/WMS/ELD/dispatch systems hiring ("implement TMS", "logistics systems analyst")',
    signal_type: "pain_job_post",
    drivers: ["project_job_costing", "multi_location"],
    vertical: "transportation",
    how: "Job-post keyword — systems maturation.",
    sources: ["indeed", "linkedin_jobs", "google_jobs"],
    free: false,
  },
  {
    event: "Federal freight/transport award (DoD, GSA)",
    signal_type: "gov_contract",
    drivers: ["revenue_recognition", "audit_compliance"],
    vertical: "transportation",
    how: "USASpending.gov (free).",
    sources: ["usaspending"],
    free: true,
  },
];

/**
 * Job-post trigger keywords (the explicit tells). Used to detect pain_job_post
 * / finance_hire signals and to judge whether a signal is subindustry_relevant.
 */
export const JOB_POST_TRIGGERS = {
  explicit_erp: [
    "transitioning off QuickBooks",
    "outgrew QuickBooks",
    "QuickBooks to NetSuite",
    "ERP implementation",
    "NetSuite implementation",
    "ERP migration",
    "Business Systems Analyst",
  ],
  finance_maturation: [
    "RevOps",
    "FP&A",
    "ASC 606",
    "audit-ready",
    "month-end close",
    "multi-entity",
    "consolidations",
    "revenue recognition",
  ],
  finance_leaders: [
    "Controller",
    "CFO",
    "VP Finance",
    "Director of Finance",
    "Accounting Manager",
  ],
  business_services: [
    "project accountant",
    "billing manager",
    "WIP",
    "utilization",
    "PSA",
    "resource manager",
    "time & expense",
  ],
  transportation: [
    "implement TMS",
    "logistics systems analyst",
    "WMS",
    "dispatch",
    "settlements",
    "fleet maintenance",
    "ELD",
  ],
} as const;

/**
 * Per-vertical news-RSS trigger terms. Crossed with the subindustries to build
 * the Google News / newswire queries in config/news.ts.
 */
export const NEWS_TRIGGERS: Record<Vertical, string[]> = {
  cross: [
    "forms new subsidiary",
    "new DBA",
    "acquires",
    "acquired by",
    "private equity",
    "raises funding",
    '"Series A"',
    "expands internationally",
    "awarded contract",
    "Inc. 5000",
    '"hires Controller"',
    '"appoints CFO"',
    "outgrew QuickBooks",
  ],
  business_services: [
    "launches new practice",
    "new service line",
    "opens new office",
    "new advisory",
    "roll-up",
    "acquires agency",
    "acquires staffing firm",
    '"new client" AOR',
  ],
  transportation: [
    "opens distribution center",
    "new terminal",
    "new warehouse",
    "cross-dock",
    "new operating authority",
    "expands fleet",
    '3PL "new lane"',
    "cold chain",
    "reefer",
    "last-mile",
  ],
};
