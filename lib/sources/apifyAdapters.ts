import "server-only";
import { runActor } from "@/lib/apify/run";
import { DEFAULT_JOB_QUERIES } from "@/config/actors";
import type { Candidate } from "@/lib/ingest/types";

/* Apify actor adapters (output fields verified live). Job/post actors are
 * name-or-website signals; the orchestrator classifies + dedupes. Each self-caps
 * maxItems to bound pay-per-result spend. */
/* eslint-disable @typescript-eslint/no-explicit-any */

const rand = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const snippet = (s?: unknown, n = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

// Indeed needs a city-format location (state/"United States" return nothing).
const TERRITORY_CITIES = [
  "Dallas, TX", "Houston, TX", "Denver, CO", "Phoenix, AZ", "Seattle, WA", "Chicago, IL",
  "Minneapolis, MN", "Salt Lake City, UT", "Portland, OR", "Las Vegas, NV", "Kansas City, MO",
  "Oklahoma City, OK", "Milwaukee, WI", "Des Moines, IA", "Albuquerque, NM", "Tucson, AZ",
];
const FINANCE_TITLES = ["Controller", "CFO", "VP Finance", "Accounting Manager", "Revenue Accountant", "FP&A Manager"];
const POST_KEYWORDS = [
  "staffing firm acquires", "accounting firm acquires", "logistics company acquires",
  "marketing agency acquires", "company outgrew QuickBooks", "opens new warehouse",
];

// ── #1 Indeed (valig) — $0.0001/result ──
export async function fetchIndeedCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = opts.maxItems ?? 20;
  const title = rand(DEFAULT_JOB_QUERIES);
  const location = rand(TERRITORY_CITIES);
  const items = await runActor("valig/indeed-jobs-scraper", { country: "us", title, location, limit: n }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    const emp = r.employer;
    const name = (typeof emp === "string" ? emp : (emp as any)?.name) ?? "";
    const link = str(r.jobUrl) ?? str(r.url);
    if (!name || !link) continue;
    const loc = typeof r.location === "string" ? r.location : "";
    out.push({
      name: String(name).trim(),
      source: "discovered",
      sources: ["indeed"],
      signals: [{ source_name: "Indeed", source_url: link, raw_excerpt: `Indeed job post: "${r.title}" at ${name}${loc ? ` (${loc})` : ""}. ${snippet(r.description)}` }],
    });
  }
  return out;
}

// ── #2 Google Jobs (johnvc) — $0.00001/result. Currently returns 0; wired, off. ──
export async function fetchGoogleJobsCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 10, 10);
  const query = rand(DEFAULT_JOB_QUERIES);
  const items = await runActor("johnvc/Google-Jobs-Scraper", { query, country: "us", num_results: n }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company_name ?? r.company ?? r.employer ?? "").trim();
    const link = str(r.link) ?? str(r.url) ?? str(r.job_link);
    if (!name || !link) continue;
    out.push({ name, source: "discovered", sources: ["google_jobs"], signals: [{ source_name: "Google Jobs", source_url: link, raw_excerpt: `Google Jobs post: "${r.title}" at ${name}. ${snippet(r.description ?? r.snippet)}` }] });
  }
  return out;
}

// ── #4 LinkedIn Jobs (curious_coder) — $0.001/result (needs ≥10) ──
export async function fetchLinkedinJobsCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 15, 10);
  const kw = rand(DEFAULT_JOB_QUERIES);
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=United%20States`;
  const items = await runActor("curious_coder/linkedin-jobs-scraper", { urls: [url], count: n, scrapeCompany: true }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    if (r.error) continue;
    const name = String(r.companyName ?? "").trim();
    const link = str(r.link) ?? str(r.applyUrl);
    if (!name || !link) continue;
    out.push({
      name,
      website: str(r.companyWebsite),
      source: "discovered",
      sources: ["linkedin_jobs"],
      signals: [{ source_name: "LinkedIn Jobs", source_url: link, raw_excerpt: `LinkedIn job post: "${r.title}" at ${name}${r.location ? ` (${r.location})` : ""}. ${snippet(r.descriptionText)}` }],
    });
  }
  return out;
}

// ── #5 Career Sites / ATS (fantastic-jobs) — $0.012/job ──
export async function fetchCareerSitesCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 12, 10);
  const title = rand(FINANCE_TITLES);
  const items = await runActor(
    "fantastic-jobs/career-site-job-listing-api",
    { titleSearch: [title], locationSearch: ["United States"], limit: n, includeCompanyDetails: true },
    n,
  );
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.organization ?? "").trim();
    const link = str(r.url);
    if (!name || !link) continue;
    const loc = Array.isArray(r.locations_alt) ? (r.locations_alt as string[]).join(", ") : "";
    out.push({
      name,
      website: str(r.domain_derived) ?? str(r.org_linkedin_website),
      source: "discovered",
      sources: ["career_sites"],
      signals: [{ source_name: str(r.source) ?? "Career Site", source_url: link, raw_excerpt: `Open role "${r.title}" at ${name}${loc ? ` (${loc})` : ""} on the company career site. ${snippet(r.description_text)}` }],
    });
  }
  return out;
}

// ── #6 LinkedIn Posts (apimaestro, no cookies) — $0.005/result ──
export async function fetchLinkedinPostsCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = opts.maxItems ?? 15;
  const keyword = rand(POST_KEYWORDS);
  const items = await runActor("apimaestro/linkedin-posts-search-scraper-no-cookies", { keyword, limit: n, date_filter: "past-month" }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    const text = String(r.text ?? (r.content as any)?.text ?? r.content ?? "");
    const link = str(r.post_url);
    if (!text || !link) continue;
    out.push({ name: snippet(text, 90), source: "discovered", sources: ["linkedin_posts"], signals: [{ source_name: "LinkedIn", source_url: link, raw_excerpt: snippet(text, 300) }] });
  }
  return out;
}

// ── #7 Leads Finder (code_crafter) — needs console permission approval; off ──
export async function fetchLeadsFinderCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 10, 10);
  const industry = rand([
    "accounting", "staffing & recruiting", "management consulting", "transportation/trucking/railroad",
    "marketing & advertising", "facilities services", "legal services", "logistics & supply chain",
    "law practice", "media production", "broadcast media", "publishing", "translation & localization",
  ]);
  // Ready to run as-is once on a paid Apify plan (free plan = UI-only).
  const items = await runActor(
    "code_crafter/leads-finder",
    { company_industry: [industry], contact_location: ["united states", "canada"], fetch_count: n },
    n,
  );
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company_name ?? r.organization_name ?? r.company ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      website: str(r.company_domain) ?? str(r.website),
      state: str(r.company_state) ?? null,
      source: "discovered",
      sources: ["leads_finder"],
      signals: [{ source_name: "Leads Finder", source_url: str(r.company_linkedin_url) ?? str(r.website) ?? "https://apify.com", raw_excerpt: `${name} — ${industry} company in the territory (firmographic discovery).` }],
    });
  }
  return out;
}

// ── #8 Sales Navigator (bestscrapers) — $0.50/search; needs SALES_NAV_URL; off ──
export async function fetchSalesNavCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const salesUrl = process.env.SALES_NAV_URL;
  if (!salesUrl) return []; // requires a Sales Navigator search URL
  const n = opts.maxItems ?? 25;
  const items = await runActor("bestscrapers/linkedin-sales-navigator-scraper", { sales_url: salesUrl, limit: n }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company_name ?? r.companyName ?? r.name ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      website: str(r.company_website) ?? str(r.website),
      source: "discovered",
      sources: ["sales_nav"],
      signals: [{ source_name: "LinkedIn Sales Navigator", source_url: str(r.company_linkedin_url) ?? str(r.profile_url) ?? "https://linkedin.com", raw_excerpt: `${name} — surfaced via a Sales Navigator targeted search.` }],
    });
  }
  return out;
}

// ── #9 BuiltIn (shahidirfan) — $1.00/run minimum. Since the $1 is a floor,
//    pull more per run so the dollar isn't wasted ($0.001/result → ~1000 fit
//    under $1). We pass maxTotalChargeUsd=1 so the actor accepts the run. ──
export async function fetchBuiltinCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 40, 10);
  const keyword = rand(["Controller", "Accounting Manager", "Revenue Accountant", "FP&A"]);
  const items = await runActor("shahidirfan/BuiltIn-Jobs-Scraper", { keyword, location: "United States", results_wanted: n }, n, 1.0);
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company ?? r.companyName ?? r.organization ?? "").trim();
    const link = str(r.job_url) ?? str(r.url) ?? str(r.link);
    if (!name || !link) continue;
    out.push({ name, source: "discovered", sources: ["builtin_jobs"], signals: [{ source_name: "BuiltIn", source_url: link, raw_excerpt: `BuiltIn job post: "${r.title}" at ${name}. ${snippet(r.description)}` }] });
  }
  return out;
}
