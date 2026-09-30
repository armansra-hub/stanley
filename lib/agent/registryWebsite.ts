import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { STATE_NAMES } from "@/lib/publicGrowth/identity";
import { htmlToVisibleText, sameCompanySite } from "@/lib/sources/siteDiscovery";
import { extractCompanyIdentity } from "@/lib/sources/siteContent";
import { fetchPublicHttpText, validatePublicHttpUrl, type PublicHttpTextResponse } from "@/lib/triggers/urlSafety";
import { registryContentHash, registryStreet, sameRegistryLegalName, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";

type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
export type RegistryWebsiteCorroboration = {
  mode?: "registry_identifier";
  identifier?: { kind: "usdot" | "ein"; value: string };
  sourceUrl: string; normalizedVisibleTextSha256: string; quote: string; quoteSha256: string; subject: string;
  address: Omit<RegistryProfile["identity"], "legalName"> & { city: string; countryCode: "US" | "CA" };
  reader: Attestation; reviewer: Attestation;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const contains = (quote: string, value: string) => (` ${words(quote)} `).includes(` ${words(value)} `);
const stateNames = new Map(STATE_NAMES.split("|").map(entry => { const [name, code] = entry.split(":"); return [code, name]; }));

/** Both actual tasks attest that they read this exact passage in its page context
 * and attributed its address and optional registry identifier to this legal entity.
 * Mailing/HQ/physical roles remain in the exact quote. Identifier mode preserves
 * both addresses as separate observations; it does not establish their equivalence.
 * Distinct task IDs document review separation; they are not cryptographic proof
 * of different people. Authentication remains the existing agent bridge gate. */
export function registryWebsiteEvidenceHash(row: Pick<RegistryFinding, "companyId" | "internalId" | "profile"> & Partial<Pick<RegistryFinding, "sourceUrl" | "detail" | "evidence">>,
  proof: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">): string {
  const legacy = { companyId: row.companyId, internalId: row.internalId, dataset: row.profile.dataset,
    recordId: row.profile.recordId, rowSha256: row.profile.provenance.rowSha256, ...proof };
  if (proof.mode !== "registry_identifier") return sha(stableRegistryJson(legacy));
  // Existing address-mode callers may pass a narrow row. Identifier mode must
  // bind the entire parsed publication content, not trust an unchanged row ID/hash.
  if (typeof row.sourceUrl !== "string" || !row.sourceUrl || typeof row.evidence !== "string" || !row.evidence
    || row.detail !== null && typeof row.detail !== "string"
    || typeof row.profile.observedAt !== "string" || !Number.isFinite(Date.parse(row.profile.observedAt)))
    throw new Error("registry identifier evidence requires complete parsed publication content");
  return sha(stableRegistryJson({ ...legacy, identifierContent: {
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt,
  } }));
}

export function parseRegistryWebsiteCorroboration(raw: unknown, row: RegistryFinding, now = new Date()): RegistryWebsiteCorroboration {
  if (!object(raw) || Object.keys(raw).some(k => !["sourceUrl", "normalizedVisibleTextSha256", "quote", "quoteSha256", "subject", "address", "reader", "reviewer", "mode", "identifier"].includes(k))
    || !text(raw.sourceUrl, 2000) || !text(raw.quote, 1800) || raw.quote.length < 20 || !text(raw.subject, 200)
    || !hash(raw.normalizedVisibleTextSha256) || !hash(raw.quoteSha256) || sha(raw.quote) !== raw.quoteSha256 || !object(raw.address))
    throw new Error("invalid registry website evidence");
  if (raw.mode !== undefined && raw.mode !== "registry_identifier" || raw.mode === undefined && raw.identifier !== undefined)
    throw new Error("invalid registry website mode");
  if (raw.mode === "registry_identifier") identifierRule(row, raw.identifier);
  const a = raw.address;
  if (Object.keys(a).some(k => !["addressLine1", "addressLine2", "city", "state", "postalCode", "countryCode"].includes(k))
    || !["addressLine1", "city", "state", "postalCode"].every(k => text(a[k], 200))
    || a.addressLine2 !== undefined && !text(a.addressLine2, 200) || !["US", "CA"].includes(String(a.countryCode)))
    throw new Error("invalid registry website address");
  const { reader, reviewer, ...evidence } = raw;
  const evidenceSha256 = registryWebsiteEvidenceHash(row, evidence as Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">);
  for (const attestation of [reader, reviewer]) {
    if (!object(attestation) || Object.keys(attestation).some(k => !["taskId", "reviewedAt", "evidenceSha256"].includes(k))
      || !text(attestation.taskId, 160) || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(attestation.taskId)
      || typeof attestation.reviewedAt !== "string" || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(attestation.reviewedAt)
      || !Number.isFinite(Date.parse(attestation.reviewedAt)) || Date.parse(attestation.reviewedAt) > now.getTime() + 60_000
      || now.getTime() - Date.parse(attestation.reviewedAt) > 7 * 86_400_000 || attestation.evidenceSha256 !== evidenceSha256)
      throw new Error("registry website review does not bind exact current evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("registry website requires independent review");
  return raw as RegistryWebsiteCorroboration;
}


type Identifier = NonNullable<RegistryWebsiteCorroboration["identifier"]>;
function identifierRule(row: RegistryFinding, identifier: unknown): Identifier {
  if (!object(identifier) || Object.keys(identifier).some(k => !["kind", "value"].includes(k))
    || !text(identifier.value, 12)) throw new Error("invalid registry website identifier");
  const isDot = row.profile.dataset === "fmcsa" && identifier.kind === "usdot";
  const isEin = row.profile.dataset === "irs_exempt" && identifier.kind === "ein";
  const field = isDot ? "usdot_number" : "ein", value = identifier.value;
  if ((!isDot && !isEin) || !(isDot ? /^[1-9]\d{3,8}$/ : /^\d{9}$/).test(value)
    || row.profile.recordId !== value || String(row.profile.provenance.sourceRow[field]) !== value
    || row.profile.facts.filter(f => f.field === field && String(f.value) === value).length !== 1
    || (row.profile.identity.countryCode ?? "US") !== "US")
    throw new Error("registry website identifier does not bind exact source dataset, record and fact");
  return identifier as Identifier;
}
function labelledIdentifiers(value: string, kind: Identifier["kind"]) {
  // Closed public labels. A generic number, phone, MC number or tax deduction is not an ID.
  const re = kind === "usdot"
    ? /\b(?:USDOT|US\s+DOT|U\.S\.\s*DOT|DOT)\s*(?:(?:number|no\.?)\s*)?[:#]?\s*([1-9]\d{3,8})(?![a-z0-9])/gi
    : /\b(?:EIN|Employer Identification Number|Federal Tax (?:ID|Identification Number))\s*(?:(?:number|no\.?)\s*)?[:#]?\s*(\d{2}-?\d{7})(?![a-z0-9])/gi;
  return [...value.matchAll(re)].map(m => ({ value: m[1].replace(/-/g, ""), start: m.index!, end: m.index! + m[0].length }));
}
function legalParts(value: string) {
  const normalized = words(value).replace(/\b(l l c|l l p|p l l c|l p|p c)$/, suffix => suffix.replace(/ /g, ""));
  const suffix = normalized.match(/\s+(incorporated|inc|corporation|corp|limited|ltd|llc|llp|pllc|lp|pc)$/);
  const equivalents: Record<string, string> = { incorporated: "inc", corporation: "corp", limited: "ltd" };
  return { core: suffix ? normalized.slice(0, suffix.index) : normalized, suffix: suffix ? equivalents[suffix[1]] ?? suffix[1] : null };
}
function exactSubjectPositions(value: string, subject: string): number[] {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...value.matchAll(new RegExp(escaped, "giu"))];
  if (!matches.length) throw new Error("registry identifier full legal subject is missing");
  for (const match of matches) {
    const at = match.index!, end = at + match[0].length;
    if (/[\p{L}\p{N}_'’&-]/u.test(value[at - 1] ?? "") || /[\p{L}\p{N}_'’&-]/u.test(value[end] ?? ""))
      throw new Error("registry identifier legal subject lacks exact token boundaries");
    const before = value.slice(Math.max(0, at - 120), at), after = value.slice(end, end + 120);
    const clause = before.split(/[.!?;\n]/).at(-1) ?? "";
    if (/\b(?:not|never|neither|unrelated|no (?:affiliation|association|connection|relationship))\b/i.test(clause)
      || /^\s*(?:(?:is|are|was|were)\s+)?(?:not|never|unrelated)\b/i.test(after))
      throw new Error("registry identifier legal subject is negated or unrelated");
    // A leading word can be part of a different legal name ('Global Acme Inc').
    // Only closed, neutral sentence/header connectors are accepted here. This
    // conservative guard is not a parser or a substitute for both full readers.
    const prefix = before.match(/([\p{L}][\p{L}'’&-]*)\s+$/u)?.[1];
    if (prefix && !/^(?:about|contact|copyright|name|legal|company|to|by|is|are|of)$/i.test(prefix))
      throw new Error("registry identifier legal subject has an ambiguous name prefix");
  }
  return matches.map(match => match.index!);
}
function identifierAttribution(row: RegistryFinding, proof: RegistryWebsiteCorroboration, visibleText: string) {
  const identifier = identifierRule(row, proof.identifier), quoteIds = labelledIdentifiers(proof.quote, identifier.kind);
  const pageIds = labelledIdentifiers(visibleText, identifier.kind);
  if (!quoteIds.length || !pageIds.length || pageIds.some(id => id.value !== identifier.value)
    || quoteIds.some(id => id.value !== identifier.value))
    throw new Error("registry website labelled identifier is missing or conflicting");
  const legal = legalParts(row.profile.identity.legalName), subject = legalParts(proof.subject);
  // New mode requires an explicit matching legal form when the source has one.
  if (legal.core !== subject.core || legal.suffix && legal.suffix !== subject.suffix)
    throw new Error("registry identifier requires the exact full legal subject");
  const normalized = " " + words(visibleText).replace(/\b(l l c|l l p|p l l c|l p|p c)\b/g, suffix => suffix.replace(/ /g, "")) + " ";
  for (const suffix of ["incorporated", "inc", "corporation", "corp", "limited", "ltd", "llc", "llp", "pllc", "lp", "pc"]) {
    const candidate = legalParts(legal.core + " " + suffix);
    if (normalized.includes(" " + legal.core + " " + suffix + " ") && candidate.suffix !== (legal.suffix ?? subject.suffix))
      throw new Error("registry website has conflicting legal forms");
  }
  // A selected passage containing relationship or historic ownership ambiguity is held.
  if (/\b(customer|client|partner|affiliate|subsidiar(?:y|ies)|parent company|third[ -]party|on behalf of|formerly|previously|former|previous|old (?:DOT|USDOT|EIN))\b/i.test(proof.quote))
    throw new Error("registry website identifier attribution is ambiguous");
  const subjects = exactSubjectPositions(proof.quote, proof.subject);
  exactSubjectPositions(visibleText, proof.subject);
  if (!subjects.some(subjectAt => quoteIds.some(id => Math.min(Math.abs(id.start - subjectAt), Math.abs(id.end - (subjectAt + proof.subject.length))) <= 650)))
    throw new Error("registry website identifier is not beside its legal subject");
  // Do not borrow the same number from a customer/carrier reference elsewhere on the page.
  for (const id of pageIds) {
    const vicinity = visibleText.slice(Math.max(0, id.start - 100), Math.min(visibleText.length, id.end + 100));
    if (/\b(?:(?:customer|client|partner|affiliate|subsidiary|parent company|third[ -]party|other carrier|another carrier)(?:'s|’s)?|belongs to|licensed to|on behalf of|former (?:DOT|USDOT|EIN)|previous (?:DOT|USDOT|EIN)|old (?:DOT|USDOT|EIN)|not (?:our|the) (?:DOT|USDOT|EIN)|does not (?:belong|identify)|not assigned)\b/i.test(vicinity))
      throw new Error("registry website identifier has an ambiguous surrounding reference");
  }
}

function ownUrl(value: string, domain: string): string {
  const url = validatePublicHttpUrl(value);
  // Exact stored host (with optional www), not a caller-selected subsidiary host.
  const base = validatePublicHttpUrl(domain.includes("://") ? domain : `https://${domain}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) throw new Error("registry website must use the canonical own-domain");
  return url.toString();
}

/** Request-local cache only. Three bounded public fetches fit the route's 60s
 * envelope; a changed page fails closed and needs a new independent review. */
export function registryWebsiteVerifier() {
  const pages = new Map<string, Promise<PublicHttpTextResponse>>();
  return async (row: RegistryFinding, proof: RegistryWebsiteCorroboration, company: { name: string; domain?: string | null; website_raw?: string | null },
    context: CompanyIdentityContext, now = new Date()): Promise<NonNullable<RegistryProfile["verification"]>> => {
    const identifierMode = proof.mode === "registry_identifier";
    // This new mode always revalidates its fresh, separately bound attestations.
    if (identifierMode) proof = parseRegistryWebsiteCorroboration(proof, row, now);
    const domain = company.domain || company.website_raw;
    if (!domain) throw new Error("registry website canonical domain is missing");
    const url = ownUrl(proof.sourceUrl, domain), p = row.profile.identity, a = proof.address;
    if (![company.name, ...context.aliases].some(name => sameRegistryLegalName(name, proof.subject))
      || !sameRegistryLegalName(proof.subject, p.legalName) || !proof.quote.includes(proof.subject)) throw new Error("registry website subject does not match canonical legal entity");
    // Relationship/location ambiguities stay held even on the account's own site.
    if (/\b(subsidiar(?:y|ies)|parent company|registered agent|customer(?:'s|’s)? (?:address|office|headquarters)|client(?:'s|’s)? (?:address|office)|former (?:address|office)|previous (?:address|office)|old (?:address|office))\b/i.test(proof.quote))
      throw new Error("registry website address attribution is ambiguous");
    const stateSpellings = [a.state, ...(a.countryCode === "US" && stateNames.has(a.state) ? [stateNames.get(a.state)!] : [])];
    if (![a.addressLine1, a.addressLine2].filter((v): v is string => Boolean(v)).every(value => contains(proof.quote, value))
      || !stateSpellings.some(state => contains(proof.quote, `${a.city} ${state} ${a.postalCode}`))
      || (!identifierMode && (words(a.state) !== words(p.state) || a.countryCode !== (p.countryCode ?? "US")
      || (a.countryCode === "CA" ? words(a.postalCode).replace(/ /g, "") !== words(p.postalCode).replace(/ /g, "") : a.postalCode.slice(0, 5) !== p.postalCode.slice(0, 5)))))
      throw new Error("registry website complete address is not corroborated");
    if (identifierMode && (a.countryCode !== "US" || !stateNames.has(a.state) || !/^\d{5}(?:-\d{4})?$/.test(a.postalCode)))
      throw new Error("registry identifier requires an explicit complete US website address");
    if (identifierMode) identifierAttribution(row, proof, proof.quote);
    const exactStreet = registryStreet(a) === registryStreet(p);
    // FMCSA's verified USDOT binds this narrow highway-format discrepancy. No
    // unit, house number, road number, country or postal evidence is discarded.
    const dot = row.profile.dataset === "fmcsa" && /^\d+$/.test(row.profile.recordId)
      && String(row.profile.provenance.sourceRow.usdot_number) === row.profile.recordId
      && new RegExp(`\\b(?:US\\s*)?DOT\\s*#?\\s*${row.profile.recordId}\\b`, "i").test(proof.quote);
    const highwayEquivalent = dot && registryStreet(a).replace(/\bus hwy\b/g, "hwy") === registryStreet(p).replace(/\bus hwy\b/g, "hwy");
    if (!identifierMode && !exactStreet && !highwayEquivalent) throw new Error("registry website street or unit differs from source record");
    if (!pages.has(url)) {
      if (pages.size >= 3) throw new Error("registry website request exceeds three source pages");
      pages.set(url, fetchPublicHttpText(url, { timeoutMs: 8000, maxBytes: 2_000_000, maxRedirects: 2, accept: "text/html,application/xhtml+xml" }));
    }
    let page: PublicHttpTextResponse;
    try { page = await pages.get(url)!; } catch { throw new Error("registry website source unavailable"); }
    ownUrl(page.finalUrl, domain);
    if (page.status !== 200 || !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType ?? "")) throw new Error("registry website full HTML unavailable");
    const visibleText = htmlToVisibleText(page.body), start = visibleText.indexOf(proof.quote);
    if (sha(visibleText) !== proof.normalizedVisibleTextSha256 || start < 0) throw new Error("registry website changed or exact reviewed quote missing");
    if (identifierMode) identifierAttribution(row, proof, visibleText);
    const sourceId = `website:sha256:${proof.normalizedVisibleTextSha256}`;
    return { method: "official_website_corroboration", verifiedAt: now.toISOString(), sourceIds: [sourceId], website: {
      ...proof, finalUrl: page.finalUrl, fetchedAt: now.toISOString(), htmlSha256: sha(page.body), quoteStart: start, quoteEnd: start + proof.quote.length,
      binding: identifierMode ? "exact_" + proof.identifier!.kind + "_legal_subject" : exactStreet ? "exact_legal_name_address" : "exact_usdot_highway_format", registryAddress: p,
      ...(identifierMode ? { websiteAddress: a, addressRelationship: "separate_observations_not_address_equivalence" } : {}),
      priorAddresses: context.addresses, structuredIdentity: extractCompanyIdentity(page.body, page.finalUrl, candidate => sameCompanySite(candidate, page.finalUrl)) ?? null,
    } };
  };
}
