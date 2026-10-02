import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { fetchPublicHttpText, validatePublicHttpUrl, type PublicHttpTextResponse } from "@/lib/triggers/urlSafety";
import { registryWebsiteText } from "./registryWebsiteText";
import { registryContentHash, sameRegistryLegalName, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import { registrySamCanonicalHash } from "./registrySam";
import manifest from "./registryIrsFilings.json";

// Build-generated from reviewed official ZIP members. New entries require the
// same source/code review and release as this manifest; caller XML is not trusted.
type Entry = typeof manifest.entries[number];
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
export type RegistryIrsFilingCorroboration = {
  schema: "irs990_ein_domain_v1"; entryId: string; entrySha256: string; canonicalIdentitySha256: string;
  mode: "declared_domain" | "observed_redirect";
  redirect?: { requestedUrl: string; finalUrl: string; normalizedVisibleTextSha256: string; observedAt: string };
  reader: Attestation; reviewer: Attestation;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (x: unknown): x is Record<string, unknown> => Boolean(x && typeof x === "object" && !Array.isArray(x));
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const iso = (x: unknown): x is string => typeof x === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
const exactKeys = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every(k => keys.includes(k)) && keys.every(k => k in x);
export const registryIrsFilingCanonicalHash = registrySamCanonicalHash;
export function registryIrsFilingEntry(id: string): { entry: Entry; sha256: string } {
  const entries = manifest.entries.filter(e => e.id === id);
  if (manifest.schema !== "reviewed_irs990_entries_v1" || entries.length !== 1) throw new Error("IRS filing entry is not reviewed");
  // Return a copy: no caller can mutate the trusted imported manifest.
  const entry = structuredClone(entries[0]);
  return { entry, sha256: sha(stableRegistryJson(entry)) };
}
function rootUrl(value: string): string {
  const u = validatePublicHttpUrl(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash || u.toString() !== value)
    throw new Error("IRS domain continuity requires an exact public HTTPS root");
  return u.toString();
}
function domain(value: string | null | undefined): string {
  if (!value || /\s/.test(value)) throw new Error("IRS canonical/declared domain missing");
  const u = validatePublicHttpUrl(value.includes("://") ? value : `https://${value}`), h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(h) || /^\d+(?:\.\d+){3}$/.test(h)
    || ["facebook.com", "linkedin.com", "instagram.com", "youtube.com", "twitter.com", "x.com", "wixsite.com", "wordpress.com"].some(x => h === x || h.endsWith(`.${x}`)))
    throw new Error("IRS filing requires an unambiguous organization domain");
  return h;
}
function declaredRoot(entry: Entry): string {
  domain(entry.filing.websiteAddressTxt);
  const u = new URL(entry.filing.websiteAddressTxt.includes("://") ? entry.filing.websiteAddressTxt : `https://${entry.filing.websiteAddressTxt}`);
  u.protocol = "https:";
  return rootUrl(u.toString());
}
export function registryIrsFilingEvidenceHash(row: RegistryFinding, proof: Omit<RegistryIrsFilingCorroboration, "reader" | "reviewer">): string {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId,
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail), evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
export function parseRegistryIrsFilingCorroboration(raw: unknown, row: RegistryFinding, now = new Date()): RegistryIrsFilingCorroboration {
  const keys = ["schema", "entryId", "entrySha256", "canonicalIdentitySha256", "mode", "reader", "reviewer"];
  if (!object(raw) || !exactKeys(raw, raw.mode === "observed_redirect" ? [...keys, "redirect"] : keys)
    || raw.schema !== "irs990_ein_domain_v1" || typeof raw.entryId !== "string" || !hash(raw.entrySha256) || !hash(raw.canonicalIdentitySha256)
    || !["declared_domain", "observed_redirect"].includes(String(raw.mode))) throw new Error("invalid IRS filing evidence");
  const { entry, sha256 } = registryIrsFilingEntry(raw.entryId);
  if (raw.entrySha256 !== sha256) throw new Error("IRS filing entry changed");
  let observedAt = entry.sourceReviews.reviewedAt;
  if (raw.mode === "observed_redirect") {
    const r = raw.redirect;
    if (!object(r) || !exactKeys(r, ["requestedUrl", "finalUrl", "normalizedVisibleTextSha256", "observedAt"])
      || typeof r.requestedUrl !== "string" || typeof r.finalUrl !== "string" || !hash(r.normalizedVisibleTextSha256) || !iso(r.observedAt)
      || Date.parse(r.observedAt) > now.getTime() + 60000 || rootUrl(r.requestedUrl) !== declaredRoot(entry)
      || rootUrl(r.finalUrl) === r.requestedUrl) throw new Error("invalid IRS filing redirect evidence");
    observedAt = new Date(Math.max(Date.parse(observedAt), Date.parse(r.observedAt))).toISOString();
  }
  const { reader, reviewer, ...proof } = raw;
  const evidenceSha256 = registryIrsFilingEvidenceHash(row, proof as Omit<RegistryIrsFilingCorroboration, "reader" | "reviewer">);
  for (const a of [reader, reviewer]) {
    if (!object(a) || !exactKeys(a, ["taskId", "reviewedAt", "evidenceSha256"])
      || typeof a.taskId !== "string" || a.taskId.length > 160 || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(a.taskId)
      || !iso(a.reviewedAt) || Date.parse(a.reviewedAt) < Math.max(Date.parse(observedAt), Date.parse(row.profile.observedAt))
      || Date.parse(a.reviewedAt) > now.getTime() + 60000 || now.getTime() - Date.parse(a.reviewedAt) > 7 * 86400000 || a.evidenceSha256 !== evidenceSha256)
      throw new Error("IRS filing review does not bind exact current publication evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("IRS filing requires independent review");
  return structuredClone(raw) as RegistryIrsFilingCorroboration;
}
function originalEin(row: RegistryFinding): string {
  const p = row.profile, parts = row.evidence.split("\nOriginal public source row: ");
  if (p.dataset !== "irs_exempt" || !/^\d{9}$/.test(p.recordId) || (p.identity.countryCode ?? "US") !== "US" || parts.length !== 2
    || sha(parts[1]) !== p.provenance.rowSha256) throw new Error("IRS filing requires the exact original BMF row");
  let raw: Record<string, unknown>, compact: unknown;
  try { raw = JSON.parse(parts[1]); compact = JSON.parse(parts[0]); } catch { throw new Error("invalid original IRS row framing"); }
  if (!object(raw) || stableRegistryJson(compact) !== stableRegistryJson(p.provenance.sourceRow)
    || raw.EIN !== p.recordId || p.provenance.sourceRow.ein !== p.recordId
    || p.facts.filter(f => f.field === "ein" && f.value === p.recordId).length !== 1
    || raw.NAME !== p.identity.legalName || raw.STREET !== p.identity.addressLine1 || raw.CITY !== p.identity.city
    || raw.STATE !== p.identity.state || raw.ZIP !== p.identity.postalCode)
    throw new Error("IRS filing identifier or original identity differs");
  return p.recordId;
}
/** Request-local bounded cache. The route also sums both verifier budgets. */
export function registryIrsFilingVerifier() {
  const pages = new Map<string, Promise<PublicHttpTextResponse>>();
  return async (row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now = new Date()): Promise<NonNullable<RegistryProfile["verification"]>> => {
    // Reparse even a previously parsed proof: changed content/identity cannot replay witnesses.
    const proof = parseRegistryIrsFilingCorroboration(raw, row, now), { entry } = registryIrsFilingEntry(proof.entryId), f = entry.filing;
    if (originalEin(row) !== f.ein || company.id !== row.companyId || company.netsuite_internal_id !== row.internalId
      || proof.canonicalIdentitySha256 !== registryIrsFilingCanonicalHash(company, context)) throw new Error("IRS filing canonical identity or EIN changed");
    const legal = f.legalName + ("legalNameLine2" in f ? ` ${f.legalNameLine2}` : "");
    if (!sameRegistryLegalName(legal, row.profile.identity.legalName) || !sameRegistryLegalName(legal, company.name)
      || context.aliases.some(name => !sameRegistryLegalName(legal, name))) throw new Error("IRS filing legal operator conflicts");
    const canonicalHost = domain(company.domain || company.website_raw), filingHost = domain(f.websiteAddressTxt);
    let observedRedirect: Record<string, unknown> | undefined;
    if (proof.mode === "declared_domain") {
      if (filingHost !== canonicalHost) throw new Error("IRS filing declared domain differs from canonical");
    } else {
      const r = proof.redirect!;
      if (filingHost === canonicalHost || domain(r.finalUrl) !== canonicalHost) throw new Error("IRS filing redirect does not reach the exact canonical domain");
      if (!pages.has(r.requestedUrl)) {
        if (pages.size >= 3) throw new Error("IRS filing requests capped at three sources");
        pages.set(r.requestedUrl, fetchPublicHttpText(r.requestedUrl, { timeoutMs: 8000, maxBytes: 2_000_000, maxRedirects: 2, accept: "text/html,application/xhtml+xml" }));
      }
      let page: PublicHttpTextResponse;
      try { page = await pages.get(r.requestedUrl)!; } catch { throw new Error("IRS filing domain continuity unavailable"); }
      if (page.status !== 200 || !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType ?? "") || page.finalUrl !== r.finalUrl
        || sha(registryWebsiteText(page.body)) !== r.normalizedVisibleTextSha256) throw new Error("IRS filing observed redirect or full page changed");
      observedRedirect = { ...r, status: page.status, verifiedAt: now.toISOString(), htmlSha256: sha(page.body) };
    }
    return { method: "reviewed_irs_filing_ein_domain", verifiedAt: now.toISOString(), sourceIds: [`irs990:${entry.id}:${entry.xmlSha256}`], irsFiling: {
      ...proof, entry, ...(observedRedirect ? { observedRedirect } : {}), registryAddress: row.profile.identity, canonicalAddresses: context.addresses,
      scope: "Exact filer EIN/legal name and declared domain; addresses remain separate dated observations. No financial fact, canonical field or historical domain ownership is inferred." } };
  };
}
