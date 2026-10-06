import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { sameRegistryLegalName, stableRegistryJson } from "./registryProfiles";

type Review = { taskId: string; reviewedAt: string; receiptSha256: string };
export type RegisteredAgentOperatorPage = {
  requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
  hops: { url: string; status: number }[]; htmlSha256: string; textSha256: string; receiptSha256: string;
  text: string; representation: "complete_retained_static_text_v1";
};
type Quote = { pageTextSha256: string; start: number; end: number; text: string;
  ordinaryHtml: { start: number; end: number; html: string; sha256: string } };
export type RegisteredAgentOperatorBridge = {
  schema: "reviewed_registered_agent_operator_v1";
  // siteLegalName retains the literal site company name. The existing comparator
  // permits an omitted legal suffix, but never an explicit conflicting form.
  canonicalName: string; siteLegalName: string; sourceInputSha256: string;
  primaryDecisionSha256: string; independentDecisionSha256: string;
  officialAgent: { firstName: string; middleName: string; lastName: string; suffix: string };
  siteOperator: { firstName: string; lastName: string; displayName: string; role: string };
  pages: RegisteredAgentOperatorPage[]; legalQuote: Quote; operatorQuote: Quote;
  limitations: {
    association: "independently_reviewed_company_inference";
    statutoryPersonIdentityVerified: false; omittedMiddleNamesVerified: false;
    addressEquivalenceClaimed: false; agentOwnershipClaimed: false; canonicalIdentityChanged: false;
    literalDifferences: string[];
  };
};
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const personPart = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[ '’.-]/g, "");
const namePart = (v: unknown): v is string => typeof v === "string" && /^[\p{L}][\p{L}'’ .-]{1,79}$/u.test(v);
function need(v: unknown, why: string): asserts v { if (!v) throw Error(`registered agent operator ${why}`); }
function shape(v: unknown, keys: string[]) {
  return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
// Exact 100ns ordering for this new mode. Legacy official-API date rules remain unchanged.
export function registeredAgentOperatorInstant(v: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  need(m && Number.isFinite(Date.parse(`${m[1]}T${m[2]}${m[4]}`)), "invalid timestamp");
  need(new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) === m[1]
    && Number(m[2].slice(0, 2)) < 24 && Number(m[2].slice(3, 5)) < 60 && Number(m[2].slice(6)) < 60,
  "invalid civil timestamp");
  return BigInt(Date.parse(`${m[1]}T${m[2]}${m[4]}`)) * 10000n + BigInt((m[3] ?? "").padEnd(7, "0"));
}
function ownUrl(value: string, domain: string) {
  try {
    const u = new URL(value);
    return value.length <= 2048 && u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash
      && u.hostname.toLowerCase().replace(/^www\./, "") === domain;
  } catch { return false; }
}
function completePersonLiteral(text: string, person: string) {
  // A full literal first/last name must not be a prefix, suffix or part of a
  // hyphenated/apostrophized/combining-character name in the quoted text.
  const continuation = /[\p{L}\p{N}\p{M}'’.-]/u;
  for (let at = text.indexOf(person); at >= 0; at = text.indexOf(person, at + 1)) {
    const before = Array.from(text.slice(0, at)).at(-1) ?? "";
    const after = Array.from(text.slice(at + person.length))[0] ?? "";
    if (!continuation.test(before) && !continuation.test(after)) return true;
  }
  return false;
}
// A finite typography exception for reviewed static HTML, not a visibility or
// general CSS parser. Exact original HTML remains pinned; no style is stripped.
function reviewedTypography(html: string) {
  const markers = [...html.matchAll(/\bstyle\s*=/gi)];
  const attributes = [...html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
  if (markers.length !== attributes.length) return false; // Unquoted/malformed style.
  const tags = [...html.matchAll(/<[^>]*>/g)];
  if (attributes.some(a => !tags.some(t => a.index > t.index && a.index + a[0].length < t.index + t[0].length))) return false;
  for (const tag of tags) {
    if ([...tag[0].matchAll(/\bstyle\s*=/gi)].length > 1) return false;
  }
  for (const attribute of attributes) {
    const css = attribute[1] ?? attribute[2];
    if (!css || css.length > 1024 || /[^\x20-\x7e]|[\\&{}<>!@()]/.test(css)) return false;
    const declarations = css.trim().replace(/;$/, "").split(";");
    const seen = new Set<string>();
    for (const declaration of declarations) {
      const pair = /^\s*([a-z-]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration);
      if (!pair) return false;
      const property = pair[1].toLowerCase(), value = pair[2];
      if (seen.has(property)) return false;
      seen.add(property);
      if (property === "font-size") {
        const n = /^(\d{1,2}(?:\.\d{1,2})?)px$/.exec(value);
        if (!n || Number(n[1]) < 8 || Number(n[1]) > 72) return false;
      } else if (property === "line-height") {
        const n = /^(\d(?:\.\d{1,2})?)(?:em)?$/.exec(value);
        if (!n || Number(n[1]) < 1 || Number(n[1]) > 3) return false;
      } else if (property === "font-weight" || property === "letter-spacing") {
        if (value !== "normal") return false;
      } else if (property === "color") {
        if (!/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) return false;
      } else if (property === "font-family") {
        if (value.length > 512 || /\b(?:var|calc|url|expression|inherit|initial|unset|revert|none)\b/i.test(value)) return false;
        const names = value.split(",").map(n => n.trim());
        if (names.length > 6 || names.some(n => !/^(?:[a-z_][a-z0-9_-]{0,159}|"[a-z][a-z0-9 _-]{0,159}"|'[a-z][a-z0-9 _-]{0,159}')$/i.test(n))) return false;
      } else return false;
    }
  }
  return true;
}
function quote(b: RegisteredAgentOperatorBridge, q: Quote) {
  need(shape(q, ["pageTextSha256", "start", "end", "text", "ordinaryHtml"]), "quote shape differs");
  const pages = b.pages.filter(p => p.textSha256 === q.pageTextSha256), h = q.ordinaryHtml;
  need(pages.length === 1 && typeof q.text === "string" && q.text.length > 0 && q.text.length <= 2000
    && Number.isSafeInteger(q.start) && q.start >= 0 && q.end === q.start + q.text.length
    && pages[0].text.slice(q.start, q.end) === q.text, "literal complete quote differs");
  // An already reviewed ordinary HTML span is retained in addition to the full
  // extracted text. This is not a rendered-visibility or document parser claim.
  // The local consumer checks this exact span against the pinned complete HTML.
  need(shape(h, ["start", "end", "html", "sha256"]) && typeof h.html === "string" && h.html.length > 0 && h.html.length <= 8000
    && Number.isSafeInteger(h.start) && h.start >= 0 && h.end === h.start + h.html.length
    && hash(h.sha256) && sha(h.html) === h.sha256 && !/<!--|<\/?(?:script|style|template|noscript|svg|math|textarea|title|iframe|xmp|plaintext)\b/i.test(h.html)
    && !/\b(?:aria-hidden|on\w+)\s*=/i.test(h.html) && reviewedTypography(h.html)
    && !/<[^>]*\s+hidden(?=\s|=|\/?>)/i.test(h.html), "ordinary reviewed HTML span differs");
  const tags = /<\/?(?:div|section|article|h[1-6]|p|span|strong|em|b|i|a|br)\b(?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*\/?\s*>/gi;
  const text = h.html.replace(tags, " ");
  need(!/[<>]/.test(text), "nonordinary quote markup");
  // Decode only the named entities needed by literal professional names; unknown
  // entity forms are retained and therefore cannot create an inferred name.
  const decoded = text.replace(/&amp;/g, "&").replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:rsquo|#8217);/g, "’").replace(/&nbsp;/g, " ");
  need(words(decoded).includes(words(q.text)), "quote is not ordinary text in its HTML span");
  need(!/\b(not|unrelated|formerly|previously|former|customer|client|partner|affiliate|subsidiary|parent|example|fictional)\b/i.test(q.text),
    "conflicting quote attribution");
  return q.text;
}

/** Called only after the existing compiled catalog, exact original row, source
 * transport, canonical hash and distinct source-review gates. No caller supplies
 * this evidence. It records a reviewed company inference, never legal person ID. */
export function verifyRegisteredAgentOperator(args: {
  bridge: RegisteredAgentOperatorBridge; source: Record<string, unknown>; legal: string;
  company: { name: string }; context: CompanyIdentityContext; domain: string;
  observedAt: string; sourceReader: Review; sourceReviewer: Review;
}) {
  const { bridge: b, source, legal, company, context, domain } = args;
  need(shape(b, ["schema", "canonicalName", "siteLegalName", "sourceInputSha256", "primaryDecisionSha256", "independentDecisionSha256",
    "officialAgent", "siteOperator", "pages", "legalQuote", "operatorQuote", "limitations"])
    && b.schema === "reviewed_registered_agent_operator_v1"
    && [b.sourceInputSha256, b.primaryDecisionSha256, b.independentDecisionSha256].every(hash), "reviewed entry binding differs");
  need(b.canonicalName === company.name && sameRegistryLegalName(company.name, legal)
    && sameRegistryLegalName(b.siteLegalName, legal) && context.aliases.every(n => sameRegistryLegalName(n, legal)),
  "whole legal subject or legal form conflicts");
  const a = b.officialAgent, s = b.siteOperator;
  need(shape(a, ["firstName", "middleName", "lastName", "suffix"])
    && a.firstName === source.agentfirstname && a.middleName === (source.agentmiddlename ?? "")
    && a.lastName === source.agentlastname && a.suffix === (source.agentsuffix ?? "")
    && (!source.agentorganizationname || source.agentorganizationname === "")
    && namePart(a.firstName) && namePart(a.lastName) && typeof a.middleName === "string" && typeof a.suffix === "string",
  "literal registered-agent role differs");
  need(shape(s, ["firstName", "lastName", "displayName", "role"]) && namePart(s.firstName) && namePart(s.lastName)
    && personPart(s.firstName) === personPart(a.firstName) && personPart(s.lastName) === personPart(a.lastName)
    && s.displayName === `${s.firstName} ${s.lastName}`
    && /^(?:(?:Founder|Co-Founder|Co-founder) (?:and|&) )?(?:CEO|Chief Executive Officer)(?: (?:and|&) (?:Founder|Co-Founder|Co-founder))?$/.test(s.role),
  "reviewed first-last operator correspondence or role differs");
  need(Array.isArray(b.pages) && b.pages.length >= 1 && b.pages.length <= 3
    && new Set(b.pages.map(p => p.finalUrl)).size === b.pages.length && new Set(b.pages.map(p => p.textSha256)).size === b.pages.length,
  "complete page set absent or ambiguous");
  for (const p of b.pages) {
    need(shape(p, ["requestedUrl", "finalUrl", "status", "contentType", "observedAt", "hops", "htmlSha256", "textSha256", "receiptSha256", "text", "representation"])
      && p.status === 200 && /^text\/html(?:\s*;|$)/i.test(p.contentType) && ownUrl(p.requestedUrl, domain) && ownUrl(p.finalUrl, domain)
      && p.representation === "complete_retained_static_text_v1" && [p.htmlSha256, p.textSha256, p.receiptSha256].every(hash)
      && typeof p.text === "string" && p.text.length > 0 && p.text.length <= 150000 && sha(p.text) === p.textSha256
      && Array.isArray(p.hops) && p.hops.length >= 1 && p.hops.length <= 5
      && p.hops[0].url === p.requestedUrl && p.hops.at(-1)!.url === p.finalUrl
      && p.hops.every((h, i) => shape(h, ["url", "status"]) && ownUrl(h.url, domain)
        && (i === p.hops.length - 1 ? h.status === 200 : [301, 302, 303, 307, 308].includes(h.status))), "own-domain page provenance differs");
    need(registeredAgentOperatorInstant(p.observedAt) <= registeredAgentOperatorInstant(args.sourceReader.reviewedAt), "source reader predates complete page");
  }
  need(registeredAgentOperatorInstant(args.observedAt) <= registeredAgentOperatorInstant(args.sourceReader.reviewedAt)
    && registeredAgentOperatorInstant(args.sourceReader.reviewedAt) <= registeredAgentOperatorInstant(args.sourceReviewer.reviewedAt), "source chronology differs");
  const legalText = quote(b, b.legalQuote), personText = quote(b, b.operatorQuote);
  need((` ${words(legalText)} `).includes(` ${words(b.siteLegalName)} `)
    && completePersonLiteral(personText, s.displayName) && personText.includes(s.role), "legal/operator literal quote differs");
  need(b.pages.every(p => p.textSha256 === b.legalQuote.pageTextSha256 || p.textSha256 === b.operatorQuote.pageTextSha256), "unused page");
  const l = b.limitations;
  need(shape(l, ["association", "statutoryPersonIdentityVerified", "omittedMiddleNamesVerified", "addressEquivalenceClaimed", "agentOwnershipClaimed", "canonicalIdentityChanged", "literalDifferences"])
    && l.association === "independently_reviewed_company_inference" && l.statutoryPersonIdentityVerified === false
    && l.omittedMiddleNamesVerified === false && l.addressEquivalenceClaimed === false && l.agentOwnershipClaimed === false && l.canonicalIdentityChanged === false
    && Array.isArray(l.literalDifferences) && l.literalDifferences.length > 0 && l.literalDifferences.length <= 12
    && l.literalDifferences.every(v => typeof v === "string" && v.trim().length > 0 && v.length <= 1500), "literal inference limits missing");
  return { ...b, bridgeSha256: sha(stableRegistryJson(b)),
    scope: "Independently reviewed company association from the exact official legal entity and literal own-domain company name plus a named CEO/founder corresponding to the registered agent's first and last names. The literal site name may omit the official legal suffix; explicit conflicting legal forms are rejected. This does not certify a statutory person identity, a full legal form from an omitted site suffix, omitted middle names, ownership, address equivalence, relocation, current occupancy or current commercial scale." };
}
