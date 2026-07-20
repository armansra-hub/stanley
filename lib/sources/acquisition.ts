/**
 * Acquisition extraction for the website watch — replaces the old bare-pattern
 * match ("acquisition of" anywhere → generic "acquisition (they made)" trigger),
 * which false-fired on talent/customer-acquisition copy, M&A-advisory service
 * pages, and news portals writing about OTHER companies' deals.
 *
 * Fires ONLY when the page states, in acquirer position, that the company
 * acquired a NAMED target — and returns that target + the surrounding sentence,
 * so the trigger reads "acquired Ajax Logistics — '…'", never a bare label.
 * Pure module (no server-only) so it unit-tests directly.
 */

// Acquirer-position verb phrases (sentence-start capitals allowed). The TARGET must
// start with a capital letter — a real company name, not "new customers".
const ACQ =
  /(?:[Ww]e(?:['’]ve| have)?(?: recently| proudly| officially)? acquired|[Hh]as(?: recently| officially)? acquired|[Cc]omplet(?:es|ed|ing) (?:the |its |our )?acquisition of|[Aa]nnounc(?:es|ed|ing) (?:the |its |our )?acquisition of|[Oo]ur acquisition of|[Ff]inaliz(?:es|ed) (?:the |its )?acquisition of)\s+([A-Z][A-Za-z0-9&.'’-]*(?:[ -][A-Z0-9][A-Za-z0-9&.'’-]*){0,4})/g;

// "<word> acquisition/acquired" = not M&A (talent acquisition, customer acquisition…).
const NON_MA =
  /\b(?:talent|customer|client|user|land|data|lead|player|donor|patient|skill|language|property|site)s?[ -]acquisitions?\b|\bacquisitions? (?:strategy|strategies|services|advisory|support|financing|marketing)\b/i;

// The acquisition is a SERVICE they sell (brokers/advisors), not a deal they did.
const ADVISORY =
  /\bm&a advis|due diligence|advis(?:e|es|ing|ors?|ory) (?:on|for|to)|broker(?:s|age|ing)?\b|specializ\w+ in\b|help(?:ing|s)? (?:owners|sellers|buyers|you sell|clients sell|businesses sell)|for our (?:buyers|sellers)|sell(?:ing)? your (?:business|company|agency|practice)|we (?:facilitate|represent|value) /i;

// Target names that are really generic phrases, not companies.
const BAD_TARGET = /^(?:New|Your|Our|The|More|Multiple|Several|Additional|Key|Top|Another|This|These|Its|A|An)\b(?![A-Za-z0-9&.'’-]*[a-z].*[A-Z])/;

export interface AcquisitionHit { target: string; snippet: string }

/** True when the ~70 chars before the verb name THIS company. Only the FIRST
 * distinctive name token counts (the brand word — "Netgain", "Agenda"): generic
 * trailing tokens like "Health"/"Staffing" would match OTHER companies in deal
 * news ("Superior Health Holdings announced…" ≠ Agenda Health). */
const NAME_STOP = new Set(["inc", "llc", "corp", "company", "group", "the", "and", "services", "solutions"]);
function subjectIsSelf(before: string, companyName?: string): boolean {
  if (!companyName) return false;
  const token = companyName.toLowerCase().split(/[^a-z0-9]+/).find((t) => t.length >= 4 && !NAME_STOP.has(t));
  return token ? before.toLowerCase().includes(token) : false;
}

/** Scan case-preserved page text for acquisitions THE COMPANY made. Max 2 hits.
 * First-person forms ("we acquired X", "our acquisition of X") always qualify;
 * third-person forms ("has acquired X", "announced the acquisition of X") only
 * qualify when the SUBJECT is this company — otherwise it's deal news about
 * someone else (brokers' transaction pages, industry-news portals). */
export function extractAcquisitions(raw: string, companyName?: string): AcquisitionHit[] {
  if (!raw || raw.length < 40) return [];
  const out: AcquisitionHit[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(ACQ)) {
    if (out.length >= 2) break;
    const target = (m[1] ?? "").replace(/[.,;:]+$/, "").trim();
    if (!target || target.length < 3 || BAD_TARGET.test(target)) continue;
    const at = m.index ?? 0;
    const matched = m[0] ?? "";
    const window = raw.slice(Math.max(0, at - 130), at + matched.length + 130);
    if (NON_MA.test(window)) continue;      // talent/customer/data "acquisition"
    if (ADVISORY.test(window)) continue;    // brokers/advisors selling acquisition services
    if (/acquired by/i.test(window)) continue; // they were BOUGHT — parent detection's job
    const firstPerson = /^[Ww]e\b|^[Oo]ur\b/.test(matched) ||
      /\b(?:we|our)[\s,]+$/i.test(raw.slice(Math.max(0, at - 15), at)); // "…we completed the acquisition of"
    if (!firstPerson && !subjectIsSelf(raw.slice(Math.max(0, at - 70), at), companyName)) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = window.replace(/\s+/g, " ").trim().slice(0, 150);
    out.push({ target: target.slice(0, 60), snippet });
  }
  return out;
}
