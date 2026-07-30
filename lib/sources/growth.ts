/**
 * Growth signals from a company's own website.
 *
 * Rebuilt 2026-07-30 after Arman read the output: "it says growth and expansion from
 * their own website, and all it is is just a paragraph from their company description
 * about who we are, what we do. It's not actual news."
 *
 * He was right. Real matches the old patterns produced:
 *   "expanding into their wholeness"                        — philosophical copy
 *   "we relish the opportunity to expand into other industries" — aspirational
 *   "expanding into new opportunities, increasing successful campaigns" — boilerplate
 *   "American Airlines new flagship business-class suites are expanding to..."
 *                                                           — an article about someone else
 *   "brad projectus just completed an install for us for our new office"
 *                                                           — a CUSTOMER testimonial
 * versus the one true positive:
 *   "opens flower mound office to serve families across denton county"
 *
 * The difference isn't the phrase, it's whether the sentence reports a concrete EVENT.
 * So a phrase only counts with corroboration: an announcement verb, a date, or a place.
 * Positive requirements beat blocklists — you can't enumerate every abstract noun.
 * Pure module (no server-only) so it unit-tests directly.
 */

export type GrowthType = "press" | "new_entity";
export interface GrowthHit { type: GrowthType; label: string; snippet: string }

const PATTERNS: { type: GrowthType; re: RegExp; label: string }[] = [
  { type: "press", re: /\bnew (office|location|headquarters|facility|branch|studio|warehouse)\b/gi, label: "new location/office" },
  { type: "press", re: /\bgrand opening\b|\bnow open\b|\bopen(?:s|ed|ing) (?:a |our |its )?(?:new )?(?:office|location|branch|facility|headquarters)\b/gi, label: "new site opening" },
  { type: "press", re: /\bexpand(?:s|ing|ed)? (?:to|into|our (?:footprint|presence|team|operations))\b/gi, label: "expansion announced" },
  { type: "new_entity", re: /\bnew (division|subsidiary|business unit|practice|brand)\b|\blaunch(?:es|ed|ing) (?:a |our )?new (division|brand|service line|practice)\b/gi, label: "new division/subsidiary" },
];

/** Reporting an event that happened: announced, opened, completed, is relocating. */
const ANNOUNCEMENT = /\b(?:announce[sd]?|announcing|is pleased to|proud to announce|has opened|opened|opens|opening of|celebrat(?:es|ed|ing)|unveil(?:s|ed)|launch(?:es|ed)|relocat(?:es|ed|ing)|welcome[sd]? (?:you )?to our new|ribbon[- ]cutting|now serving|has (?:moved|relocated)|doors open)\b/i;
/** A concrete date anchors it in time — press releases carry one, boilerplate doesn't. */
const DATED = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*20\d{2}\b|\b20(?:2[4-9]|3\d)\b|\b\d{1,2}\/\d{1,2}\/20\d{2}\b/i;
/** A named place — "flower mound office", "across denton county", "in Phoenix, AZ". */
const PLACED = /\b(?:county|city of|downtown|suite \d|[A-Z]{2}\s+\d{5})\b|\bin\s+[A-Z][a-z]+(?:,\s*[A-Z]{2})?\b|\b[A-Z][a-z]+,\s*[A-Z]{2}\b/;

/** Someone else's story, or a customer talking about themselves. */
const NOT_ABOUT_US =
  /\b(?:for us|for our (?:company|team|office|business)\b(?![^.]{0,30}\bwe\b)|testimonial|review[sd]? by|said [A-Z]|according to|—\s*[A-Z][a-z]+\s+[A-Z]|client (?:says|said)|they (?:designed|installed|built|delivered))\b/i;
/** Aspiration and self-description, not an event. */
const ASPIRATIONAL =
  /\b(?:relish|opportunity to|we (?:aim|hope|strive|seek|want|plan|continue|believe)|committed to|our mission|dedicated to|looking to|ready to|can help you|allows? (?:you|us) to|whether you|imagine)\b/i;

/**
 * Growth events stated on the page. Each hit carries the sentence that justifies it,
 * so a human can check it in one glance — the whole reason the old output was untrusted.
 */
export function extractGrowthSignals(raw: string): GrowthHit[] {
  const text = raw ?? "";
  if (text.trim().length < 80) return [];
  const out: GrowthHit[] = [];
  const seen = new Set<string>();

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const at = m.index ?? 0;
      // A generous window so the corroborating date/verb/place can be found, but
      // tight enough that it belongs to the same statement.
      const window = text.slice(Math.max(0, at - 180), at + m[0].length + 180);
      if (NOT_ABOUT_US.test(window)) continue;
      if (ASPIRATIONAL.test(window)) continue;
      // Require corroboration that this is a reported event.
      if (!ANNOUNCEMENT.test(window) && !DATED.test(window) && !PLACED.test(window)) continue;
      if (seen.has(p.label)) continue;
      seen.add(p.label);
      out.push({ type: p.type, label: p.label, snippet: window.replace(/\s+/g, " ").trim().slice(0, 190) });
      break; // one hit per pattern is enough — the snippet is the evidence
    }
  }
  return out;
}
