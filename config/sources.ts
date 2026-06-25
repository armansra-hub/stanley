import type { SignalType } from "@/lib/types";
import type { Vertical } from "./signals";

/**
 * FREE data sources — no Apify, no per-result cost. Press releases are RSS/XML
 * feeds (the feed IS the product; no "news scraper" needed). Paid Apify actors
 * live in config/actors.ts. `auth: "user_agent_email"` means SEC fair-access
 * requires a real email in the User-Agent header.
 */
export interface FreeSource {
  id: string;
  name: string;
  url: string;
  produces: SignalType[];
  vertical: Vertical;
  auth: "none" | "user_agent_email" | "api_key_optional";
  /** Discovery introduces net-new companies; signal enriches known ones. */
  kind: "discovery" | "signal";
  geo_verifiable: boolean;
  enabled: boolean;
  /** "changes-only" / "new-awards-only" modes keep volume + relevance high. */
  mode?: string;
  notes: string;
}

export const FREE_SOURCES: FreeSource[] = [
  {
    id: "edgar_form_d",
    name: "SEC EDGAR — Form D full-text search",
    url: "https://efts.sec.gov/LATEST/search-index?forms=D",
    produces: ["funding"],
    vertical: "cross",
    auth: "user_agent_email",
    kind: "discovery",
    geo_verifiable: false,
    enabled: true,
    mode: "lookback by days; filter by state/SIC/keyword",
    notes: "US-only. User-Agent MUST carry a real email (you@example.com). Verify exact endpoint at build time.",
  },
  {
    id: "google_news",
    name: "Google News RSS",
    url: "https://news.google.com/rss/search?q=",
    produces: ["m_and_a", "funding", "new_facility", "new_service_line", "finance_hire", "news"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: false,
    enabled: true,
    notes: "Free RSS — one feed per subindustry × trigger term (config/news.ts NEWS_TRIGGERS). Parse XML; LLM extracts the company name from headlines, keeping the source_url.",
  },
  {
    id: "business_wire",
    name: "Business Wire RSS (keyword/industry)",
    url: "https://feed.businesswire.com/rss/home/",
    produces: ["m_and_a", "new_service_line", "new_facility", "funding"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: false,
    enabled: true,
    notes: "Best of the three wires — 250+ subject/industry keyword feeds + pre-built industry feeds.",
  },
  {
    id: "globenewswire",
    name: "GlobeNewswire RSS (category)",
    url: "https://www.globenewswire.com/RssFeed/",
    produces: ["m_and_a", "new_service_line", "funding"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: false,
    enabled: true,
    notes: "Free RSS/XML by category — narrow to relevant categories during tuning.",
  },
  {
    id: "pr_newswire",
    name: "PR Newswire RSS (news + topic)",
    url: "https://www.prnewswire.com/rss/",
    produces: ["m_and_a", "new_service_line", "funding"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: false,
    enabled: true,
    notes: "Free main + topic feeds — add the topic feeds matching the territory during tuning.",
  },
  {
    id: "fmcsa",
    name: "FMCSA Motor Carrier Census",
    url: "https://data.transportation.gov/ (FMCSA company census download)",
    produces: ["fleet_expansion", "new_entity"],
    vertical: "transportation",
    auth: "none",
    kind: "discovery",
    geo_verifiable: true, // census carries the carrier's physical state
    enabled: true,
    mode: "new operating authority + power-unit/driver growth (run-over-run delta)",
    notes: "Free public download — gold transportation-specific source. New MC numbers = newly-authorized carriers scaling; fleet growth → asset/maintenance/depreciation accounting.",
  },
  {
    id: "usaspending",
    name: "USASpending.gov API",
    url: "https://api.usaspending.gov/",
    produces: ["gov_contract"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: true, // award records carry recipient state
    enabled: true,
    mode: "new awards only (filter by action_date window)",
    notes: "Free, no auth. Gov-contract wins → revenue step-change + DCAA/audit compliance. Covers both verticals (DoD/GSA freight, federal advisory).",
  },
  {
    id: "inc5000",
    name: "Inc. 5000 fast-growth list",
    url: "https://www.inc.com/inc5000",
    produces: ["intent"],
    vertical: "cross",
    auth: "none",
    kind: "discovery",
    geo_verifiable: true, // list carries HQ state
    enabled: true,
    mode: "annual list — intersect with subindustries + territory states",
    notes: "Free, pre-filtered fast-growth companies. Explicit 3-yr growth, often just before an ERP buy. Intersect with territory = a ready-made target list.",
  },
  {
    id: "opencorporates",
    name: "OpenCorporates / state business registries",
    url: "https://opencorporates.com/",
    produces: ["new_entity"],
    vertical: "cross",
    auth: "api_key_optional",
    kind: "signal",
    geo_verifiable: true,
    enabled: false, // bulk/API access is rate-limited; enable once a key/strategy is set
    notes: "New subsidiary/DBA/foreign-entity formation → multi-entity consolidation (the #1 QuickBooks-killer). Free tier is rate-limited.",
  },
];
