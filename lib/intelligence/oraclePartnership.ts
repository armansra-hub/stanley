/** A relationship signal, not evidence of ERP pain, budget or purchase intent. */
export const ORACLE_PARTNERSHIP_DEFINITION = "The target company itself has formally announced a partnership, alliance, joint initiative or Oracle PartnerNetwork membership with Oracle Corporation. Identify both parties and the actual relationship. Oracle product use, an Oracle customer or supplier reference, employee certifications or former employment, job requirements, event sponsorship, an unrelated namesake, a partnership with a third-party Oracle partner, or a bare logo does not qualify. An announcement of the relationship or a dated renewal/expansion can be an event; an undated directory listing is context only. Do not infer ERP use, ERP need, buying intent, revenue, or a grade change.";

/** Necessary passage check only. Full-source identity/date/relationship judgment
 * and the caller's existing publication/review gates remain authoritative. */
export function hasOraclePartnershipPassage(text: string): boolean {
  return /\boracle(?:partnernetwork)?\b/i.test(text) && /\b(?:oraclepartnernetwork|partner(?:s|ed|ing|ship|ships|network)?|collaborat(?:e|es|ed|ion)|alliance|joint\s+(?:initiative|agreement|venture))\b/i.test(text);
}

/** A concrete original page, never a search result, profile homepage or logo link. */
export function isOraclePartnershipSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.pathname === "/") return false;
    if (/(?:^|\.)(?:google\.[a-z.]+|bing\.com|search\.yahoo\.com)$/i.test(url.hostname)) return false;
    if (/(?:^|\.)linkedin\.com$/i.test(url.hostname)) return /^\/(?:posts\/[^/]+|pulse\/[^/]+|feed\/update\/urn:li:activity:\d+)/i.test(url.pathname);
    return !/^\/(?:search|search-results)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
