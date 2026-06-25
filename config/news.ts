import { NEWS_TRIGGERS } from "./signals";

/**
 * News & press-release sources — all FREE (no scraper). We fetch and parse the
 * XML directly. These surface funding / M&A / new-entity / new-facility /
 * new-service-line / finance-hire announcements. Company-name extraction from a
 * headline is assisted by the LLM step, which keeps the source_url on every
 * claim (hard rule: never fabricate).
 */

/** Build a Google News RSS URL for a free-text query, biased to US/English. */
export function googleNewsRss(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Broad discovery queries — covers the territory verticals (Communications /
 * Media / Advertising, Professional & Business Services, Transportation /
 * Logistics) crossed with the trigger events we care about (M&A, expansion,
 * capital, finance-leader hires, QuickBooks→ERP). Google News already
 * aggregates Business Wire / PR Newswire / GlobeNewswire releases, so this
 * stands in for the Business Wire filters (Communications, Professional
 * Services, Transport, US). Overlap is fine — the adapter dedupes by article.
 */
export const DISCOVERY_QUERIES: string[] = [
  // ── M&A / acquisitions ──
  "accounting firm acquires", "accounting firm acquired", "CPA firm merger", "tax advisory firm acquires",
  "consulting firm acquires", "management consulting firm acquired", "advisory firm acquires",
  "law firm merges", "law firm combination",
  "staffing firm acquires", "staffing agency acquired", "recruiting firm acquires", "HR services company acquires",
  "facilities management company acquires", "janitorial company acquired", "commercial cleaning company acquires",
  "document management company acquires", "translation company acquires",
  "advertising agency acquires", "marketing agency acquired", "creative agency acquires", "digital agency acquires",
  "media company acquires", "PR firm acquires", "public relations agency acquires", "communications firm acquires",
  "publisher acquires", "broadcasting company acquires",
  "logistics company acquires", "3PL acquires", "freight company acquired", "trucking company acquires",
  "carrier acquires", "moving company acquires", "transportation company acquired", "warehousing company acquires",
  // ── Expansion / new facilities ──
  "logistics company opens new warehouse", "3PL new distribution center", "trucking company new terminal",
  "carrier adds new lane", "staffing firm opens new office", "accounting firm opens new office",
  "consulting firm expands", "agency opens new office", "company opens new headquarters",
  // ── Capital / PE ──
  "staffing firm private equity", "accounting firm private equity investment", "logistics company private equity",
  "marketing agency private equity", "consulting firm recapitalization", "transportation company funding round",
  // ── Finance leadership / ERP pain ──
  "company appoints chief financial officer", "names new controller", "company outgrew QuickBooks",
  "implements NetSuite ERP", "company hires VP of finance",
];

/**
 * Google News queries = the per-vertical trigger terms (config/signals.ts).
 * Cross-vertical terms run for everyone; vertical terms run for their vertical.
 * Expand freely or narrow by adding subindustry names to a term.
 */
export const NEWS_QUERIES: string[] = [
  ...NEWS_TRIGGERS.cross,
  ...NEWS_TRIGGERS.business_services,
  ...NEWS_TRIGGERS.transportation,
];

/** Ready-to-fetch Google News RSS feed URLs. */
export const NEWS_RSS_FEEDS: string[] = NEWS_QUERIES.map(googleNewsRss);

export interface PressReleaseFeed {
  name: string;
  /** Direct RSS/Atom URL. Some require choosing a category/keyword first — see note. */
  url: string;
  enabled: boolean;
  note?: string;
}

/**
 * Press-release wires — free RSS by category or keyword. The URLs below are the
 * discoverable defaults; we'll swap in the exact category/keyword feeds during
 * source tuning (same "needs review" status as the Apify actors).
 */
export const PRESS_RELEASE_FEEDS: PressReleaseFeed[] = [
  {
    name: "PR Newswire",
    url: "https://www.prnewswire.com/rss/news-releases-list.rss",
    enabled: true, // verified working
    note: "Free main news feed. Add topic feeds from prnewswire.com/rss for more precision.",
  },
  {
    name: "GlobeNewswire",
    url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire---News-about-Public-Companies",
    enabled: true, // verified working
    note: "Free category RSS. Swap in a more relevant category feed from globenewswire.com if desired.",
  },
  {
    name: "Business Wire",
    url: "", // <FILL: the generic home feed is non-English. Generate your topic feed:
    //  businesswire.com → News → choose industries/subjects → copy the RSS link → paste here, set enabled:true.
    enabled: false,
    note: "Needs your topic-feed URL — the generic Business Wire home feed returns French news.",
  },
];

/**
 * Headline prefilter for the firehose press feeds — only items whose title hits
 * one of these trigger terms get an AI call (controls cost + raises precision).
 */
export const PRESS_KEYWORDS: string[] = [
  "acquire", "acquisition", "acquires", "acquired", "merger", "merges", "to buy",
  "funding", "raises", "series a", "series b", "private equity", "recapitaliz",
  "new office", "opens", "expands", "expansion", "new headquarters", "relocat",
  "new warehouse", "distribution center", "new terminal", "new facility", "new lane",
  "appoints", "names cfo", "names controller", "hires", "chief financial officer",
  "launches", "new practice", "new service", "new division", "fleet",
];
