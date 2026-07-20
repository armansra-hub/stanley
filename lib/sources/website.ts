import "server-only";
import { extractAcquisitions } from "@/lib/sources/acquisition";

/**
 * Company-website growth-signal reader (FREE). Fetches a claimable company's own
 * site (homepage + a couple announcement pages) and extracts a small set of strong
 * GROWTH phrases — a new office/location, a new division/subsidiary, or an
 * acquisition THEY made. The sweep compares this set run-over-run and fires a
 * trigger only when a NEW phrase appears, so incidental page changes don't create
 * noise. Conservative on purpose (no generic "we're hiring").
 */
const UA = "Mozilla/5.0 (compatible; StanleyTAMBot/1.0; +https://jarvis-sable-eta.vercel.app)";

async function fetchText(url: string, ms = 7000): Promise<string> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA } });
    clearTimeout(to);
    if (!r.ok) return "";
    const html = await r.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").toLowerCase();
  } catch { return ""; }
}

// Strong growth phrases → trigger type. Deliberately tight to avoid noise.
const PATTERNS: { type: "press" | "new_entity" | "ma"; re: RegExp; label: string }[] = [
  { type: "press", re: /\bnew (office|location|headquarters|facility|branch|studio|warehouse)\b/, label: "new location/office" },
  { type: "press", re: /\bgrand opening\b|\bnow open\b|\bopened (a|our) (new )?(office|location|branch|facility)\b/, label: "new site opening" },
  { type: "press", re: /\bexpand(ing|ed)? (to|into|our (footprint|presence|team|operations))\b/, label: "expansion announced" },
  { type: "new_entity", re: /\bnew (division|subsidiary|business unit|practice|brand)\b|\blaunch(ed|ing) (a |our )?new (division|brand|service line|practice)\b/, label: "new division/subsidiary" },
  // NOTE: acquisitions are NOT pattern-diffed — extractAcquisitions() (named-target,
  // acquirer-position, context-guarded) replaced the old bare "acquisition of" match
  // that false-fired on advisory copy and news portals (removed 2026-07-20).
];

// Raw HTML (case preserved) — for parent-name capture + RSS-link discovery.
async function fetchRaw(url: string, ms = 7000): Promise<string> {
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA } });
    clearTimeout(to);
    return r.ok ? await r.text() : "";
  } catch { return ""; }
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

// Open finance-role titles on a company's OWN careers page = they do finance in-house
// and are scaling it NOW (the strongest ERP-readiness tell). Tight titles; "controller"
// guarded against logistics/ops false friends (inventory/quality/document controller).
const FINANCE_ROLE_RES: { re: RegExp; label: string }[] = [
  { re: /(?<!inventory |quality |document |traffic |air |stock |production |materials )\bcontroller\b/, label: "Controller" },
  { re: /\bchief financial officer\b|\bcfo\b/, label: "CFO" },
  { re: /\b(?:vp|vice president)[\s.,of-]{0,8}finance\b/, label: "VP Finance" },
  { re: /\bdirector of finance\b|\bfinance director\b/, label: "Director of Finance" },
  { re: /\b(?:accounting|finance) manager\b/, label: "Accounting/Finance Manager" },
  { re: /\b(?:staff|senior|sr\.?) accountant\b/, label: "Staff/Senior Accountant" },
  { re: /\baccounts payable\b|\bap clerk\b/, label: "Accounts Payable" },
  { re: /\baccounts receivable\b|\bar clerk\b/, label: "Accounts Receivable" },
  { re: /\bfp&a\b|\bfinancial planning (?:and|&) analysis\b/, label: "FP&A" },
  { re: /\bbookkeeper\b/, label: "Bookkeeper" },
  { re: /\bpayroll (?:specialist|manager|administrator|coordinator)\b/, label: "Payroll" },
];
function scanFinanceRoles(text: string): string[] {
  if (!text.trim()) return [];
  const found = new Set<string>();
  for (const r of FINANCE_ROLE_RES) if (r.re.test(text)) found.add(r.label);
  return [...found];
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

export interface SiteScan {
  growth: { type: "press" | "new_entity" | "ma"; label: string; snippet?: string }[];
  parent: { name: string; confidence: "high" | "low" } | null;
  feedUrl: string | null;
  financeRoles: string[];
}

/** One pass over a company's site: growth phrases + parent-company + RSS feed URL. */
export async function fetchSiteSignals(domain: string, companyName?: string): Promise<SiteScan> {
  const base = `https://${domain.replace(/\/+$/, "")}`;
  const home = await fetchRaw(base);
  // Secondary pages fetched in PARALLEL with a shorter timeout, so one slow page can't
  // blow the wave's 60s budget (sequential fetches + the added careers pages timed out).
  const [about, news, careersTxt, jobsTxt] = await Promise.all([
    fetchRaw(`${base}/about`, 5000), fetchRaw(`${base}/news`, 5000),
    fetchText(`${base}/careers`, 5000), fetchText(`${base}/jobs`, 5000),
  ]);
  const raw = `${home} ${about} ${news}`;
  const rawText = `${cleanHtml(home)} ${cleanHtml(about)} ${cleanHtml(news)}`; // case preserved
  const text = rawText.toLowerCase();
  const growth: { type: "press" | "new_entity" | "ma"; label: string; snippet?: string }[] = [];
  if (text.trim()) {
    for (const p of PATTERNS) {
      const m = p.re.exec(text);
      if (!m) continue;
      const at = m.index ?? 0;
      const snippet = text.slice(Math.max(0, at - 70), at + (m[0]?.length ?? 0) + 90).replace(/\s+/g, " ").trim();
      growth.push({ type: p.type, label: p.label, snippet });
    }
    // Acquisitions THEY made — only with a named target, acquirer-position, guarded.
    for (const a of extractAcquisitions(rawText, companyName)) {
      growth.push({ type: "ma", label: `acquired ${a.target}`, snippet: a.snippet });
    }
  }

  // Careers scanned PER-PAGE (kept out of the growth text). A page that reads as a
  // recruiting CLIENT BOARD (staffing firm posting roles for clients) is skipped — those
  // aren't the company's own hires. A staffing firm's OWN finance hire on a normal
  // careers page (no client-board language) still counts.
  const roleSet = new Set<string>();
  for (const t of [careersTxt, jobsTxt]) {
    if (!t || looksLikeClientBoard(t)) continue;
    for (const role of scanFinanceRoles(t)) roleSet.add(role);
  }
  return { growth, parent: detectParent(cleanHtml(raw)), feedUrl: home ? findFeedUrl(home, base) : null, financeRoles: [...roleSet] };
}
