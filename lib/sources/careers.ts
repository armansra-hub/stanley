/**
 * Finance-hire detection from a company's own careers page.
 *
 * Rebuilt 2026-07-30 after Arman checked the links: "it just takes me to a link that
 * in the URL has job, CFO, but then the actual page is just the home page or the about
 * page. It's not actually the career job posting or even the careers page."
 *
 * Verified against live sites. Two distinct ways the old scan was wrong:
 *
 *  1. SOFT 404. Fetching /careers on a site with no such path returns the HOMEPAGE
 *     with HTTP 200. allaccessaccounting.net/careers served a 377KB homepage titled
 *     "Award-Winning Bookkeeping, Payroll & CFO Services" — no job content at all —
 *     and the word "CFO" scored a finance-hire.
 *  2. SERVICE COPY. The role words are what these firms SELL. "CFO Services",
 *     "outsourced controller", "we provide bookkeeping" are offerings, not openings.
 *
 * So a role only counts when the page proves it is a real job page AND the mention
 * isn't in a service-offering context. Pure module — no server-only, so it's testable.
 */

/** Markers that only appear on a genuine job/careers page. */
const JOB_PAGE_MARKERS = [
  /\bapply now\b/i, /\bapply today\b/i, /\bapply online\b/i, /\bjob description\b/i,
  /\bresponsibilities\b/i, /\bqualifications\b/i, /\bopen (?:positions|roles)\b/i,
  /\bcurrent (?:openings|opportunities|vacancies)\b/i, /\bwe(?:'re| are) hiring\b/i,
  /\bjoin our team\b/i, /\bsubmit (?:your )?(?:resume|application|cv)\b/i,
  /\bemployment opportunities\b/i, /\bview (?:job|position)\b/i, /\bfull[- ]time\b/i,
  /\bnow hiring\b/i, /\bbenefits (?:include|package)\b/i,
];

/** A page needs at least this many distinct job markers to be believed. */
const MIN_JOB_MARKERS = 2;

/**
 * Is this actually a careers/job page — and not the homepage served under /careers?
 * `homeText` lets us catch the soft-404: if the "careers" page is essentially the
 * homepage, there is no careers page.
 */
export function isRealCareersPage(text: string, homeText?: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 200) return false;

  const markers = JOB_PAGE_MARKERS.filter((re) => re.test(t)).length;
  if (markers < MIN_JOB_MARKERS) return false;

  // Soft-404: the path resolved to the homepage. Compare a long normalized prefix —
  // identical openings mean the same document.
  if (homeText && homeText.trim().length > 200) {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const a = norm(t), b = norm(homeText);
    if (a === b) return false;
    if (a.slice(0, 1500) === b.slice(0, 1500)) return false;
    // Near-identical length AND a shared long opening is the same page with a banner swap.
    if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) < 0.05 && a.slice(0, 600) === b.slice(0, 600)) return false;
  }
  return true;
}

/** Operational finance roles — the real "does finance in-house" tell, not just a CFO.
 * "controller" is guarded against logistics/ops false friends. */
const FINANCE_ROLE_RES: { re: RegExp; label: string }[] = [
  { re: /(?<!inventory |quality |document |traffic |air |stock |production |materials )\bcontroller\b/i, label: "Controller" },
  { re: /\bchief financial officer\b|\bcfo\b/i, label: "CFO" },
  { re: /\b(?:vp|vice president)[\s.,of-]{0,8}finance\b/i, label: "VP Finance" },
  { re: /\bdirector of finance\b|\bfinance director\b/i, label: "Director of Finance" },
  { re: /\b(?:accounting|finance) manager\b/i, label: "Accounting/Finance Manager" },
  { re: /\b(?:staff|senior|sr\.?) accountant\b/i, label: "Staff/Senior Accountant" },
  { re: /\baccounts payable\b|\bap clerk\b/i, label: "Accounts Payable" },
  { re: /\baccounts receivable\b|\bar clerk\b/i, label: "Accounts Receivable" },
  { re: /\bfp&a\b|\bfinancial planning (?:and|&) analysis\b/i, label: "FP&A" },
  { re: /\bbookkeeper\b/i, label: "Bookkeeper" },
  { re: /\bpayroll (?:specialist|manager|administrator|coordinator)\b/i, label: "Payroll" },
];

/** The role is a SERVICE this company sells, not a job it is filling. */
const SERVICE_CONTEXT =
  /\b(?:outsourced|fractional|virtual|part[- ]time|interim|on[- ]demand)\s+(?:cfo|controller|bookkeep|accounting|payroll)|\b(?:cfo|controller|bookkeeping|payroll|accounting)\s+(?:services|solutions|support|packages?|plans?|pricing)\b|\bwe (?:provide|offer|deliver|handle|manage)\b[^.]{0,60}\b(?:bookkeeping|payroll|accounting|cfo|controller)\b|\bour\s+(?:cfo|controller|bookkeeping|payroll|accounting)\s+(?:team|services|solutions)\b/i;

/**
 * Finance roles a company is genuinely HIRING for, with the evidence line.
 * Returns [] unless the page verifies as a real job page.
 */
export function scanFinanceRoles(
  text: string,
  opts: { homeText?: string; requireJobPage?: boolean } = {},
): { role: string; snippet: string }[] {
  const t = text ?? "";
  if (!t.trim()) return [];
  if (opts.requireJobPage !== false && !isRealCareersPage(t, opts.homeText)) return [];

  const out: { role: string; snippet: string }[] = [];
  for (const { re, label } of FINANCE_ROLE_RES) {
    const m = re.exec(t);
    if (!m) continue;
    const at = m.index ?? 0;
    const window = t.slice(Math.max(0, at - 120), at + m[0].length + 120);
    if (SERVICE_CONTEXT.test(window)) continue; // they sell it, they aren't hiring it
    out.push({ role: label, snippet: window.replace(/\s+/g, " ").trim().slice(0, 180) });
  }
  return out;
}
