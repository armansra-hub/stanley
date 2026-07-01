import "server-only";
import { nextSlices } from "@/lib/ingest/coverage";
import { getPoolDomainsToCheck } from "@/lib/db/leadPool";
import { ERP_JOB_KEYWORDS, FINANCE_TITLES, LEADS_INDUSTRIES, TERRITORY_CITIES, MAPS_CATEGORIES } from "@/config/coverage";
import { GROWTH_SEARCH_URL } from "@/config/salesNav";
import { parseDateLoose } from "@/lib/time";
import type { Candidate } from "@/lib/ingest/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const snippet = (s?: unknown, n = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
// Pull a posting/event date from the many shapes the actors return.
const dateOf = (...vs: unknown[]): string | null => {
  for (const v of vs) { const d = parseDateLoose(v); if (d) return d; }
  return null;
};

// Minimum employee floor (ICP requires ~20+). Applied where the actor supports it.
const MIN_EMPLOYEES = 20;
// Sales Nav Growth budget starts this UTC date (next Monday) — it skips until then.
const GROWTH_START = "2026-06-29";
const pick1 = async (src: string, universe: string[]) => (await nextSlices(src, universe, 1))[0] ?? universe[0];

export interface ScheduledActor {
  key: string;
  actorId: string;
  maxItems: number;
  maxCharge?: number;
  /** Trigger this many async runs per day (each advances to a fresh slice). */
  burst?: number;
  /** Results go to the lead pool (un-enriched) instead of straight to companies. */
  toPool?: boolean;
  /** After ingest, mark the matched pool domains promoted (a signal was found). */
  promotePool?: boolean;
  buildInput: () => Promise<{ input: Record<string, unknown>; sliceKey: string; skip?: boolean }>;
  map: (items: Record<string, unknown>[]) => Candidate[];
}

/**
 * One source of truth per Apify actor for the hands-off scheduler: buildInput
 * pulls the NEXT coverage slice (no duplicate spend) and shapes the actor's
 * input to its own strength + the ERP/QuickBooks angles; map turns the finished
 * dataset into candidates. The webhook (/api/webhooks/apify) calls map.
 */
export const SCHEDULED: Record<string, ScheduledActor> = {
  // Cheap broad finance/ERP job signal — keyword × city.
  indeed: {
    key: "indeed",
    actorId: "valig/indeed-jobs-scraper",
    maxItems: 20,
    buildInput: async () => {
      const universe = ERP_JOB_KEYWORDS.flatMap((k) => TERRITORY_CITIES.map((c) => `${k}::${c}`));
      const sliceKey = await pick1("indeed", universe);
      const [title, location] = sliceKey.split("::");
      return { input: { country: "us", title, location, limit: 20, datePosted: "14" }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const emp = r.employer;
        const name = (typeof emp === "string" ? emp : (emp as any)?.name) ?? "";
        const link = str(r.jobUrl) ?? str(r.url);
        if (!name || !link) continue;
        const loc = typeof r.location === "string" ? r.location : "";
        const sd = dateOf(r.datePosted, r.postedAt, r.date, r.postedTimeStamp);
        out.push({ name: String(name).trim(), source: "discovered", sources: ["indeed"], signals: [{ source_name: "Indeed", source_url: link, signal_date: sd, raw_excerpt: `Indeed job post: "${r.title}" at ${name}${loc ? ` (${loc})` : ""}. ${snippet(r.description)}` }] });
      }
      return out;
    },
  },

  // Finance-leader roles WITH company website — ERP keyword rotation.
  linkedin_jobs: {
    key: "linkedin_jobs",
    actorId: "curious_coder/linkedin-jobs-scraper",
    maxItems: 15,
    buildInput: async () => {
      const sliceKey = await pick1("linkedin_jobs", ERP_JOB_KEYWORDS);
      const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(sliceKey)}&location=United%20States`;
      return { input: { urls: [url], count: 15, scrapeCompany: true }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        if (r.error) continue;
        const name = String(r.companyName ?? "").trim();
        const link = str(r.link) ?? str(r.applyUrl);
        if (!name || !link) continue;
        const sd = dateOf(r.postedAt, r.listedAt, r.postedDate, r.publishedAt);
        out.push({ name, website: str(r.companyWebsite), source: "discovered", sources: ["linkedin_jobs"], signals: [{ source_name: "LinkedIn Jobs", source_url: link, signal_date: sd, raw_excerpt: `LinkedIn job post: "${r.title}" at ${name}${r.location ? ` (${r.location})` : ""}. ${snippet(r.descriptionText)}` }] });
      }
      return out;
    },
  },

  // ATS finance hires + ERP/QuickBooks description search.
  career_sites: {
    key: "career_sites",
    actorId: "fantastic-jobs/career-site-job-listing-api",
    maxItems: 12,
    buildInput: async () => {
      const sliceKey = await pick1("career_sites", FINANCE_TITLES);
      return { input: { titleSearch: [sliceKey], descriptionSearch: ["QuickBooks", "ERP", "NetSuite", "revenue recognition"], locationSearch: ["United States"], limit: 12, includeCompanyDetails: true, liOrganizationEmployeesGte: MIN_EMPLOYEES }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const name = String(r.organization ?? "").trim();
        const link = str(r.url);
        if (!name || !link) continue;
        const loc = Array.isArray(r.locations_alt) ? (r.locations_alt as string[]).join(", ") : "";
        const sd = dateOf(r.date_posted, r.date_validfrom, r.date);
        out.push({ name, website: str(r.domain_derived) ?? str(r.org_linkedin_website), source: "discovered", sources: ["career_sites"], signals: [{ source_name: str(r.source) ?? "Career Site", source_url: link, signal_date: sd, raw_excerpt: `Open role "${r.title}" at ${name}${loc ? ` (${loc})` : ""} on the company career site. ${snippet(r.description_text)}` }] });
      }
      return out;
    },
  },

  // Real-time announcements (M&A / expansion / QuickBooks pain).
  linkedin_posts: {
    key: "linkedin_posts",
    actorId: "apimaestro/linkedin-posts-search-scraper-no-cookies",
    maxItems: 12,
    buildInput: async () => {
      // In-territory announcements only (no accounting/law/tax; 3PLs filtered later).
      const universe = ["staffing firm acquires", "marketing agency acquires", "company outgrew QuickBooks", "consulting firm new office", "media company acquires", "logistics company acquires", "agency wins new account", "moving company expands", "trucking company new terminal", "production company acquires"];
      const sliceKey = await pick1("linkedin_posts", universe);
      return { input: { keyword: sliceKey, limit: 12, date_filter: "past-month" }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const text = String(r.text ?? (r.content as any)?.text ?? r.content ?? "");
        const link = str(r.post_url);
        if (!text || !link) continue;
        const sd = dateOf(r.posted_at, (r.posted_at as any)?.date, r.postedAtISO, r.time, r.date);
        out.push({ name: snippet(text, 90), source: "discovered", sources: ["linkedin_posts"], signals: [{ source_name: "LinkedIn", source_url: link, signal_date: sd, raw_excerpt: snippet(text, 300) }] });
      }
      return out;
    },
  },

  // ICP firmographic discovery — industry rotation (needs paid Apify plan).
  leads_finder: {
    key: "leads_finder",
    actorId: "code_crafter/leads-finder",
    maxItems: 15,
    buildInput: async () => {
      const sliceKey = await pick1("leads_finder", LEADS_INDUSTRIES);
      return { input: { company_industry: [sliceKey], contact_location: ["united states", "canada"], fetch_count: 15 }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const name = String(r.company_name ?? r.organization_name ?? r.company ?? "").trim();
        if (!name) continue;
        out.push({ name, website: str(r.company_domain) ?? str(r.website), state: str(r.company_state) ?? null, source: "discovered", sources: ["leads_finder"], signals: [{ source_name: "Leads Finder", source_url: str(r.company_linkedin_url) ?? str(r.website) ?? "https://apify.com", raw_excerpt: `${name} — ${str(r.company_industry) ?? "territory"} company (firmographic discovery).` }] });
      }
      return out;
    },
  },

  // SMB breadth → the LEAD POOL (cheap, run a burst daily). No enrichment here;
  // the qualifier checks these domains for a real signal before promoting.
  google_maps: {
    key: "google_maps",
    actorId: "compass/crawler-google-places",
    maxItems: 10,
    // 15 bursts/day × 10 places × 7 days × $0.004 ≈ $4.20/wk (was ~$2.24 at 8) —
    // the extra ~$2/wk he approved for net-new Maps coverage, ~halving the time
    // to cycle the full city×category grid.
    burst: 15,
    toPool: true,
    buildInput: async () => {
      const universe = TERRITORY_CITIES.flatMap((c) => MAPS_CATEGORIES.map((cat) => `${c}::${cat}`));
      const sliceKey = await pick1("google_maps", universe);
      const [city, category] = sliceKey.split("::");
      return { input: { searchStringsArray: [category], locationQuery: city, maxCrawledPlacesPerSearch: 10, language: "en", skipClosedPlaces: true }, sliceKey };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const name = String(r.title ?? "").trim();
        if (!name) continue;
        out.push({ name, website: str(r.website), state: str(r.state) ?? null, city: str(r.city) ?? null, source: "discovered", sources: ["google_maps"], signals: [] });
      }
      return out;
    },
  },

  // QUALIFIER: check pooled Maps domains for a finance/ERP hiring signal via the
  // Career Sites domainFilter. Only companies with a hit get promoted (the map
  // attaches the finance-hire signal); the webhook then marks them promoted.
  career_sites_qualify: {
    key: "career_sites_qualify",
    actorId: "fantastic-jobs/career-site-job-listing-api",
    maxItems: 30,
    promotePool: true,
    buildInput: async () => {
      const domains = await getPoolDomainsToCheck(12);
      if (domains.length === 0) return { input: {}, sliceKey: "pool:empty", skip: true };
      return {
        input: { domainFilter: domains, titleSearch: FINANCE_TITLES, descriptionSearch: ["QuickBooks", "ERP", "NetSuite", "revenue recognition"], limit: 30, includeCompanyDetails: true, liOrganizationEmployeesGte: MIN_EMPLOYEES, liOrganizationEmployeesLte: 200 },
        sliceKey: `pool:${domains.length}`,
      };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const name = String(r.organization ?? "").trim();
        const link = str(r.url);
        if (!name || !link) continue;
        const sd = dateOf(r.date_posted, r.date_validfrom, r.date);
        out.push({ name, website: str(r.domain_derived) ?? str(r.org_linkedin_website), source: "discovered", sources: ["google_maps", "career_sites"], signals: [{ source_name: str(r.source) ?? "Career Site", source_url: link, signal_date: sd, raw_excerpt: `Pooled (Google Maps) company ${name} is hiring "${r.title}" — a finance/ERP role surfaced via the career-site qualifier. ${snippet(r.description_text)}` }] });
      }
      return out;
    },
  },

  // GROWTH — Sales Nav COMPANY search ($1-10M rev, 25%+ headcount growth, his
  // states + industries, ≥2 finance-dept). Single-phase, cookieless ($0.018/result,
  // 25/page ≈ $0.45/page). territory-trusted (his search already filtered). The
  // headcount-growth itself IS the signal.
  // BUDGET ~$10/week, THIS actor only: 3 pages/day × 7 = 21 pages/wk ≈ $9.45/wk;
  // maxCharge hard-caps each run at ~one page. Coverage rotation pages 1→12 so the
  // extra budget finds NEW companies (not re-pulls). HOLDS until GROWTH_START.
  sales_nav_growth: {
    key: "sales_nav_growth",
    actorId: "pratikdani/sales-navigator-company-search-scraper-no-cookies",
    maxItems: 25, // one page/run
    maxCharge: 0.5, // per-run cap (~one page); 3/day × 7 ≈ $10/wk ceiling
    burst: 3, // 3 pages/day
    buildInput: async () => {
      // Don't run before the budget start date (next Monday).
      if (new Date().toISOString().slice(0, 10) < GROWTH_START) {
        return { input: {}, sliceKey: `hold:until-${GROWTH_START}`, skip: true };
      }
      const page = await pick1("sales_nav_growth", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
      return { input: { url: GROWTH_SEARCH_URL, page: Number(page) }, sliceKey: `page:${page}` };
    },
    map: (items) => {
      const out: Candidate[] = [];
      for (const r of items) {
        const name = String(r.company_name ?? r.name ?? r.companyName ?? r.company ?? r.title ?? "").trim();
        if (!name) continue; // skips the actor's {message:"frozen…"} status items
        const website = str(r.website) ?? str(r.company_website) ?? str(r.websiteUrl) ?? str(r.domain);
        const link = str(r.linkedin_url) ?? str(r.company_url) ?? str(r.companyUrl) ?? str(r.url) ?? website ?? "https://www.linkedin.com";
        const industry = str(r.industry) ?? str(r.company_industry);
        const loc = str(r.location) ?? str(r.headquarters) ?? str(r.company_location) ?? str(r.hq);
        const emp = r.employee_count ?? r.employeeCount ?? r.company_size ?? r.size ?? r.staff_count;
        out.push({
          name,
          website: website ?? undefined,
          state: str(r.state) ?? null,
          source: "discovered",
          sources: ["sales_nav_growth"],
          trusted: true,
          signals: [{
            source_name: "Sales Navigator (Growth)",
            source_url: link,
            raw_excerpt:
              `${name}${industry ? ` — ${industry}` : ""}${loc ? `, ${loc}` : ""}${emp ? `, ~${emp} employees` : ""} ` +
              `surfaced in the Business Services TAM growth search: $1-10M revenue with 25%+ employee headcount growth (a hiring-velocity / expansion signal). ` +
              `${snippet(r.description ?? r.about ?? r.summary)}`,
          }],
        });
      }
      return out;
    },
  },
};

// REPURPOSED 2026-06-27: the base is now free CSV (NetSuite/ZoomInfo TAM), so the
// paid DISCOVERY actors (Google Maps breadth, leads_finder, Indeed/LinkedIn job
// scrapers, Sales Nav growth, qualifier) are retired from the schedule — they were
// finding leads we now get for free, and the Maps burst was the biggest spend.
// The paid budget moved to the TRIGGER engine (finance-hiring check on the base,
// lib/triggers/sweep.ts). Actor defs above are KEPT for manual ?actors= runs.
// Sales Nav NEW HIRES (a finance leader just hired = a trigger) still runs via the
// separate /api/cron/sales-nav (Mondays).
// 2026-06-27: ALL Sales Nav / paid scheduled actors OFF (AE's call). $0 Apify spend.
// Discovered is fed by the FREE sources only (/api/cron/discover: Google News, SEC
// EDGAR, USAspending, FMCSA, press) and the base by free CSV imports; the free
// trigger sweep (lib/triggers/sweep.ts) monitors the base. Sales Nav GROWTH def is
// KEPT above for manual ?actors=sales_nav_growth runs, but nothing is scheduled.
const DAILY_CORE: string[] = [];
export const WEEKLY_SCHEDULE: Record<number, string[]> = {
  0: [...DAILY_CORE], 1: [...DAILY_CORE], 2: [...DAILY_CORE], 3: [...DAILY_CORE],
  4: [...DAILY_CORE], 5: [...DAILY_CORE], 6: [...DAILY_CORE],
};
