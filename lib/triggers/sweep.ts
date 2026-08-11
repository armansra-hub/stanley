import "server-only";
import { pickForRotation, recordTrigger, recomputePriority, markChecked, setErpFlags, queueCandidate, headlineCandidateSeen } from "@/lib/db/triggers";
import { normalizeCompanyName } from "@/lib/db/companies";
import { fetchNewsForCompany, fetchNewsItems } from "@/lib/sources/googleNews";
import { claimClassifierCall } from "@/lib/db/settings";
import { classifyEventLLM } from "@/lib/triggers/classify";
import { classifyHeadline } from "@/lib/triggers/config";
import { runActor } from "@/lib/apify/run";
import { normalizeDomain } from "@/lib/domain";
import { parseDateLoose } from "@/lib/time";
import {
  isCareerEvidenceUrl,
  isFinanceHireEligible,
  isFinanceHireEvidenceUrl,
  type FinanceHireCompanyEvidence,
} from "@/lib/triggers/signalIntegrity";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CAREER_ACTOR = "fantastic-jobs/career-site-job-listing-api"; // domainFilter → finance-role postings
// Operational finance roles (the real "does finance in-house" tell — not just a CFO).
const FINANCE_ROLES = ["Controller", "CFO", "VP Finance", "Director of Finance", "Accounting Manager", "Finance Manager", "Staff Accountant", "Senior Accountant", "Accounts Payable", "Accounts Receivable", "Bookkeeper", "FP&A"];
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function isFresh(signalDate: string | null, maxDays = 150): boolean {
  if (!signalDate) return false;
  const ageDays = (Date.now() - new Date(signalDate).getTime()) / 86_400_000;
  return ageDays >= 0 && ageDays < maxDays;
}

/** Google News titles are "Headline - Publisher". Strip the trailing " - Publisher"
 * so the company name can't match the PUBLISHER (e.g. "…- Autobody News" matching
 * "Auto Body News", "…- CFO.com" matching a finance keyword) instead of the story. */
function cleanHeadline(h: string): string {
  return h.replace(/\s+[–—-]\s+[^–—-]+$/, "").trim();
}

// Common business words. A company whose name is ENTIRELY these (e.g. "Strategic
// CFO", "SMART Logistics", "M&A Transaction Advisory") can't be told apart from a
// headline that merely uses the phrase, so we skip news-matching it (accuracy first).
const GENERIC_NAME_WORDS = new Set([
  "strategic", "cfo", "ceo", "logistics", "advisory", "advisors", "advisor", "transaction", "transactions",
  "smart", "big", "solutions", "solution", "services", "service", "consulting", "consultants", "consultant",
  "partners", "partner", "global", "capital", "finance", "financial", "group", "associates", "management",
  "holdings", "ventures", "venture", "digital", "media", "marketing", "transport", "transportation", "freight",
  "express", "systems", "system", "technology", "technologies", "data", "cloud", "national", "international",
  "enterprise", "enterprises", "industries", "industrial", "commercial", "professional", "business", "corporate",
  "labs", "agency", "network", "networks", "resources", "staffing", "recruiting", "logistic",
]);
export function isGenericName(n: string): boolean {
  const toks = n.split(" ").filter(Boolean);
  return toks.length > 0 && toks.every((t) => GENERIC_NAME_WORDS.has(t));
}

/**
 * RELEVANCE GATE: a headline only counts if it's actually ABOUT this company.
 * Google News on a quoted name still returns same-name / coincidental-word noise,
 * so require the company's FULL normalized name to appear CONTIGUOUSLY in the
 * (publisher-stripped, normalized) headline. Names that are ≥4 chars, single-word
 * names ≥5 chars, and NOT entirely generic business words (too ambiguous).
 */
// Single-token names that are ordinary English words or calendar terms. The generic
// BUSINESS-word list above doesn't catch these, so headlines matched them by accident:
// "August" hit "…Effective as of August 1, 2026"; "Diagram" hit "Seed Round Led by
// Diagram" (the investor); "Outpace" hit "AI agents outpace enterprise security";
// "Mineral" hit "Critical Mineral Recovery Technology". A one-word common noun cannot
// be told apart from its ordinary use, so it is never news-matched on its own.
const AMBIGUOUS_SOLO_NAMES = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "monday", "friday", "summer", "winter", "spring", "autumn",
  "diagram", "outpace", "mineral", "founders", "founder", "circle", "scribe", "integra", "arete",
  "encore", "cadence", "measure", "vista", "apex", "summit", "pinnacle", "compass", "beacon",
  "anchor", "bridge", "catalyst", "momentum", "velocity", "vector", "matrix", "nexus", "origin",
  "pioneer", "quantum", "spark", "surge", "thrive", "unity", "vertex", "zenith", "action",
  "advantage", "alliance", "aspire", "elevate", "empower", "engage", "evolve", "focus", "forge",
  "impact", "inspire", "legacy", "liberty", "premier", "prime", "pursuit", "reliance", "renew",
  "reveal", "revive", "signal", "spectrum", "stride", "summitt", "synergy", "trust", "venture",
  // Second pass, from the 2026-08-10 audit of live Triggered rows. Same failure as
  // above — an ordinary noun used in its ordinary sense: "Access" hit "expand public
  // ACCESS to outdoor recreation"; "Bonanza" hit "Confirms BONANZA & Golden Gate
  // Expansion" (a gold assay); "Office" hit "State Treasurer's OFFICE names new CFO".
  // "Brand" is here because "The Brand" normalizes to it and then matched the
  // possessive "…MARKING THE BRAND'S FIRST…" in a story about another company.
  "access", "bonanza", "office", "brand", "value", "creation", "purpose", "method",
  "source", "standard", "quality", "select", "choice", "essential", "element", "motion",
  "freedom", "liberty", "heritage", "horizon", "keystone", "landmark", "milestone",
]);

/**
 * RELEVANCE GATE: a headline only counts if it's actually ABOUT this company.
 *
 * Two ways this used to let noise through, both found by reading real 2026-07-30
 * sweep output:
 *   1. A one-word name that is an ordinary English word or a month — see
 *      AMBIGUOUS_SOLO_NAMES above.
 *   2. Our name being a SUBSTRING of a longer company name: "Jordan LLC" matched
 *      "Mindstream Jordan LLC", "Point Partners" matched "Wind Point Partners",
 *      "Family Farms" matched "Lipman Family Farms". The contiguous check passed, but
 *      the story was about a different, longer-named company. So the match must not
 *      be immediately preceded by another name-ish word.
 */
export function headlineIsAboutCompany(name: string, headline: string): boolean {
  const n = normalizeCompanyName(name);
  if (!n || n.length < 4 || isGenericName(n)) return false;
  const tokens = n.split(" ").filter(Boolean);
  if (tokens.length === 1) {
    if (n.length < 5) return false;
    if (AMBIGUOUS_SOLO_NAMES.has(n)) return false; // ordinary word — unmatchable alone
  }
  if (!normalizeCompanyName(headline).includes(n)) return false;

  // Left-edge guard, run on the RAW headline so punctuation survives. Normalizing
  // first would erase the colon in "Breaking: Acme Freight opens…" and make the
  // prefix look like part of the company name.
  const pattern = new RegExp(
    tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]+"),
    "i",
  );
  const m = pattern.exec(headline);
  if (!m) return true; // normalized form matched but raw spacing differs — accept
  const before = headline.slice(0, m.index);
  // Only a directly adjacent word (no punctuation between) can be part of the name.
  const adjacent = /([A-Za-z0-9&.'\u2019-]+)\s+$/.exec(before);
  if (adjacent) {
    const prevRaw = adjacent[1];
    const prev = prevRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Reject only a CAPITALISED proper noun — that is what makes our name a fragment
    // of a longer company name ("Mindstream Jordan LLC", "Wind Point Partners").
    // A lowercase descriptor is normal headline grammar and must NOT block the match:
    // "Texas company Ajax Freight raises $5M", "Dallas-based Ajax Freight opens hub".
    // An initial over-tight version of this guard cut real signals by ~95%.
    const isProperNoun = /^[A-Z]/.test(prevRaw) && !/-(?:based|headquartered|founded|owned|led|backed)$/i.test(prevRaw);
    if (isProperNoun && prev && !CONNECTIVES.has(prev)) return false;
  }
  return true;
}

/** Words that may legitimately precede a company name in a headline. */
const CONNECTIVES = new Set([
  "of", "by", "at", "to", "for", "with", "from", "and", "the", "a", "an", "as", "on", "in",
  "into", "via", "vs", "after", "before", "amid", "over", "under", "against", "joins", "buys",
  "acquires", "names", "appoints", "hires", "taps", "led", "backs", "backed", "sells",
]);

/** A regex-safe, suffix-stripped name fragment for matching against a raw headline. */
function nameFragment(name: string): string {
  const core = name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|the)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  return core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

/**
 * M&A direction: a company ACQUIRING another is growth (consolidation pain → ERP),
 * but a company GETTING acquired is absorbed into the buyer's systems — not a buy
 * signal. Returns "acquirer" only when the monitored company is clearly the buyer;
 * "target" / "unknown" are suppressed (the AE only wants the acquirer side).
 */
function maDirection(name: string, headline: string): "acquirer" | "target" | "unknown" {
  const h = ` ${headline.toLowerCase().replace(/\s+/g, " ")} `;
  const esc = nameFragment(name);
  if (!esc) return "unknown";
  const acq = "(?:acquires?|acquired|buys|bought|to\\s+buy|to\\s+acquire|purchases?|snaps\\s+up|completes?\\s+(?:the\\s+)?acquisition\\s+of)";
  // target: "<acq> … <name>"  OR  "<name> … acquired by / sold to"
  if (new RegExp(`\\b${acq}\\b[^.]{0,60}\\b${esc}\\b`).test(h)) return "target";
  if (new RegExp(`\\b${esc}\\b[^.]{0,40}\\b(?:acquired\\s+by|bought\\s+by|sold\\s+to|to\\s+be\\s+acquired|to\\s+be\\s+bought)\\b`).test(h)) return "target";
  // acquirer: "<name> … <acq>"  or a mutual "merges with"
  if (new RegExp(`\\b${esc}\\b[^.]{0,40}\\b${acq}\\b`).test(h)) return "acquirer";
  if (new RegExp(`\\b${esc}\\b[^.]{0,40}\\bmerges?\\s+with\\b`).test(h)) return "acquirer";
  return "unknown";
}

// PE / portfolio ownership → standardizes on ERP (propensity flag, not a trigger).
const PE_RE = /\b(private equity|pe firm|portfolio company|portfolio of|backed by|recapitaliz|growth equity|growth investment)\b/i;

/** Run the free Google-News check for ONE company and record real, relevant triggers
 * (publisher-stripped, name-matched, real-event only, acquirer-only M&A, fresh).
 * Returns the count of NEW triggers added. Shared by the base sweep and the daily
 * TAL sweep so the relevance/classification logic stays identical. */
/** Classify ONE headline for a company and record a trigger if it's a real positive
 * event. Shared by Google-News (requireNameMatch=true) and the company's own
 * newsroom RSS (requireNameMatch=false — it's already their feed). Returns true if a
 * NEW trigger landed. opts.llm = use the Opus verifier (budget-gated) on claimable. */
export async function classifyAndRecordHeadline(
  company: { id: string; name: string; netsuite_internal_id?: string | null } & FinanceHireCompanyEvidence,
  it: { raw_excerpt: string; source_url: string; signal_date: string | null; source_name: string },
  opts: { llm?: boolean; requireNameMatch?: boolean } = {},
): Promise<boolean> {
  const clean = cleanHeadline(it.raw_excerpt);
  if (opts.requireNameMatch !== false && !headlineIsAboutCompany(company.name, clean)) return false;
  if (PE_RE.test(clean)) await setErpFlags(company.id, { pe_owned: true });
  let type = classifyHeadline(clean);
  if (type === "news") return false; // cheap regex prefilter — only candidate events proceed
  if (await headlineCandidateSeen(company.id, it.raw_excerpt)) return false;
  let acquirer = type !== "ma" || maDirection(company.name, clean) === "acquirer";
  if (opts.llm && (await claimClassifierCall())) {
    const v = await classifyEventLLM(company.name, clean);
    if (v) {
      if (!v.about_company || v.event === "none") return false;
      type = v.event;
      acquirer = v.event !== "ma" || v.is_acquirer;
    }
  }
  if (type === "ma" && !acquirer) return false; // target acquisition → suppress
  // QUEUED, not published: headline-to-company attribution needs judgment, not regex.
  if (type === "finance_hire" && (!isFinanceHireEligible(company) || !isFinanceHireEvidenceUrl(it.source_url, it.source_name))) return false;
  return queueCandidate(company, { type, summary: it.raw_excerpt, source_name: it.source_name, source_url: it.source_url, signal_date: it.signal_date });
}

export async function checkCompanyNews(company: { id: string; name: string; netsuite_internal_id?: string | null } & FinanceHireCompanyEvidence, opts: { llm?: boolean } = {}): Promise<number> {
  let added = 0;
  for (const it of await fetchNewsForCompany(company.name, 6)) {
    if (!isFresh(it.signal_date)) continue;
    if (await classifyAndRecordHeadline(company, it, { llm: opts.llm, requireNameMatch: true })) added++;
  }
  return added;
}

// Exec-change: a new finance leader (CFO/Controller/VP Finance) = canonical "about
// to modernize the finance stack → buy ERP" trigger. Targeted Google-News query per
// claimable company; requires a hire verb + a finance title + the company name.
const EXEC_HIRE_RE = /\b(names?|appoints?|appointed|hires?|hired|welcomes?|adds?|promotes?|promoted|joins?|joined|taps?|elevates?|announces?)\b/i;
const FIN_TITLE_RE = /\b(cfo|chief financial officer|controller|comptroller|vp[\s.,-]{0,6}finance|vice president[\s,]+(of\s+)?finance|head of finance|finance director|director of finance|chief accounting officer|chief accountant)\b/i;
/** Check a (claimable) company for a new finance-leadership hire. Returns new triggers added. */
export async function checkExecChange(company: { id: string; name: string; netsuite_internal_id?: string | null } & FinanceHireCompanyEvidence): Promise<number> {
  if (!isFinanceHireEligible(company)) return 0;
  let added = 0;
  const q = `"${company.name}" (CFO OR controller OR "chief financial officer" OR "VP Finance" OR "head of finance" OR "finance director")`;
  for (const it of await fetchNewsItems(q, 6)) {
    if (!isFresh(it.signal_date, 120)) continue;
    const clean = cleanHeadline(it.raw_excerpt);
    if (!headlineIsAboutCompany(company.name, clean)) continue;
    if (!(EXEC_HIRE_RE.test(clean) && FIN_TITLE_RE.test(clean))) continue;
    if (await queueCandidate(company, { type: "finance_hire", summary: it.raw_excerpt, source_name: "Google News", source_url: it.source_url, signal_date: it.signal_date })) added++;
  }
  return added;
}

/**
 * Monitor the next batch of the base (high-fit / longest-unchecked first) for timing
 * signals — boost-only, never creates a company. Two sources per batch:
 *   • NEWS (FREE): per-company Google News → news/funding/M&A triggers.
 *   • FINANCE HIRING (PAID, the budget): ONE career-site actor call over the batch's
 *     domains → finance_hire (in-house-finance confirmation) + erp_tech (QuickBooks,
 *     no ERP, from the JD) triggers. One call per ~50 domains ≈ $0.13.
 */
export async function sweepBase(limit = 50, opts: { finance?: boolean; offset?: number } = {}): Promise<{ checked: number; companies_triggered: number; news_triggers: number; finance_triggers: number; erp_triggers: number }> {
  const companies = await pickForRotation(limit, opts.offset ?? 0);
  const touched = new Set<string>();
  let news = 0, finance = 0, erp = 0;

  // ── FINANCE HIRING + ERP-readiness (PAID, OFF by default) ──────────────────────
  // Tested 2026-06-27: 0 hits across 250 base domains — the NetSuite-TAM base skews to
  // small companies with no ATS career page the actor indexes, so this is near-zero ROI
  // here. Kept (gated) for future LARGER-company lists. Free news below is the workhorse.
  const withDomain = opts.finance ? (companies.filter((c) => c.domain && isFinanceHireEligible(c)) as { id: string; name: string; domain: string }[]) : [];
  const byDomain = new Map(withDomain.map((c) => [c.domain, c.id]));
  const domains = withDomain.map((c) => c.domain);
  if (domains.length) {
    try {
      // titleSearch only (any finance posting = in-house finance); we detect ERP from the
      // JD text ourselves. `limit` is required and must be ≥ 10.
      const items = await runActor(CAREER_ACTOR, {
        domainFilter: domains, titleSearch: FINANCE_ROLES,
        includeCompanyDetails: true, liOrganizationEmployeesGte: 20,
        limit: Math.min(Math.max(domains.length * 2, 10), 100),
      }, Math.min(domains.length * 2, 100));
      for (const r of items as any[]) {
        const dom = normalizeDomain(str(r.domain_derived) ?? str(r.org_linkedin_website) ?? "");
        const cid = dom ? byDomain.get(dom) : undefined;
        if (!cid) continue;
        const role = String(r.title ?? "a finance role").slice(0, 80);
        const sd = parseDateLoose(r.date_posted ?? r.date_validfrom ?? r.date);
        const url = str(r.url) ?? null;
        if (!isCareerEvidenceUrl(url)) continue;
        if (await recordTrigger(cid, { type: "finance_hire", summary: `Hiring: ${role}`, source_name: "Career site", source_url: url, signal_date: sd })) { finance++; touched.add(cid); }
        const desc = String(r.description_text ?? "").toLowerCase();
        if (/quickbooks|\bqbo\b/.test(desc) && !/netsuite|sage intacct|intacct|acumatica|dynamics 365/.test(desc)) {
          if (await recordTrigger(cid, { type: "erp_tech", summary: `Runs QuickBooks, no ERP — per the "${role}" posting`, source_url: url ? `${url}#erp` : null, signal_date: sd })) { erp++; touched.add(cid); }
        }
      }
    } catch { /* paid source isolated — never breaks the free sweep */ }
  }

  // ── NEWS (free; per company, in parallel batches) ──
  // Quality gates so a trigger is real, not noise:
  //   1) the headline must be ABOUT this company (name appears), and
  //   2) it must be a real EVENT (funding / M&A / finance hire / expansion) — the
  //      generic "news" catch-all is dropped (a headline with no trigger keyword
  //      is not a reason to call). Plus freshness.
  // TIME-BOXED + INCREMENTALLY STAMPED: each processed batch stamps its rotation
  // cursor immediately, and the loop stops cleanly before Vercel's 60s kill — so a
  // slow wave (many Opus-verified headlines) commits partial progress instead of
  // losing everything to FUNCTION_INVOCATION_TIMEOUT (the pre-fix failure mode).
  const deadline = Date.now() + 48_000;
  const BATCH = 20;
  let processed = 0;
  for (let i = 0; i < companies.length; i += BATCH) {
    if (Date.now() > deadline) break;
    const slice = companies.slice(i, i + BATCH);
    await Promise.all(slice.map(async (c) => {
      try {
        const claimable = !!(c as { claimable?: boolean }).claimable;
        let n = await checkCompanyNews(c, { llm: claimable });
        // Exec-change (new finance leader) — claimable NetSuite-TAM leads only.
        if (claimable) { try { n += await checkExecChange(c); } catch { /* isolated */ } }
        if (n > 0) { news += n; touched.add(c.id); }
      } catch { /* source-isolated */ }
    }));
    await markChecked(slice.map((c) => c.id)); // commit progress batch-by-batch
    processed += slice.length;
  }

  for (const cid of touched) await recomputePriority(cid);
  return { checked: processed, companies_triggered: touched.size, news_triggers: news, finance_triggers: finance, erp_triggers: erp };
}
