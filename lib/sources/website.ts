import "server-only";
import { extractAcquisitions } from "@/lib/sources/acquisition";
import { extractGrowthSignals } from "@/lib/sources/growth";
import { scanFinanceRoles } from "@/lib/sources/careers";
import { isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";

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
interface FetchedPage { html: string; finalUrl: string }

async function fetchPage(url: string, ms = 7000): Promise<FetchedPage> {
  try {
    const response = await fetchPublicHttpText(url, {
      timeoutMs: ms,
      maxBytes: 4_000_000,
      accept: "text/html,application/xhtml+xml",
    });
    return response.status >= 200 && response.status < 300
      ? { html: response.body, finalUrl: response.finalUrl }
      : { html: "", finalUrl: response.finalUrl };
  } catch { return { html: "", finalUrl: url }; }
}
const cleanHtml = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

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
  const m = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/href=["']([^"']*\/(?:feed|rss)(?:\/|\.xml)?)["']/i);
  if (m?.[1]) { try { return new URL(m[1], base).toString(); } catch { return null; } }
  return null;
}

// Recruiting/staffing CLIENT-PLACEMENT-BOARD language — these roles are being filled
// FOR A CLIENT, not the company's own headcount. High-precision phrases that ~never
// appear on a company's own internal careers page. We DON'T exclude staffing firms;
// we just skip pages that read as a client board, so a staffing firm's OWN finance
// hire (posted with normal "join our team" language) still counts.
const CLIENT_BOARD_RE = /\b(our client|on behalf of (?:a|our) client|client is (?:seeking|looking|hiring)|for (?:a|our) client|direct[- ]hire(?: opportunit| position| role)|temp(?:orary)?[- ]to[- ]perm|contract[- ]to[- ]hire|submit your resume to|placing (?:candidates|talent)|recruiting (?:for|on behalf of)|now recruiting a|seeking candidates for)\b/;
function looksLikeClientBoard(text: string): boolean {
  return CLIENT_BOARD_RE.test(text);
}

/** A finance opening we verified, with the page and the line that proves it. */
export interface FinanceRoleHit { role: string; snippet: string; url: string }

export interface SiteScan {
  growth: { type: "press" | "new_entity" | "ma"; label: string; snippet?: string }[];
  parent: { name: string; confidence: "high" | "low" } | null;
  feedUrl: string | null;
  financeRoles: FinanceRoleHit[];
}

/** One pass over a company's site: growth phrases + parent-company + RSS feed URL. */
export async function fetchSiteSignals(domain: string, companyName?: string): Promise<SiteScan> {
  const base = `https://${domain.replace(/\/+$/, "")}`;
  const homePage = await fetchPage(base);
  // Secondary pages fetched in PARALLEL with a shorter timeout, so one slow page can't
  // blow the wave's 60s budget (sequential fetches + the added careers pages timed out).
  const [aboutPage, newsPage, careersPage, jobsPage] = await Promise.all([
    fetchPage(`${base}/about`, 5000), fetchPage(`${base}/news`, 5000),
    fetchPage(`${base}/careers`, 5000), fetchPage(`${base}/jobs`, 5000),
  ]);
  const home = homePage.html, about = aboutPage.html, news = newsPage.html;
  const careersTxt = cleanHtml(careersPage.html), jobsTxt = cleanHtml(jobsPage.html);
  const raw = `${home} ${about} ${news}`;
  const rawText = `${cleanHtml(home)} ${cleanHtml(about)} ${cleanHtml(news)}`; // case preserved
  const text = rawText.toLowerCase();
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
  const homeText = cleanHtml(home);
  const financeRoles: FinanceRoleHit[] = [];
  const seenRoles = new Set<string>();
  for (const [pageUrl, pageText] of [[careersPage.finalUrl, careersTxt], [jobsPage.finalUrl, jobsTxt]] as const) {
    if (!pageText || !isCareerEvidenceUrl(pageUrl) || looksLikeClientBoard(pageText)) continue;
    // requireJobPage rejects the soft-404 case where /careers serves the homepage,
    // and drops role words that are the firm's own service offering.
    for (const hit of scanFinanceRoles(pageText, { homeText })) {
      if (seenRoles.has(hit.role)) continue;
      seenRoles.add(hit.role);
      financeRoles.push({ ...hit, url: pageUrl }); // the page we actually verified
    }
  }
  return { growth, parent: detectParent(cleanHtml(raw)), feedUrl: home ? findFeedUrl(home, base) : null, financeRoles };
}
