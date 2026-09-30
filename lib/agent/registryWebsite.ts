import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { STATE_NAMES } from "@/lib/publicGrowth/identity";
import { htmlToVisibleText, sameCompanySite } from "@/lib/sources/siteDiscovery";
import { extractCompanyIdentity } from "@/lib/sources/siteContent";
import { fetchPublicHttpText, validatePublicHttpUrl, type PublicHttpTextResponse } from "@/lib/triggers/urlSafety";
import { registryStreet, sameRegistryLegalName, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";

type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
export type RegistryWebsiteCorroboration = {
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
 * and independently attributed the current business address to this legal entity.
 * Mailing/HQ/physical roles remain in the exact quote: matching a mailing address
 * never asserts operations there, and conflicting physical-source roles stay held.
 * Distinct task IDs document review separation; they are not cryptographic proof
 * of different people. Authentication remains the existing agent bridge gate. */
export function registryWebsiteEvidenceHash(row: Pick<RegistryFinding, "companyId" | "internalId" | "profile">,
  proof: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">): string {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId, dataset: row.profile.dataset,
    recordId: row.profile.recordId, rowSha256: row.profile.provenance.rowSha256, ...proof }));
}

export function parseRegistryWebsiteCorroboration(raw: unknown, row: RegistryFinding, now = new Date()): RegistryWebsiteCorroboration {
  if (!object(raw) || Object.keys(raw).some(k => !["sourceUrl", "normalizedVisibleTextSha256", "quote", "quoteSha256", "subject", "address", "reader", "reviewer"].includes(k))
    || !text(raw.sourceUrl, 2000) || !text(raw.quote, 1800) || raw.quote.length < 20 || !text(raw.subject, 200)
    || !hash(raw.normalizedVisibleTextSha256) || !hash(raw.quoteSha256) || sha(raw.quote) !== raw.quoteSha256 || !object(raw.address))
    throw new Error("invalid registry website evidence");
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
      || words(a.state) !== words(p.state) || a.countryCode !== (p.countryCode ?? "US")
      || (a.countryCode === "CA" ? words(a.postalCode).replace(/ /g, "") !== words(p.postalCode).replace(/ /g, "") : a.postalCode.slice(0, 5) !== p.postalCode.slice(0, 5)))
      throw new Error("registry website complete address is not corroborated");
    const exactStreet = registryStreet(a) === registryStreet(p);
    // FMCSA's verified USDOT binds this narrow highway-format discrepancy. No
    // unit, house number, road number, country or postal evidence is discarded.
    const dot = row.profile.dataset === "fmcsa" && /^\d+$/.test(row.profile.recordId)
      && String(row.profile.provenance.sourceRow.usdot_number) === row.profile.recordId
      && new RegExp(`\\b(?:US\\s*)?DOT\\s*#?\\s*${row.profile.recordId}\\b`, "i").test(proof.quote);
    const highwayEquivalent = dot && registryStreet(a).replace(/\bus hwy\b/g, "hwy") === registryStreet(p).replace(/\bus hwy\b/g, "hwy");
    if (!exactStreet && !highwayEquivalent) throw new Error("registry website street or unit differs from source record");
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
    const sourceId = `website:sha256:${proof.normalizedVisibleTextSha256}`;
    return { method: "official_website_corroboration", verifiedAt: now.toISOString(), sourceIds: [sourceId], website: {
      ...proof, finalUrl: page.finalUrl, fetchedAt: now.toISOString(), htmlSha256: sha(page.body), quoteStart: start, quoteEnd: start + proof.quote.length,
      binding: exactStreet ? "exact_legal_name_address" : "exact_usdot_highway_format", registryAddress: p,
      priorAddresses: context.addresses, structuredIdentity: extractCompanyIdentity(page.body, page.finalUrl, candidate => sameCompanySite(candidate, page.finalUrl)) ?? null,
    } };
  };
}
