import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { sameRegistryLegalName, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import type { RegistryOfficialApiEntry, RegistryOfficialApiCorroboration } from "./registryOfficialApi";

type Review = RegistryOfficialApiEntry["sourceReader"];
type CsvRow = { member: string; headers: string[]; headersSha256: string; rawRow: string; rawRowSha256: string;
  headerReceiptSha256: string; memberSha256?: string; memberCrc32: string; dataRecordNumber?: number };
export type RegistryNppesEndpointEntry = Omit<RegistryOfficialApiEntry, "sourceKind" | "source" | "target" | "anchor" | "nameBridge" | "siteOperatorBridge"> & {
  sourceKind: "nppes_organization_endpoint";
  source: { requestedUrl: string; finalUrl: string; status: "downloaded"; contentType: string; observedAt: string;
    sourceAsOf: string; archiveSha256: string; downloadReceiptSha256: string; extractionReceiptSha256: string;
    extractedAt: string; completeMemberStreamsAndCrcVerified: true; main: CsvRow; endpoint: CsvRow; practice: CsvRow };
  target: Omit<RegistryOfficialApiEntry["target"], "dataset"> & { dataset: "cms_nppes" };
  anchor: { mode: "organization_direct_endpoint_and_own_site_phone"; originalAddressRole: "provider_practice" };
  website: { requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
    hops: { url: string; status: number }[]; htmlSha256: string; text: string; textSha256: string;
    receiptSha256: string; quote: string; subject: string; phoneAsDisplayed: string };
};
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const iso = (s: unknown): s is string => typeof s === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
const task = (s: unknown): s is string => typeof s === "string" && s.length <= 160 && /^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(s);
const literal = (s: string) => s.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
function need(v: unknown, why: string): asserts v { if (!v) throw Error(`official NPPES ${why}`); }
function csv(part: CsvRow, prefix: string, date: string, supplemental: boolean) {
  need(part.member === `${prefix}_pfile_20050523-${date.replaceAll("-", "")}.csv`
    && hash(part.headersSha256) && sha(stableRegistryJson(part.headers)) === part.headersSha256
    && hash(part.rawRowSha256) && part.rawRow.length > 0 && part.rawRow.length <= 32000 && sha(part.rawRow) === part.rawRowSha256
    && hash(part.headerReceiptSha256) && /^[a-f0-9]{8}$/.test(part.memberCrc32)
    && (!supplemental || hash(part.memberSha256) && Number.isInteger(part.dataRecordNumber) && part.dataRecordNumber! > 0), "CSV member/row provenance invalid");
  const rows = parseCsv(part.rawRow);
  need(rows.length === 1 && part.headers.length >= 10 && part.headers.length <= 500
    && new Set(part.headers).size === part.headers.length && part.headers.every(h => typeof h === "string" && h.length > 0)
    && rows[0].length === part.headers.length, "complete unique CSV header and single row required");
  return Object.fromEntries(part.headers.map((h, i) => [h, rows[0][i]]));
}
function organizationAddress(row: Record<string, string>) {
  return ["Provider First Line Business Practice Location Address", "Provider Second Line Business Practice Location Address",
    "Provider Business Practice Location Address City Name", "Provider Business Practice Location Address State Name",
    "Provider Business Practice Location Address Postal Code", "Provider Business Practice Location Address Country Code (If outside U.S.)"].map(k => row[k]);
}
function sameAddress(a: string[], b: string[]) {
  return a.length === 6 && b.length === 6 && a.every(x => typeof x === "string") && b.every(x => typeof x === "string")
    && [0, 2, 3, 4, 5].every(i => a[i].length > 0 && b[i].length > 0) && a[5] === "US" && b[5] === "US"
    && a.every((v, i) => i === 4 ? /^\d{5}(?:-?\d{4})?$/.test(v) && /^\d{5}(?:-?\d{4})?$/.test(b[i]) && v.replace("-", "") === b[i].replace("-", "") : literal(v) === literal(b[i]));
}
function sourcePair(a: Review, b: Review, earliest: number) {
  need([a, b].every(r => task(r.taskId) && iso(r.reviewedAt) && hash(r.receiptSha256) && Date.parse(r.reviewedAt) >= earliest)
    && a.taskId !== b.taskId && Date.parse(b.reviewedAt) >= Date.parse(a.reviewedAt), "distinct actual source review lineage invalid");
}
// Only the deployment-reviewed catalog supplies CSVs and full page evidence.
// The ordinary official_api_roles_v1 caller provides its pinned ID and witnesses.
export function verifyRegistryNppesEndpoint(row: RegistryFinding, raw: RegistryOfficialApiCorroboration,
  entry: RegistryNppesEndpointEntry, company: Company, context: CompanyIdentityContext, now: Date,
  bindings: { entrySha256: string; canonicalIdentitySha256: string; evidenceSha256: string;
    canonicalDomain: string | null; endpointDomain: (value: unknown) => string | null }): NonNullable<RegistryProfile["verification"]> {
  const s = entry.source, p = row.profile, t = entry.target, site = entry.website;
  need(raw.entrySha256 === bindings.entrySha256 && entry.sourceKind === "nppes_organization_endpoint"
    && !Object.hasOwn(entry, "nameBridge") && !Object.hasOwn(entry, "siteOperatorBridge")
    && entry.anchor.mode === "organization_direct_endpoint_and_own_site_phone" && entry.anchor.originalAddressRole === "provider_practice", "entry or role differs");
  need(company.id === entry.companyId && row.companyId === entry.companyId && company.netsuite_internal_id === entry.internalId && row.internalId === entry.internalId
    && bindings.canonicalDomain === entry.canonicalDomain && hash(entry.canonicalIdentitySha256)
    && raw.canonicalIdentitySha256 === entry.canonicalIdentitySha256 && raw.canonicalIdentitySha256 === bindings.canonicalIdentitySha256, "canonical fence differs");
  need(/^https:\/\/download\.cms\.gov\/nppes\/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip$/.test(s.requestedUrl)
    && s.requestedUrl === s.finalUrl && s.requestedUrl === row.sourceUrl && s.status === "downloaded" && s.contentType === "application/zip"
    && iso(s.observedAt) && iso(s.extractedAt) && Date.parse(s.extractedAt) >= Date.parse(s.observedAt)
    && /^\d{4}-\d{2}-\d{2}$/.test(s.sourceAsOf) && s.completeMemberStreamsAndCrcVerified === true
    && [s.archiveSha256, s.downloadReceiptSha256, s.extractionReceiptSha256].every(hash), "official archive provenance invalid");
  need(p.dataset === "cms_nppes" && t.dataset === p.dataset && /^[12]\d{9}$/.test(p.recordId) && p.recordId === t.recordId
    && row.sourceUrl === t.sourceUrl && p.sourceAsOf === t.sourceAsOf && p.sourceAsOf === s.sourceAsOf && p.observedAt === t.observedAt && p.observedAt === s.observedAt
    && p.provenance.rowSha256 === t.rowSha256 && row.evidence === p.provenance.quote && row.evidence === s.main.rawRow
    && sha(row.evidence) === t.evidenceSha256 && sha(row.evidence) === p.provenance.rowSha256
    && sha(stableRegistryJson(p.identity)) === t.identitySha256 && sha(stableRegistryJson(p.provenance.sourceRow)) === t.sourceRowSha256
    && sha(stableRegistryJson(p.facts.map(({field,value}) => ({field,value})))) === t.factsSha256, "original target content changed");
  const main = csv(s.main, "npidata", s.sourceAsOf, false), endpoint = csv(s.endpoint, "endpoint", s.sourceAsOf, true), practice = csv(s.practice, "pl", s.sourceAsOf, true);
  const legal = main["Provider Organization Name (Legal Business Name)"], parent = main["Parent Organization LBN"], subpart = main["Is Organization Subpart"];
  need([main, endpoint, practice].every(r => r.NPI === p.recordId) && main["Entity Type Code"] === "2" && main["Replacement NPI"] === ""
    && main["Provider Last Name (Legal Name)"] === "" && main["Provider First Name"] === ""
    && legal === p.identity.legalName && sameRegistryLegalName(company.name, legal) && context.aliases.every(n => sameRegistryLegalName(n, legal))
    && (subpart === "Y" && !!parent && sameRegistryLegalName(parent, legal) || subpart === "N" && (!parent || sameRegistryLegalName(parent, legal))), "exact organizational NPI/name/subpart conflict");
  need(endpoint["Endpoint Type"] === "DIRECT" && endpoint["Endpoint Type Description"] === "Direct Messaging Address"
    && endpoint.Affiliation === "N" && endpoint["Affiliation Legal Business Name"] === ""
    && bindings.endpointDomain(endpoint.Endpoint) === entry.canonicalDomain, "DIRECT organizational endpoint/domain/affiliation differs");
  const originalAddress = organizationAddress(main), targetAddress = [p.identity.addressLine1, p.identity.addressLine2 ?? "", p.identity.city!, p.identity.state!, p.identity.postalCode!, p.identity.countryCode!];
  const endpointAddress = ["Affiliation Address Line One", "Affiliation Address Line Two", "Affiliation Address City", "Affiliation Address State", "Affiliation Address Postal Code", "Affiliation Address Country"].map(k => endpoint[k]);
  const practiceAddress = ["Provider Secondary Practice Location Address- Address Line 1", "Provider Secondary Practice Location Address-  Address Line 2", "Provider Secondary Practice Location Address - City Name", "Provider Secondary Practice Location Address - State Name", "Provider Secondary Practice Location Address - Postal Code", "Provider Secondary Practice Location Address - Country Code (If outside U.S.)"].map(k => practice[k]);
  need(sameAddress(originalAddress, targetAddress) && sameAddress(originalAddress, endpointAddress) && sameAddress(originalAddress, practiceAddress), "complete literal registry address roles differ");
  const phone = main["Provider Business Practice Location Address Telephone Number"];
  need(/^[2-9]\d{9}$/.test(phone) && practice["Provider Secondary Practice Location Address - Telephone Number"] === phone
    && /^\+?1?[ ()\d.-]+$/.test(site.phoneAsDisplayed) && site.phoneAsDisplayed.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") === phone, "registry and own-site phone differ");
  const ownUrl = (value: string, final = false) => { try { const u = new URL(value); return (final ? u.protocol === "https:" : ["https:","http:"].includes(u.protocol)) && u.hostname.toLowerCase().replace(/^www\./, "") === entry.canonicalDomain && !u.username && !u.password && !u.port && !u.hash; } catch { return false; } };
  need(site.status === 200 && site.contentType.toLowerCase().startsWith("text/html") && iso(site.observedAt)
    && ownUrl(site.requestedUrl) && ownUrl(site.finalUrl, true) && site.hops.length > 0 && site.hops.length <= 6
    && site.hops[0].url === site.requestedUrl && site.hops.at(-1)?.url === site.finalUrl && site.hops.at(-1)?.status === 200
    && site.hops.every((h,i) => ownUrl(h.url, i === site.hops.length-1) && (i === site.hops.length-1 ? h.status === 200 : [301,302,303,307,308].includes(h.status)))
    && [site.htmlSha256,site.textSha256,site.receiptSha256].every(hash) && site.text.length > 0 && site.text.length <= 150000 && sha(site.text) === site.textSha256
    && site.quote.length > 0 && site.quote.length <= 3000 && site.text.includes(site.quote) && sameRegistryLegalName(site.subject, legal)
    && site.quote.toLowerCase().includes(site.subject.toLowerCase()) && site.quote.includes(site.phoneAsDisplayed), "complete own-site subject/contact source invalid");
  sourcePair(entry.sourceReader, entry.sourceReviewer, Math.max(Date.parse(s.extractedAt), Date.parse(site.observedAt)));
  sourcePair(entry.originalReviews.primary, entry.originalReviews.independent, Date.parse(p.observedAt));
  need(hash(entry.originalReviews.packetSha256), "original packet pin invalid");
  const earliest = Math.max(...[entry.sourceReader,entry.sourceReviewer,entry.originalReviews.primary,entry.originalReviews.independent].map(r => Date.parse(r.reviewedAt)), ...context.addresses.map(a => Date.parse(a.capturedAt)));
  for (const w of [raw.reader,raw.reviewer]) need(w && Object.keys(w).length === 3 && task(w.taskId) && iso(w.reviewedAt)
    && w.evidenceSha256 === bindings.evidenceSha256 && Date.parse(w.reviewedAt) >= earliest && Date.parse(w.reviewedAt) <= now.getTime()+60000
    && now.getTime()-Date.parse(w.reviewedAt) <= 7*86400000, "final review does not bind exact content");
  need(raw.reader.taskId !== raw.reviewer.taskId && Date.parse(raw.reviewer.reviewedAt) >= Date.parse(raw.reader.reviewedAt), "distinct ordered final review required");
  return { method: "reviewed_official_registration_history", verifiedAt: now.toISOString(),
    sourceIds: [`cms_nppes:${p.recordId}:${bindings.entrySha256}`, `nppes_endpoint:${p.recordId}:${s.endpoint.rawRowSha256}`],
    officialHistory: { ...raw, evidenceSha256: bindings.evidenceSha256, entry,
      targetAddress: { role: "provider_practice", ...p.identity },
      nppesOrganizationEndpoint: { npi:p.recordId,organizationType:main["Entity Type Code"],legalName:legal,organizationSubpart:subpart,parentLegalName:parent,
        endpointType:endpoint["Endpoint Type"],endpoint:endpoint.Endpoint,affiliation:endpoint.Affiliation,affiliationLegalName:endpoint["Affiliation Legal Business Name"],
        endpointAddressRole:"endpoint_affiliation",endpointAddress,additionalPracticeAddress:practiceAddress,phone },
      scope: "Retained Type 2 NPI, same-NPI DIRECT endpoint, compatible organization/parent names, full registry address and own-site telephone association. Canonical/website and provider/endpoint addresses remain separate. No current activity, relocation, license, financial scale, deliverability, mailbox ownership or outreach permission is inferred." } };
}

// Shared, unchanged strict primitives for separately dispatched NPPES modes.
export { csv as nppesCsv, organizationAddress as nppesOrganizationAddress, sourcePair as nppesSourcePair };
export type { CsvRow as NppesCsvRow };
