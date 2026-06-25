/**
 * Apify actor registry — the 9 actors on Arman's account, with LIVE-verified
 * pricing + input schemas + ranking (relevance × price). Every actor runs on
 * the APIFY_TOKEN alone — NONE need login cookies. `wired` = adapter built +
 * in lib/ingest/discoverApify.ts. Paid (pay-per-result): run deliberately via
 * /api/cron/apify, each adapter self-caps maxItems.
 */
import type { SignalType } from "@/lib/types";

export interface ActorSlot {
  actor_id: string;
  rank: number;
  kind: "discovery" | "signal";
  produces: SignalType[];
  geo_verifiable: boolean;
  /** Verified pay-per-result price (FREE-tier). */
  price: string;
  /** What the actor returns. */
  output: string;
  /** Verified input fields (from the actor's input schema). */
  input_template: Record<string, unknown>;
  /** Adapter built + wired into discoverApify? */
  wired: boolean;
  enabled: boolean;
  /** Manual setup the user must provide, if any. */
  setup_note?: string;
}

export const ACTORS: Record<string, ActorSlot> = {
  indeed: {
    actor_id: "valig/indeed-jobs-scraper",
    rank: 1,
    kind: "signal",
    produces: ["pain_job_post", "finance_hire", "hiring_velocity"],
    geo_verifiable: false,
    price: "$0.0001/result (≈free)",
    output: "Job posts: company, title, description, location",
    input_template: { country: "US", title: "Controller", location: "", limit: 50, datePosted: "month" },
    wired: true,
    enabled: true,
  },
  google_jobs: {
    actor_id: "johnvc/Google-Jobs-Scraper",
    rank: 2,
    kind: "signal",
    produces: ["pain_job_post", "finance_hire"],
    geo_verifiable: false,
    price: "$0.00001/result + $0.00005/run (cheapest)",
    output: "Jobs aggregated across boards: company, title, description",
    input_template: { query: "Controller QuickBooks", location: "", country: "us", num_results: 30 },
    wired: true,
    enabled: false, // returns 0 results in testing — left off; re-enable to retry
    setup_note: "Actor currently returns no results in testing. Wired but off; Indeed + LinkedIn Jobs cover the same signal.",
  },
  google_maps: {
    actor_id: "compass/crawler-google-places",
    rank: 3,
    kind: "discovery",
    produces: ["new_location", "intent"],
    geo_verifiable: true, // the geo-hard-filtered source
    price: "$0.004/place",
    output: "Companies by category+geo: name, WEBSITE, address, state, category, phone",
    input_template: { searchStringsArray: [], locationQuery: "", maxCrawledPlacesPerSearch: 6, language: "en", skipClosedPlaces: true },
    wired: true,
    enabled: true,
  },
  linkedin_jobs: {
    actor_id: "curious_coder/linkedin-jobs-scraper",
    rank: 4,
    kind: "signal",
    produces: ["pain_job_post", "finance_hire"],
    geo_verifiable: false,
    price: "$0.001/result (2.6M runs — proven)",
    output: "LinkedIn job posts: company, title, description",
    input_template: { urls: [], scrapeCompany: true, count: 50 },
    wired: true,
    enabled: true,
    setup_note: "Input is LinkedIn Jobs search URLs — I'll build them from keyword+location (no login needed).",
  },
  career_sites: {
    actor_id: "fantastic-jobs/career-site-job-listing-api",
    rank: 5,
    kind: "signal",
    produces: ["pain_job_post", "hiring_velocity"],
    geo_verifiable: false,
    price: "$0.012/job (priciest job source)",
    output: "ATS jobs (Greenhouse/Lever/Ashby); can filter by company domain (watchlist monitoring)",
    input_template: { titleSearch: "", descriptionSearch: "", locationSearch: "", limit: 50, includeCompanyDetails: true, timeRange: "Last 7 days" },
    wired: true,
    enabled: true,
  },
  linkedin_posts: {
    actor_id: "apimaestro/linkedin-posts-search-scraper-no-cookies",
    rank: 6,
    kind: "signal",
    produces: ["funding", "m_and_a", "new_facility", "intent"],
    geo_verifiable: false,
    price: "$0.005/result (no cookies, 3.3M runs)",
    output: "LinkedIn posts: funding / M&A / new-office announcements",
    input_template: { keyword: "", date_filter: "past-month", limit: 30 },
    wired: true,
    enabled: true,
  },
  leads_finder: {
    actor_id: "code_crafter/leads-finder",
    rank: 7,
    kind: "discovery",
    produces: ["intent"],
    geo_verifiable: false,
    price: "$0.002/lead + $0.02/run",
    output: "Apollo-style company list + emails (industry/geo/size filters)",
    input_template: { company_industry: "", contact_location: "", size: "", fetch_count: 25 },
    wired: true,
    enabled: true, // unblocked: paid Apify (Starter) plan active
    setup_note: "Live on the paid Apify plan. Rotates industry × geo via the coverage tracker.",
  },
  sales_nav: {
    actor_id: "bestscrapers/linkedin-sales-navigator-scraper",
    rank: 8,
    kind: "discovery",
    produces: ["intent"],
    geo_verifiable: false,
    price: "$0.50/search + $0.01/result (expensive)",
    output: "Sales Navigator company/lead data",
    input_template: { sales_url: "", limit: 50 },
    wired: true,
    enabled: false,
    setup_note: "REQUIRES a Sales Navigator search URL → set SALES_NAV_URL in .env.local (build the search in your Sales Nav account, copy the URL).",
  },
  builtin_jobs: {
    actor_id: "shahidirfan/BuiltIn-Jobs-Scraper",
    rank: 9,
    kind: "signal",
    produces: ["pain_job_post", "tech_stack"],
    geo_verifiable: false,
    price: "$0.001/result",
    output: "BuiltIn (tech-startup) job posts — mostly off-territory",
    input_template: { keyword: "", location: "", results_wanted: 30 },
    wired: true,
    enabled: true, // kept on at user's request (accepts the $1/run floor)
    setup_note: "Has a $1.00/run MINIMUM charge; adapter pulls up to ~40 results per run to use that dollar.",
  },
};

/** Starter keyword job-search strings for the job actors (Indeed / Google Jobs / LinkedIn). */
export const DEFAULT_JOB_QUERIES: string[] = [
  "Controller QuickBooks",
  "revenue recognition NetSuite",
  "project accounting Controller",
  "multi-entity accounting manager",
  "dispatcher TMS billing",
  "logistics settlements accounting",
  "3PL warehouse controller",
  "fleet maintenance billing",
  "agency finance manager multi-entity",
  "media billing revenue recognition",
  "staffing back office QuickBooks",
  "facilities services controller",
];
