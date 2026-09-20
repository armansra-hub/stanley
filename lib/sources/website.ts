import "server-only";
import { extractAcquisitions } from "@/lib/sources/acquisition";
import { extractGrowthSignals } from "@/lib/sources/growth";
import { scanFinanceRoles } from "@/lib/sources/careers";
import { isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { publicResponseOutcome, sourceErrorCode, type SourceUrlOutcome } from "./outcomes";
import { fetchConditionalText, responseValidators, retainedValidators, type HttpValidators } from "./conditionalFetch";
import { companyPageUrl, discoverSiteLinks, htmlAttributes, htmlToVisibleText, sameCompanySite, sitePageEvidence, sitePageKind, sitemapLocations, type SitePageEvidence } from "./siteDiscovery";

/**
 * Company-website growth-signal reader (FREE). Fetches a claimable company's own
 * site (homepage + a couple announcement pages) and extracts a small set of strong
 * GROWTH phrases — a new office/location, a new division/subsidiary, or an
 * acquisition THEY made. The sweep compares this set run-over-run and fires a
 * trigger only when a NEW phrase appears, so incidental page changes don't create
 * noise. Conservative on purpose (no generic "we're hiring").
 */
// Growth phrases moved to lib/sources/growth.ts (2026-07-30). The old inline
// patterns matched company-description boilerplate — "expanding into their
// wholeness", "we relish the opportunity to expand into other industries" — because
// they required only the phrase, never evidence of an actual event.

// Raw HTML (case preserved) — for parent-name capture + RSS-link discovery.
export type WebsiteCacheEntry = { finalUrl: string; validators?: HttpValidators; discoveredUrls: string[]; feedUrl: string | null; retained: boolean };
export function readWebsiteCache(value: unknown, base: string): Record<string, WebsiteCacheEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(-24).flatMap(([url, raw]) => {
    if (!sameCompanySite(url, base) || !raw || typeof raw !== "object") return [];
    const entry = raw as WebsiteCacheEntry;
    if (!sameCompanySite(entry.finalUrl, base) || entry.retained !== true) return [];
    return [[url, { finalUrl: entry.finalUrl, retained: true, validators: retainedValidators(entry.validators, url),
      discoveredUrls: Array.isArray(entry.discoveredUrls) ? entry.discoveredUrls.filter(link => typeof link === "string" && sameCompanySite(link, base)).slice(0, 24) : [],
      feedUrl: typeof entry.feedUrl === "string" && sameCompanySite(entry.feedUrl, base) ? entry.feedUrl : null }]];
  }));
}
interface FetchedPage { html: string; finalUrl: string; status: number | null; outcome: SourceUrlOutcome; notModified?: boolean; validators?: HttpValidators; previous?: WebsiteCacheEntry }

async function fetchPage(url: string, ms = 7000, previous?: WebsiteCacheEntry): Promise<FetchedPage> {
  try {
    const response = await fetchConditionalText(url, {
      timeoutMs: ms,
      maxBytes: 4_000_000,
      accept: "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9",
    }, previous);
    if (response.status === 304 && previous?.retained) return { html: "", finalUrl: previous.finalUrl, status: 304,
      outcome: { url, outcome: "success", status: 304 }, notModified: true, previous, validators: previous.validators };
    const outcome = publicResponseOutcome(url, response.status, response.body);
    return { html: outcome.outcome === "success" ? response.body : "", finalUrl: response.finalUrl, status: response.status, outcome, validators: responseValidators(response) };
  } catch (error) { return { html: "", finalUrl: url, status: null, outcome: { url, outcome: "unavailable", code: sourceErrorCode(error) } }; }
}
const cleanHtml = htmlToVisibleText;

// Parent-company phrases. HIGH = explicit ownership; LOW = soft affiliation.
const PARENT_HIGH = /\b(?:a\s+(?:wholly[-\s]owned\s+)?subsidiary\s+of|a\s+division\s+of|wholly[-\s]owned\s+by|acquired\s+by|now\s+part\s+of)\s+([A-Z][\w&.,'-]*(?:\s+[A-Z0-9][\w&.,'-]*){0,3})/;
const PARENT_LOW = /\b(?:part\s+of\s+the|owned\s+by|a\s+portfolio\s+company\s+of|backed\s+by|member\s+of\s+the)\s+([A-Z][\w&.,'-]*(?:\s+[A-Z0-9][\w&.,'-]*){0,3})/;
function detectParent(rawText: string): { name: string; confidence: "high" | "low" } | null {
  const h = rawText.match(PARENT_HIGH); if (h?.[1]) return { name: h[1].replace(/[.,]$/, "").trim().slice(0, 80), confidence: "high" };
  const l = rawText.match(PARENT_LOW); if (l?.[1]) return { name: l[1].replace(/[.,]$/, "").trim().slice(0, 80), confidence: "low" };
  return null;
}

// Discover the site's RSS/Atom feed URL from homepage HTML, else common paths.
function findFeedUrl(html: string, base: string): string | null {
  for (const match of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    if (!attrs.href || !(/application\/(?:rss|atom)\+xml/i.test(attrs.type ?? "") || /\/(?:feed|rss)(?:\/|\.xml|$)/i.test(attrs.href))) continue;
    const url = companyPageUrl(attrs.href, base);
    if (url) return url;
  }
  return null;
}

// Recruiting/staffing CLIENT-PLACEMENT-BOARD language — these roles are being filled
// FOR A CLIENT, not the company's own headcount. High-precision phrases that ~never
// appear on a company's own internal careers page. We DON'T exclude staffing firms;
// we just skip pages that read as a client board, so a staffing firm's OWN finance
// hire (posted with normal "join our team" language) still counts.
const CLIENT_BOARD_RE = /\b(our client|on behalf of (?:a|our) client|client is (?:seeking|looking|hiring)|for (?:a|our) client|direct[- ]hire(?: opportunit| position| role)|temp(?:orary)?[- ]to[- ]perm|contract[- ]to[- ]hire|submit your resume to|placing (?:candidates|talent)|recruiting (?:for|on behalf of)|now recruiting a|seeking candidates for)\b/;
function looksLikeClientBoard(text: string): boolean {
  return CLIENT_BOARD_RE.test(text.toLowerCase());
}

/** A finance opening we verified, with the page and the line that proves it. */
export interface FinanceRoleHit { role: string; snippet: string; url: string }

export interface SiteScan {
  growth: { type: "press" | "new_entity" | "ma"; label: string; snippet?: string }[];
  parent: { name: string; confidence: "high" | "low" } | null;
  feedUrl: string | null;
  financeRoles: FinanceRoleHit[];
  pages: SitePageEvidence[];
  discoveredUrls: string[];
  httpCache?: Record<string, WebsiteCacheEntry>;
  coverage: { attemptedUrls: string[]; succeededUrls: string[]; remainingUrls: string[]; failedUrls?: string[]; urlOutcomes?: SourceUrlOutcome[]; notModifiedUrls?: string[] };
}

/** Bounded link/sitemap discovery, with legacy paths only as fallbacks. */
export async function fetchSiteSignals(domain: string, companyName?: string, options: { knownUrls?: string[]; maxPages?: number; mode?: "baseline" | "deep"; httpCache?: Record<string, WebsiteCacheEntry> } = {}): Promise<SiteScan> {
  const base = `https://${domain.replace(/\/+$/, "")}`;
  const baseline = options.mode === "baseline";
  const maxPages = baseline ? 2 : Number.isFinite(options.maxPages) ? Math.max(1, Math.min(10, Math.floor(options.maxPages!))) : 8;
  const attemptedUrls = [base];
  const failedUrls: string[] = [];
  const cache = options.httpCache ?? {};
  const cached = (url: string) => cache[url] ?? cache[new URL(url).toString()];
  const homePage = await fetchPage(base, 5000, cached(base));
  const urlOutcomes: SourceUrlOutcome[] = [sameCompanySite(homePage.finalUrl, base) ? homePage.outcome : { url: base, outcome: "unavailable", code: "cross_company_redirect" }];
  const empty: SiteScan = { growth: [], parent: null, feedUrl: null, financeRoles: [], pages: [], discoveredUrls: [], coverage: { attemptedUrls, succeededUrls: [], remainingUrls: [], failedUrls: [base], urlOutcomes } };
  if ((!homePage.html && !homePage.notModified) || !sameCompanySite(homePage.finalUrl, base)) return empty;
  const pages = [homePage];
  const candidates = new Map<string, string>();
  const add = (rawUrl: string, kind?: string) => {
    const url = companyPageUrl(rawUrl, base);
    if (url && url !== new URL(homePage.finalUrl).toString()) candidates.set(url, kind ?? sitePageKind(url) ?? "about");
  };
  for (const link of discoverSiteLinks(homePage.html, homePage.finalUrl)) add(link.url, link.kind);
  for (const url of homePage.previous?.discoveredUrls ?? []) add(url);
  for (const url of (options.knownUrls ?? []).slice(0, 40)) add(url);

  // Fetch at most a root sitemap plus two relevant child maps. This is discovery,
  // never a claim that the site's entire sitemap or article history was covered.
  if (!baseline) {
  const sitemapUrl = new URL("/sitemap.xml", homePage.finalUrl).toString();
  const sitemap = await fetchPage(sitemapUrl, 3500);
  if (sameCompanySite(sitemap.finalUrl, base)) {
    if (/<sitemapindex\b/i.test(sitemap.html)) {
      const children = sitemapLocations(sitemap.html, base)
        .sort((a, b) => Number(/post|news|page|career/i.test(b)) - Number(/post|news|page|career/i.test(a))).slice(0, 2);
      for (const child of await Promise.all(children.map((url) => fetchPage(url, 3000)))) {
        if (!sameCompanySite(child.finalUrl, base)) continue;
        for (const url of sitemapLocations(child.html, base)) if (sitePageKind(url)) add(url);
      }
    } else {
      for (const url of sitemapLocations(sitemap.html, base)) if (sitePageKind(url)) add(url);
    }
  }
  const discoveredKinds = new Set(candidates.values());
  for (const [path, kind] of [["about", "about"], ["news", "news"], ["careers", "careers"], ["jobs", "careers"]]) {
    if (!discoveredKinds.has(kind)) add(`${base}/${path}`, kind);
  }
  }
  // One representative page per category precedes additional pages. A newsroom
  // with hundreds of links must not crowd out careers or location evidence.
  const chosen: string[] = [];
  for (const kind of baseline ? ["services", "about", "locations", "news", "careers"] : ["news", "careers", "about", "locations", "services"]) {
    const first = [...candidates].find(([, value]) => value === kind)?.[0];
    if (first) chosen.push(first);
  }
  const firstWave = [...new Set([...chosen, ...candidates.keys()])].slice(0, Math.min(5, maxPages - 1));
  attemptedUrls.push(...firstWave);
  for (const { url, page } of await Promise.all(firstWave.map(async (url) => ({ url, page: await fetchPage(url, 4000, cached(url)) })))) {
    urlOutcomes.push(sameCompanySite(page.finalUrl, base) ? page.outcome : { url, outcome: "unavailable", code: "cross_company_redirect" });
    if ((page.html || page.notModified) && sameCompanySite(page.finalUrl, base)) pages.push(page);
    else if (page.status === 404 || page.status === 410) candidates.delete(url);
    else failedUrls.push(url);
  }
  for (const page of pages.slice(1)) {
    for (const link of discoverSiteLinks(page.html, page.finalUrl)) add(link.url, link.kind);
    for (const url of page.previous?.discoveredUrls ?? []) add(url);
  }
  const nextWave = [...candidates.keys()].filter((url) => !attemptedUrls.includes(url)).slice(0, Math.max(0, maxPages - attemptedUrls.length));
  attemptedUrls.push(...nextWave);
  for (const { url, page } of await Promise.all(nextWave.map(async (url) => ({ url, page: await fetchPage(url, 3500, cached(url)) })))) {
    urlOutcomes.push(sameCompanySite(page.finalUrl, base) ? page.outcome : { url, outcome: "unavailable", code: "cross_company_redirect" });
    if ((page.html || page.notModified) && sameCompanySite(page.finalUrl, base)) pages.push(page);
    else if (page.status === 404 || page.status === 410) candidates.delete(url);
    else failedUrls.push(url);
  }
  const evidenceByUrl = new Map<string, SitePageEvidence>();
  for (const page of pages) {
    if (page.notModified) continue; // Existing observation remains the evidence.
    const captured = sitePageEvidence(page.html, page.finalUrl);
    captured.requestedUrls = [...new Set([...(evidenceByUrl.get(page.finalUrl)?.requestedUrls ?? []), page.outcome.url])].sort();
    evidenceByUrl.set(page.finalUrl, captured);
  }
  const evidence = [...evidenceByUrl.values()];
  const rawText = evidence.filter((page) => !isCareerEvidenceUrl(page.url)).map((page) => page.text).join(" ");
  const growth: { type: "press" | "new_entity" | "ma"; label: string; snippet?: string }[] = [];
  if (rawText.trim()) {
    // Growth phrases must read as a reported EVENT (announcement verb, date, or place),
    // not company-description boilerplate — see lib/sources/growth.ts.
    for (const g of extractGrowthSignals(rawText)) growth.push(g);
    // Acquisitions THEY made — only with a named target, acquirer-position, guarded.
    for (const a of extractAcquisitions(rawText, companyName)) {
      growth.push({ type: "ma", label: `acquired ${a.target}`, snippet: a.snippet });
    }
  }

  // Careers scanned PER-PAGE (kept out of the growth text). A page that reads as a
  // recruiting CLIENT BOARD (staffing firm posting roles for clients) is skipped — those
  // aren't the company's own hires. A staffing firm's OWN finance hire on a normal
  // careers page (no client-board language) still counts.
  const homeText = cleanHtml(homePage.html);
  const financeRoles: FinanceRoleHit[] = [];
  const seenRoles = new Set<string>();
  for (const { url: pageUrl, text: pageText } of evidence) {
    if (!pageText || !isCareerEvidenceUrl(pageUrl) || looksLikeClientBoard(pageText)) continue;
    // requireJobPage rejects the soft-404 case where /careers serves the homepage,
    // and drops role words that are the firm's own service offering.
    for (const hit of scanFinanceRoles(pageText, { homeText })) {
      if (seenRoles.has(hit.role)) continue;
      seenRoles.add(hit.role);
      financeRoles.push({ ...hit, url: pageUrl }); // the page we actually verified
    }
  }
  return {
    growth,
    parent: detectParent([homeText, ...evidence.filter((page) => sitePageKind(page.url) === "about").map((page) => page.text)].join(" ")),
    feedUrl: pages.map((page) => page.previous?.feedUrl ?? findFeedUrl(page.html, page.finalUrl)).find(Boolean) ?? null,
    financeRoles, pages: evidence, discoveredUrls: [...candidates.keys()],
    httpCache: Object.fromEntries(pages.map(page => [page.outcome.url, page.previous ?? { finalUrl: page.finalUrl, validators: page.validators,
      discoveredUrls: discoverSiteLinks(page.html, page.finalUrl).map(link => link.url).slice(0, 24), feedUrl: findFeedUrl(page.html, page.finalUrl), retained: false }])),
    coverage: { attemptedUrls, succeededUrls: pages.map((page) => page.finalUrl), notModifiedUrls: pages.filter(page => page.notModified).map(page => page.finalUrl), remainingUrls: [...candidates.keys()].filter((url) => !attemptedUrls.includes(url)), failedUrls, urlOutcomes },
  };
}
