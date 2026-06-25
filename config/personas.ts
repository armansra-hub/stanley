/**
 * Decision-maker qualification — the AE only wants leadership/decision-making
 * personas (the same titles he picked in his Sales Nav filter), NOT junior staff.
 * Applied across every source: the enrichment uses this idea to flag junior-only
 * leads, and the Sales Nav mapper uses JUNIOR_ROLE_RE as a deterministic backstop.
 */

// The decision-maker titles from his Sales Nav "New Hires" search (finance + ops
// leadership). Used in the enrichment prompt as the bar for a real buying signal.
export const DECISION_MAKER_TITLES = [
  "CFO", "Chief Financial Officer", "VP Finance", "Vice President of Finance",
  "VP Finance & Operations", "Head of Finance", "Finance Director", "Director of Finance",
  "Director of Finance & Operations", "Director of Corporate Finance",
  "Controller", "Financial Controller", "Corporate Controller", "Assistant Controller",
  "Finance Manager", "Senior Finance Manager", "Finance Lead", "Head of Corporate Finance",
  "VP Corporate Finance", "Group CFO", "Director of Financial Planning", "Director of FP&A",
  "CEO", "Chief Executive Officer", "President", "COO", "Chief Operating Officer",
  "VP Operations", "Head of Operations", "Operations Manager", "CIO", "CTO",
  "Managing Director", "Owner", "Founder", "Partner",
];

/**
 * Clearly-junior / non-decision-making roles — never worth a notification or spend.
 * A title hitting this (and NOT also hitting a decision-maker word) is junior.
 */
export const JUNIOR_ROLE_RE =
  /\b(staff|junior|jr\.?|entry[- ]?level|associate|assistant(?!\s+controller)|clerk|bookkeeper|coordinator|specialist|analyst|intern|apprentice|trainee|representative|rep|administrator|admin|assoc\.?|payroll|accounts?\s+(payable|receivable)|ap\b|ar\b|data\s+entry|receptionist|technician|operator|driver|warehouse|laborer)\b/i;

const DECISION_MAKER_RE =
  /\b(cfo|chief|controller|vp|vice\s+president|head\s+of|director|finance\s+manager|finance\s+lead|president|owner|founder|partner|principal|managing\s+director|coo|ceo|cio|cto)\b/i;

/** True when a title is clearly a junior / non-decision role (and not a leader). */
export function isJuniorTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  if (DECISION_MAKER_RE.test(t)) return false; // a leader wins ties (e.g. "Assistant Controller")
  return JUNIOR_ROLE_RE.test(t);
}
