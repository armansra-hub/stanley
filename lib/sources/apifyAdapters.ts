import "server-only";
import { runActor } from "@/lib/apify/run";
import { nextSlices, recordSlice } from "@/lib/ingest/coverage";
import { ERP_JOB_KEYWORDS, FINANCE_TITLES, LEADS_INDUSTRIES, TERRITORY_CITIES } from "@/config/coverage";
import { parseDateLoose } from "@/lib/time";
import type { Candidate } from "@/lib/ingest/types";

/* Apify actor adapters. Each rotates through a coverage universe (no duplicate
 * spend) and is tuned to its own strength + the ERP/QuickBooks buying angles.
 * Output fields verified live. */
/* eslint-disable @typescript-eslint/no-explicit-any */

const snippet = (s?: unknown, n = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const dateOf = (...vs: unknown[]): string | null => {
  for (const v of vs) { const d = parseDateLoose(v); if (d) return d; }
  return null;
};
const MIN_EMPLOYEES = 20; // ICP floor — only where the actor supports the filter.

// In-territory announcement phrases (no accounting/law/tax; 3PLs filtered later).
const POST_QUERIES = [
  "staffing firm acquires", "marketing agency acquires", "company outgrew QuickBooks",
  "consulting firm new office", "media company acquires", "logistics company acquires",
  "agency wins new account", "moving company expands", "trucking company new terminal",
  "production company acquires",
];

// ── #1 Indeed (valig) — $0.0001/result. Rotates ERP/finance keyword × city. ──
export async function fetchIndeedCandidates(opts: { slices?: number; maxItems?: number } = {}): Promise<Candidate[]> {
  const universe = ERP_JOB_KEYWORDS.flatMap((k) => TERRITORY_CITIES.map((c) => `${k}::${c}`));
  const slices = await nextSlices("indeed", universe, opts.slices ?? 2);
  const n = opts.maxItems ?? 20;
  const out: Candidate[] = [];
  for (const slice of slices) {
    const [title, location] = slice.split("::");
    try {
      const items = await runActor("valig/indeed-jobs-scraper", { country: "us", title, location, limit: n, datePosted: "14" }, n);
      let kept = 0;
      for (const r of items) {
        const emp = r.employer;
        const name = (typeof emp === "string" ? emp : (emp as any)?.name) ?? "";
        const link = str(r.jobUrl) ?? str(r.url);
        if (!name || !link) continue;
        const loc = typeof r.location === "string" ? r.location : "";
        out.push({ name: String(name).trim(), source: "discovered", sources: ["indeed"], signals: [{ source_name: "Indeed", source_url: link, signal_date: dateOf(r.datePosted, r.postedAt, r.date), raw_excerpt: `Indeed job post: "${r.title}" at ${name}${loc ? ` (${loc})` : ""}. ${snippet(r.description)}` }] });
        kept++;
      }
      await recordSlice("indeed", slice, kept);
    } catch {
      await recordSlice("indeed", slice, 0);
    }
  }
  return out;
}

// ── #2 Google Jobs (johnvc) — returns 0 in testing; wired, off. ──
export async function fetchGoogleJobsCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 10, 10);
  const slice = (await nextSlices("google_jobs", ERP_JOB_KEYWORDS, 1))[0] ?? "Controller QuickBooks";
  const out: Candidate[] = [];
  try {
    const items = await runActor("johnvc/Google-Jobs-Scraper", { query: slice, country: "us", num_results: n }, n);
    for (const r of items) {
      const name = String(r.company_name ?? r.company ?? r.employer ?? "").trim();
      const link = str(r.link) ?? str(r.url) ?? str(r.job_link);
      if (!name || !link) continue;
      out.push({ name, source: "discovered", sources: ["google_jobs"], signals: [{ source_name: "Google Jobs", source_url: link, raw_excerpt: `Google Jobs post: "${r.title}" at ${name}. ${snippet(r.description ?? r.snippet)}` }] });
    }
    await recordSlice("google_jobs", slice, out.length);
  } catch {
    await recordSlice("google_jobs", slice, 0);
  }
  return out;
}

// ── #4 LinkedIn Jobs (curious_coder) — $0.001/result. Rotates ERP keywords. ──
export async function fetchLinkedinJobsCandidates(opts: { slices?: number; maxItems?: number } = {}): Promise<Candidate[]> {
  const slices = await nextSlices("linkedin_jobs", ERP_JOB_KEYWORDS, opts.slices ?? 2);
  const n = Math.max(opts.maxItems ?? 12, 10);
  const out: Candidate[] = [];
  for (const kw of slices) {
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=United%20States`;
    try {
      const items = await runActor("curious_coder/linkedin-jobs-scraper", { urls: [url], count: n, scrapeCompany: true }, n);
      let kept = 0;
      for (const r of items) {
        if (r.error) continue;
        const name = String(r.companyName ?? "").trim();
        const link = str(r.link) ?? str(r.applyUrl);
        if (!name || !link) continue;
        out.push({ name, website: str(r.companyWebsite), source: "discovered", sources: ["linkedin_jobs"], signals: [{ source_name: "LinkedIn Jobs", source_url: link, signal_date: dateOf(r.postedAt, r.listedAt, r.postedDate), raw_excerpt: `LinkedIn job post: "${r.title}" at ${name}${r.location ? ` (${r.location})` : ""}. ${snippet(r.descriptionText)}` }] });
        kept++;
      }
      await recordSlice("linkedin_jobs", kw, kept);
    } catch {
      await recordSlice("linkedin_jobs", kw, 0);
    }
  }
  return out;
}

// ── #5 Career Sites / ATS (fantastic-jobs) — $0.012/job. Rotates finance title,
//    with ERP/QuickBooks description search. ──
export async function fetchCareerSitesCandidates(opts: { slices?: number; maxItems?: number } = {}): Promise<Candidate[]> {
  const slices = await nextSlices("career_sites", FINANCE_TITLES, opts.slices ?? 1);
  const n = Math.max(opts.maxItems ?? 12, 10);
  const out: Candidate[] = [];
  for (const title of slices) {
    try {
      const items = await runActor(
        "fantastic-jobs/career-site-job-listing-api",
        { titleSearch: [title], descriptionSearch: ["QuickBooks", "ERP", "NetSuite", "revenue recognition"], locationSearch: ["United States"], limit: n, includeCompanyDetails: true, liOrganizationEmployeesGte: MIN_EMPLOYEES },
        n,
      );
      let kept = 0;
      for (const r of items) {
        const name = String(r.organization ?? "").trim();
        const link = str(r.url);
        if (!name || !link) continue;
        const loc = Array.isArray(r.locations_alt) ? (r.locations_alt as string[]).join(", ") : "";
        out.push({ name, website: str(r.domain_derived) ?? str(r.org_linkedin_website), source: "discovered", sources: ["career_sites"], signals: [{ source_name: str(r.source) ?? "Career Site", source_url: link, signal_date: dateOf(r.date_posted, r.date_validfrom, r.date), raw_excerpt: `Open role "${r.title}" at ${name}${loc ? ` (${loc})` : ""} on the company career site. ${snippet(r.description_text)}` }] });
        kept++;
      }
      await recordSlice("career_sites", title, kept);
    } catch {
      await recordSlice("career_sites", title, 0);
    }
  }
  return out;
}

// ── #6 LinkedIn Posts (apimaestro) — $0.005/result. Rotates event phrases. ──
export async function fetchLinkedinPostsCandidates(opts: { slices?: number; maxItems?: number } = {}): Promise<Candidate[]> {
  const slices = await nextSlices("linkedin_posts", POST_QUERIES, opts.slices ?? 2);
  const n = opts.maxItems ?? 12;
  const out: Candidate[] = [];
  for (const keyword of slices) {
    try {
      const items = await runActor("apimaestro/linkedin-posts-search-scraper-no-cookies", { keyword, limit: n, date_filter: "past-month" }, n);
      let kept = 0;
      for (const r of items) {
        const text = String(r.text ?? (r.content as any)?.text ?? r.content ?? "");
        const link = str(r.post_url);
        if (!text || !link) continue;
        out.push({ name: snippet(text, 90), source: "discovered", sources: ["linkedin_posts"], signals: [{ source_name: "LinkedIn", source_url: link, signal_date: dateOf(r.posted_at, (r.posted_at as any)?.date, r.time, r.date), raw_excerpt: snippet(text, 300) }] });
        kept++;
      }
      await recordSlice("linkedin_posts", keyword, kept);
    } catch {
      await recordSlice("linkedin_posts", keyword, 0);
    }
  }
  return out;
}

// ── #7 Leads Finder (code_crafter) — needs PAID Apify plan. Rotates industry. ──
export async function fetchLeadsFinderCandidates(opts: { slices?: number; maxItems?: number } = {}): Promise<Candidate[]> {
  const slices = await nextSlices("leads_finder", LEADS_INDUSTRIES, opts.slices ?? 1);
  const n = Math.max(opts.maxItems ?? 10, 10);
  const out: Candidate[] = [];
  for (const industry of slices) {
    try {
      const items = await runActor("code_crafter/leads-finder", { company_industry: [industry], contact_location: ["united states", "canada"], fetch_count: n }, n);
      let kept = 0;
      for (const r of items) {
        const name = String(r.company_name ?? r.organization_name ?? r.company ?? "").trim();
        if (!name) continue;
        out.push({ name, website: str(r.company_domain) ?? str(r.website), state: str(r.company_state) ?? null, source: "discovered", sources: ["leads_finder"], signals: [{ source_name: "Leads Finder", source_url: str(r.company_linkedin_url) ?? str(r.website) ?? "https://apify.com", raw_excerpt: `${name} — ${industry} company in the territory (firmographic discovery).` }] });
        kept++;
      }
      await recordSlice("leads_finder", industry, kept);
    } catch {
      await recordSlice("leads_finder", industry, 0);
    }
  }
  return out;
}

// ── #8 Sales Navigator (bestscrapers) — needs SALES_NAV_URL. ──
export async function fetchSalesNavCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const salesUrl = process.env.SALES_NAV_URL;
  if (!salesUrl) return [];
  const n = opts.maxItems ?? 25;
  const items = await runActor("bestscrapers/linkedin-sales-navigator-scraper", { sales_url: salesUrl, limit: n }, n);
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company_name ?? r.companyName ?? r.name ?? "").trim();
    if (!name) continue;
    out.push({ name, website: str(r.company_website) ?? str(r.website), source: "discovered", sources: ["sales_nav"], signals: [{ source_name: "LinkedIn Sales Navigator", source_url: str(r.company_linkedin_url) ?? str(r.profile_url) ?? "https://linkedin.com", raw_excerpt: `${name} — surfaced via a Sales Navigator targeted search.` }] });
  }
  return out;
}

// ── #9 BuiltIn (shahidirfan) — $1.00/run minimum. ──
export async function fetchBuiltinCandidates(opts: { maxItems?: number } = {}): Promise<Candidate[]> {
  const n = Math.max(opts.maxItems ?? 40, 10);
  const keyword = (await nextSlices("builtin_jobs", ["Controller", "Accounting Manager", "Revenue Accountant", "FP&A"], 1))[0] ?? "Controller";
  const items = await runActor("shahidirfan/BuiltIn-Jobs-Scraper", { keyword, location: "United States", results_wanted: n }, n, 1.0);
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company ?? r.companyName ?? r.organization ?? "").trim();
    const link = str(r.job_url) ?? str(r.url) ?? str(r.link);
    if (!name || !link) continue;
    out.push({ name, source: "discovered", sources: ["builtin_jobs"], signals: [{ source_name: "BuiltIn", source_url: link, signal_date: dateOf(r.date_posted, r.postedAt, r.date), raw_excerpt: `BuiltIn job post: "${r.title}" at ${name}. ${snippet(r.description)}` }] });
  }
  await recordSlice("builtin_jobs", keyword, out.length);
  return out;
}
