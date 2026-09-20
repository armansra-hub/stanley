import { decodeEntities, htmlAttributes, type SiteCompanyIdentity } from "./siteContent";

export const IDENTITY_RELATIONS = ["legal_name", "dba", "former_name", "parent", "subsidiary", "joint_venture", "division"] as const;
export type IdentityRelation = typeof IDENTITY_RELATIONS[number];
export interface SiteIdentityClaim {
  subjectName: string; candidateName: string; relationshipHint: IdentityRelation;
  sourceQuote: string; sourceFormat: "json_ld" | "visible";
  candidateDomain?: string;
  candidateAddress?: { addressLine1: string; city?: string; state?: string; postalCode?: string; countryCode?: string };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.trim().length <= 180 ? decodeEntities(v).replace(/\s+/g, " ").trim() : "";
const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
const escaped = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Explicit declarations only. These are sourced discovery candidates, not entity
 * bindings. Related-company addresses stay attached to that named company. */
export function extractIdentityClaims(html: string, sourceUrl: string, identity?: SiteCompanyIdentity): SiteIdentityClaim[] {
  const claims: SiteIdentityClaim[] = [];
  const ownNames = identity?.names ?? [];
  const add = (claim: SiteIdentityClaim) => {
    if (!claim.subjectName || !claim.candidateName || claim.relationshipHint !== "legal_name" && key(claim.subjectName) === key(claim.candidateName)
      || claim.candidateName.length > 180 || claims.length >= 20) return;
    if (!claims.some(c => key(c.subjectName) === key(claim.subjectName) && key(c.candidateName) === key(claim.candidateName)
      && c.relationshipHint === claim.relationshipHint)) claims.push(claim);
  };
  const sameSite = (raw: string) => {
    try { const target = new URL(raw, sourceUrl), source = new URL(sourceUrl);
      return /^https?:$/.test(target.protocol) && target.hostname.replace(/^www\./, "") === source.hostname.replace(/^www\./, "");
    } catch { return false; }
  };
  const declaration = (subjectName: string, raw: unknown, relation: IdentityRelation, property: string) => {
    for (const item of Array.isArray(raw) ? raw.slice(0, 10) : [raw]) {
      const candidateName = text(object(item) ? item.name : item);
      if (!candidateName) continue;
      const claim: SiteIdentityClaim = { subjectName, candidateName, relationshipHint: relation,
        sourceQuote: JSON.stringify({ name: subjectName, [property]: item }).slice(0, 1800), sourceFormat: "json_ld" };
      if (object(item)) {
        const rawUrl = text(item.url);
        try { if (rawUrl) { const url = new URL(rawUrl, sourceUrl); if (/^https?:$/.test(url.protocol) && !url.username && !url.password) claim.candidateDomain = url.hostname.replace(/^www\./, ""); } } catch { /* No usable domain. */ }
        const address = object(item.address) ? item.address : {};
        if (text(address.streetAddress)) claim.candidateAddress = { addressLine1: text(address.streetAddress), city: text(address.addressLocality) || undefined,
          state: text(address.addressRegion) || undefined, postalCode: text(address.postalCode) || undefined,
          countryCode: text(object(address.addressCountry) ? address.addressCountry.name : address.addressCountry) || undefined };
      }
      add(claim);
    }
  };
  let remaining = 300;
  const visit = (v: unknown, depth = 0) => {
    if (--remaining < 0 || depth > 8) return;
    if (Array.isArray(v)) { for (const row of v.slice(0, 100)) visit(row, depth + 1); return; }
    if (!object(v)) return;
    const name = text(v.name), url = text(v.url) || text(v["@id"]);
    if (name && ownNames.some(n => key(n) === key(name)) && url && sameSite(url)) {
      declaration(name, v.legalName, "legal_name", "legalName");
      declaration(name, v.alternateName, "dba", "alternateName");
      declaration(name, v.parentOrganization, "parent", "parentOrganization");
      declaration(name, v.subOrganization, "subsidiary", "subOrganization");
    }
    if (v["@graph"]) visit(v["@graph"], depth + 1);
    if (v.publisher) visit(v.publisher, depth + 1);
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (htmlAttributes(match[1]).type?.toLowerCase() !== "application/ld+json" || match[2].length > 500_000) continue;
    try { visit(JSON.parse(match[2])); } catch { /* Invalid source structure supplies no claim. */ }
  }
  // Named visible clauses on the publisher's own page can supply a relationship
  // even when its schema contains only the publisher. An exact candidate-name
  // anchor supplies a followable official domain; arbitrary outbound links do not.
  const visible = decodeEntities(html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
  for (const claim of visibleIdentityClaims(visible, ownNames)) {
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const label = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (key(label) !== key(claim.candidateName)) continue;
      try { const url = new URL(htmlAttributes(match[1]).href ?? "", sourceUrl);
        if (/^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname.includes(".")) claim.candidateDomain = url.hostname.replace(/^www\./, "");
      } catch { /* No usable link. */ }
    }
    add(claim);
  }
  return claims;
}

/** Runs after the account is known, including on legal/about pages without
 * schema. Only clauses naming this account are admitted; customer stories and
 * unanchored 'we' statements cannot transfer a third party's identity. */
export function visibleIdentityClaims(content: string, accountNames: string[]): SiteIdentityClaim[] {
  const claims: SiteIdentityClaim[] = [];
  const candidate = "([A-Z][A-Za-z0-9&'’,()/-]*(?: [A-Z0-9][A-Za-z0-9&'’,()/-]*){0,10})";
  const patterns: Array<[IdentityRelation, string]> = [
    ["former_name", "(?:,? formerly (?:known as )?| was formerly (?:known as )?)"],
    ["dba", "(?:,? (?:doing business as|d/b/a|DBA) | operates (?:under the name|as) )"],
    ["legal_name", "(?: is (?:the )?(?:trade|brand) name of | is legally (?:known as|registered as) )"],
    ["parent", "(?:,? (?:is )?a (?:wholly[- ]owned )?(?:subsidiary|division) of | is owned by )"],
    ["subsidiary", "(?: owns (?:the subsidiary )?| acquired )"],
    ["joint_venture", "(?: (?:formed|established|launched) (?:a joint venture (?:named|called) |the joint venture ))"],
    ["division", "(?: (?:operates|launched) (?:the )?division )"],
  ];
  for (const subjectName of accountNames.slice(0, 12)) for (const [relationshipHint, clause] of patterns) {
    const re = new RegExp(`\\b${escaped(subjectName)}${clause}${candidate}`, "g");
    for (const match of content.slice(0, 24_000).matchAll(re)) {
      const candidateName = match[1].replace(/[.,]+$/, "").trim();
      if (candidateName.length < 3 || candidateName.length > 180 || key(candidateName) === key(subjectName)) continue;
      const start = match.index ?? 0;
      const before = Math.max(content.lastIndexOf(". ", start - 1) + 2, content.lastIndexOf("\n", start - 1) + 1, start - 200, 0);
      const after = content.indexOf(". ", start + match[0].length);
      claims.push({ subjectName, candidateName, relationshipHint,
        sourceQuote: content.slice(before, after < 0 ? Math.min(content.length, start + match[0].length + 200) : after + 1).slice(0, 1800), sourceFormat: "visible" });
      if (claims.length >= 20) return claims;
    }
  }
  return claims;
}
