/** A relationship signal, not evidence of ERP pain, budget or purchase intent. */
export const ORACLE_PARTNERSHIP_DEFINITION = "The target company itself has announced a partnership, alliance, joint initiative or Oracle PartnerNetwork membership with Oracle Corporation, or directly states that it is working with Oracle toward an identified project or business outcome. A dated first-party account of concrete commercial collaboration can qualify without a legal partnership or OPN membership. Identify both parties, the actual work, the target's role and the evidenced outcome; a service provider may qualify only when the cited passage explicitly describes that direct working collaboration. Oracle product use, a generic Oracle customer or supplier reference/list, employee certifications or former employment, job requirements, event sponsorship, an unrelated namesake, a relationship with a third-party Oracle partner, hypothetical work, or a bare logo does not qualify. Require the complete original and independent identity, date and relationship review; a working-with phrase alone does not establish collaboration. An announcement or dated milestone/renewal/expansion can be an event; an undated directory listing is context only. Do not infer legal partnership, OPN status, ERP use, ERP need, buying intent, revenue, a grade change, or attribution of an entire project's scale to the target.";

/** Necessary wording for the commercial-collaboration branch, not a semantic
 * decision. The outcome phrase stays in the same sentence as the direct party.
 * Immediate Oracle product/partner names cannot satisfy this construction. */
export function hasOracleCollaborationPassage(text: string): boolean {
  return /\bwork(?:s|ed|ing)?\s+(?:directly\s+)?with\s+oracle(?:\s+corporation)?\s+(?:to|on|towards?)\s+[^.!?\r\n]{8,240}/i.test(text);
}

/** Necessary passage check only. Full-source identity/date/relationship judgment
 * and the caller's existing publication/review gates remain authoritative. */
export function hasOraclePartnershipPassage(text: string, companyRole?: string): boolean {
  const collaboration = hasOracleCollaborationPassage(text);
  // A truthful service-provider classification must not become a legal partner
  // merely to pass the router, nor can a generic supplier list qualify it.
  if (companyRole === "service_provider") return collaboration;
  return /\boracle(?:partnernetwork)?\b/i.test(text) && (collaboration || /\b(?:oraclepartnernetwork|partner(?:s|ed|ing|ship|ships|network)?|collaborat(?:e|es|ed|ion)|alliance|joint\s+(?:initiative|agreement|venture))\b/i.test(text));
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
