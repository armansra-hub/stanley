import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { STATE_NAMES } from "@/lib/publicGrowth/identity";
import { sameRegistryStreet, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import type { RegistryOfficialApiCorroboration } from "./registryOfficialApi";
import { nppesCsv, nppesOrganizationAddress, nppesSourcePair, type NppesCsvRow, type RegistryNppesEndpointEntry } from "./registryNppesEndpoint";

type Address = { addressLine1: string; addressLine2?: string; city: string; state: string; postalCode: string; countryCode: "US" };
type OtherNameRow = NppesCsvRow & { headerRawCsv: string; headerRawCsvSha256: string };
export type RegistryNppesOtherNameEntry = Omit<RegistryNppesEndpointEntry, "sourceKind" | "source" | "anchor" | "website"> & {
  sourceKind: "nppes_organization_dba";
  source: Omit<RegistryNppesEndpointEntry["source"], "endpoint" | "practice"> & {
    otherNames: OtherNameRow[];
    codebook: { pdfSha256: string; documentDate: "2025-02-01"; page: 7; section: "1.6";
      typeCode: "3"; meaning: "Doing Business As"; entityType: "Organization"; pageText: string;
      pageTextSha256: string; receiptSha256: string };
  };
  anchor: { mode: "dba_own_site_address_phone"; originalAddressRole: "provider_practice" }
    | { mode: "dba_canonical_address"; originalAddressRole: "provider_practice"; sourceId: string };
  website?: Omit<RegistryNppesEndpointEntry["website"], "quote"> & {
    subjectQuote: string; contactQuote: string; address: Address;
  };
};
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const iso = (s: unknown): s is string => typeof s === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
const task = (s: unknown): s is string => typeof s === "string" && s.length <= 160 && /^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(s);
// Formatting only: every name word, including legal suffixes, remains significant.
const whole = (s: string) => s.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const literal = (s: string) => s.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
const states = new Map(STATE_NAMES.split("|").map(x => { const [name, code] = x.split(":"); return [whole(name), code]; }));
const state = (s: string) => states.get(whole(s)) ?? (/^[A-Z]{2}$/.test(literal(s)) ? literal(s) : null);
const headers = ["NPI", "Provider Other Organization Name", "Provider Other Organization Name Type Code", "Created Date"];
function need(v: unknown, why: string): asserts v { if (!v) throw Error(`official NPPES DBA ${why}`); }
function otherName(part: OtherNameRow, snapshot: string) {
  need(part.member === `othername_pfile_20050523-${snapshot.replaceAll("-", "")}.csv`
    && stableRegistryJson(part.headers) === stableRegistryJson(headers) && sha(stableRegistryJson(part.headers)) === part.headersSha256
    && hash(part.headerRawCsvSha256) && sha(part.headerRawCsv) === part.headerRawCsvSha256
    && stableRegistryJson(parseCsv(part.headerRawCsv)) === stableRegistryJson([headers])
    && hash(part.rawRowSha256) && part.rawRow.length > 0 && part.rawRow.length <= 32000 && sha(part.rawRow) === part.rawRowSha256
    && [part.memberSha256, part.headerReceiptSha256].every(hash) && /^[a-f0-9]{8}$/.test(part.memberCrc32)
    && Number.isInteger(part.dataRecordNumber) && part.dataRecordNumber! > 0, "other-name CSV provenance invalid");
  const rows = parseCsv(part.rawRow);
  need(rows.length === 1 && rows[0].length === headers.length, "complete single other-name row required");
  const [npi, name, typeCode, createdDate] = rows[0];
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(createdDate);
  const date = m ? `${m[3]}-${m[1]}-${m[2]}` : "";
  need(m && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date && date <= snapshot,
    "reported Created Date invalid; it is not a rename or formation date");
  return { npi, name, typeCode, createdDate };
}
function addressMatches(original: string[], a: Address) {
  const [line1,line2,city,region,zip,country] = original;
  const compactZip = (v: string) => v.replace("-", "");
  return [line1,city,region,zip,country,a.addressLine1,a.city,a.state,a.postalCode,a.countryCode].every(v => typeof v === "string" && v.length > 0)
    && country === "US" && a.countryCode === "US" && whole(city) === whole(a.city) && state(region) !== null && state(region) === state(a.state)
    && /^\d{5}(?:-?\d{4})?$/.test(zip) && /^\d{5}(?:-?\d{4})?$/.test(a.postalCode)
    && compactZip(zip).slice(0,5) === compactZip(a.postalCode).slice(0,5)
    && (compactZip(zip).length === 5 || compactZip(a.postalCode).length === 5 || compactZip(zip) === compactZip(a.postalCode))
    && sameRegistryStreet({addressLine1:line1,addressLine2:line2}, a);
}

// Deployment-reviewed catalog evidence only. Callers still send the existing pinned
// entry ID and distinct final witnesses, never self-authored alias/source evidence.
export function verifyRegistryNppesOtherName(row: RegistryFinding, raw: RegistryOfficialApiCorroboration,
  entry: RegistryNppesOtherNameEntry, company: Company, context: CompanyIdentityContext, now: Date,
  bindings: { entrySha256: string; canonicalIdentitySha256: string; evidenceSha256: string; canonicalDomain: string | null }): NonNullable<RegistryProfile["verification"]> {
  const s = entry.source, p = row.profile, t = entry.target;
  need(raw.entrySha256 === bindings.entrySha256 && entry.sourceKind === "nppes_organization_dba"
    && !Object.hasOwn(entry,"nameBridge") && !Object.hasOwn(entry,"siteOperatorBridge")
    && entry.anchor.originalAddressRole === "provider_practice"
    && ["dba_own_site_address_phone","dba_canonical_address"].includes(entry.anchor.mode), "entry or role differs");
  need(company.id === entry.companyId && row.companyId === entry.companyId && company.netsuite_internal_id === entry.internalId && row.internalId === entry.internalId
    && bindings.canonicalDomain !== null && bindings.canonicalDomain === entry.canonicalDomain && hash(entry.canonicalIdentitySha256)
    && raw.canonicalIdentitySha256 === entry.canonicalIdentitySha256 && raw.canonicalIdentitySha256 === bindings.canonicalIdentitySha256, "canonical fence differs");
  need(/^https:\/\/download\.cms\.gov\/nppes\/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip$/.test(s.requestedUrl)
    && s.requestedUrl === s.finalUrl && s.requestedUrl === row.sourceUrl && s.status === "downloaded" && s.contentType === "application/zip"
    && iso(s.observedAt) && iso(s.extractedAt) && Date.parse(s.extractedAt) >= Date.parse(s.observedAt)
    && /^\d{4}-\d{2}-\d{2}$/.test(s.sourceAsOf) && s.completeMemberStreamsAndCrcVerified === true
    && [s.archiveSha256,s.downloadReceiptSha256,s.extractionReceiptSha256].every(hash), "archive provenance invalid");
  need(p.dataset === "cms_nppes" && t.dataset === p.dataset && /^[12]\d{9}$/.test(p.recordId) && p.recordId === t.recordId
    && row.sourceUrl === t.sourceUrl && p.sourceAsOf === t.sourceAsOf && p.sourceAsOf === s.sourceAsOf && p.observedAt === t.observedAt && p.observedAt === s.observedAt
    && p.provenance.rowSha256 === t.rowSha256 && row.evidence === p.provenance.quote && row.evidence === s.main.rawRow
    && sha(row.evidence) === t.evidenceSha256 && sha(row.evidence) === p.provenance.rowSha256
    && sha(stableRegistryJson(p.identity)) === t.identitySha256 && sha(stableRegistryJson(p.provenance.sourceRow)) === t.sourceRowSha256
    && sha(stableRegistryJson(p.facts.map(({field,value}) => ({field,value})))) === t.factsSha256, "original target changed");
  const cb = s.codebook;
  need(cb.pdfSha256 === "8510d05f062befe7eed8afa5e5b165ee83e7ebe507c4ce605db189252861e119"
    && cb.documentDate === "2025-02-01" && cb.page === 7 && cb.section === "1.6" && cb.typeCode === "3"
    && cb.meaning === "Doing Business As" && cb.entityType === "Organization"
    && cb.pageText.length > 0 && cb.pageText.length <= 20000 && sha(cb.pageText) === cb.pageTextSha256 && hash(cb.receiptSha256)
    && /3\s+Doing Business As\s+O/.test(cb.pageText), "organization DBA codebook meaning unbound");
  const main = nppesCsv(s.main,"npidata",s.sourceAsOf,false);
  need(Array.isArray(s.otherNames) && s.otherNames.length > 0 && s.otherNames.length <= 32
    && new Set(s.otherNames.map(r => r.rawRowSha256)).size === s.otherNames.length
    && s.otherNames.every(r => r.memberSha256 === s.otherNames[0].memberSha256 && r.memberCrc32 === s.otherNames[0].memberCrc32
      && r.headerReceiptSha256 === s.extractionReceiptSha256), "other-name member lineage differs");
  const names = s.otherNames.map(r => otherName(r,s.sourceAsOf)), dba = names[0].name;
  const legal = main["Provider Organization Name (Legal Business Name)"], parent = main["Parent Organization LBN"], subpart = main["Is Organization Subpart"];
  const mainOther = main["Provider Other Organization Name"], mainOtherType = main["Provider Other Organization Name Type Code"];
  need(main.NPI === p.recordId && main["Entity Type Code"] === "2" && main["Replacement NPI"] === ""
    && main["Provider Last Name (Legal Name)"] === "" && main["Provider First Name"] === ""
    && !!legal && legal === p.identity.legalName && !!whole(dba) && whole(dba) === whole(company.name)
    && names.every(n => n.npi === p.recordId && n.typeCode === "3" && whole(n.name) === whole(dba))
    && context.aliases.every(n => whole(n) === whole(dba) || whole(n) === whole(legal))
    && (subpart === "Y" && !!parent && whole(parent) === whole(legal) || subpart === "N" && (!parent || whole(parent) === whole(legal)))
    && ((!mainOther || mainOther === "<UNAVAIL>") && ["","6"].includes(mainOtherType)
      || mainOtherType === "3" && whole(mainOther) === whole(dba)), "NPI/legal/DBA/subpart conflict");
  const originalAddress = nppesOrganizationAddress(main);
  const targetAddress = [p.identity.addressLine1,p.identity.addressLine2 ?? "",p.identity.city!,p.identity.state!,p.identity.postalCode!,p.identity.countryCode!];
  need(originalAddress.every((v,i) => typeof v === "string" && v === targetAddress[i]), "original practice address changed");
  let anchorObservedAt = 0;
  if (entry.anchor.mode === "dba_canonical_address") {
    need(!entry.website && typeof entry.anchor.sourceId === "string" && entry.anchor.sourceId.length > 0, "canonical role differs");
    const matches = context.addresses.filter(a => a.sourceId === (entry.anchor as {sourceId:string}).sourceId);
    need(matches.length === 1 && ["netsuite_record","company_website"].includes(matches[0].sourceKind)
      && iso(matches[0].capturedAt) && addressMatches(originalAddress,matches[0] as Address), "exact canonical address/sourceId differs");
    anchorObservedAt = Date.parse(matches[0].capturedAt);
  } else {
    const site = entry.website;
    need(site, "own-site source missing");
    const ownUrl = (value: string, final = false) => { try { const u = new URL(value); return (final ? u.protocol === "https:" : ["https:","http:"].includes(u.protocol))
      && u.hostname.toLowerCase().replace(/^www\./,"") === entry.canonicalDomain && !u.username && !u.password && !u.port && !u.hash; } catch { return false; } };
    const phone = main["Provider Business Practice Location Address Telephone Number"];
    need(/^[2-9]\d{9}$/.test(phone) && /^\+?1?[ ()\d.-]+$/.test(site.phoneAsDisplayed)
      && site.phoneAsDisplayed.replace(/\D/g,"").replace(/^1(?=\d{10}$)/,"") === phone, "practice/own-site phone differs");
    need(site.status === 200 && site.contentType.toLowerCase().startsWith("text/html") && iso(site.observedAt)
      && ownUrl(site.requestedUrl) && ownUrl(site.finalUrl,true) && site.hops.length > 0 && site.hops.length <= 6
      && site.hops[0].url === site.requestedUrl && site.hops.at(-1)?.url === site.finalUrl && site.hops.at(-1)?.status === 200
      && site.hops.every((h,i) => ownUrl(h.url,i === site.hops.length-1) && (i === site.hops.length-1 ? h.status === 200 : [301,302,303,307,308].includes(h.status)))
      && [site.htmlSha256,site.textSha256,site.receiptSha256].every(hash) && site.text.length > 0 && site.text.length <= 150000 && sha(site.text) === site.textSha256
      && [site.subjectQuote,site.contactQuote].every(q => q.length > 0 && q.length <= 3000 && site.text.includes(q))
      && whole(site.subject) === whole(dba) && (` ${whole(site.subjectQuote)} `).includes(` ${whole(site.subject)} `)
      && site.contactQuote.includes(site.phoneAsDisplayed) && addressMatches(originalAddress,site.address)
      && [site.address.addressLine1,site.address.addressLine2 ?? "",site.address.city,site.address.state,site.address.postalCode].every(v => !v || whole(site.contactQuote).includes(whole(v))),
      "complete own-site DBA/address/contact source differs");
    anchorObservedAt = Date.parse(site.observedAt);
  }
  nppesSourcePair(entry.sourceReader,entry.sourceReviewer,Math.max(Date.parse(s.extractedAt),anchorObservedAt));
  nppesSourcePair(entry.originalReviews.primary,entry.originalReviews.independent,Date.parse(p.observedAt));
  need(hash(entry.originalReviews.packetSha256), "original packet pin invalid");
  const earliest = Math.max(...[entry.sourceReader,entry.sourceReviewer,entry.originalReviews.primary,entry.originalReviews.independent].map(r => Date.parse(r.reviewedAt)),
    ...context.addresses.map(a => Date.parse(a.capturedAt)));
  for (const w of [raw.reader,raw.reviewer]) need(w && Object.keys(w).length === 3 && task(w.taskId) && iso(w.reviewedAt)
    && w.evidenceSha256 === bindings.evidenceSha256 && Date.parse(w.reviewedAt) >= earliest && Date.parse(w.reviewedAt) <= now.getTime()+60000
    && now.getTime()-Date.parse(w.reviewedAt) <= 7*86400000, "final review does not bind exact content");
  need(raw.reader.taskId !== raw.reviewer.taskId && Date.parse(raw.reviewer.reviewedAt) >= Date.parse(raw.reader.reviewedAt), "distinct ordered final review required");
  return { method:"reviewed_official_registration_history",verifiedAt:now.toISOString(),
    sourceIds:[`cms_nppes:${p.recordId}:${bindings.entrySha256}`,...s.otherNames.map(r => `nppes_othername:${p.recordId}:${r.rawRowSha256}`)],
    officialHistory:{...raw,evidenceSha256:bindings.evidenceSha256,entry,targetAddress:{role:"provider_practice",...p.identity},
      nppesOrganizationDba:{npi:p.recordId,organizationType:"2",legalName:legal,reportedDba:dba,organizationSubpart:subpart,parentLegalName:parent,
        mainOtherName:mainOther,mainOtherNameType:mainOtherType,otherNameRows:names,addressRole:"provider_practice",anchorMode:entry.anchor.mode},
      scope:"Retained Type 2 NPI and same-NPI type 3 organization DBA, joined by whole DBA and full practice address with a pinned canonical address or own-domain address and practice phone. Raw legal name, aliases, main-row placeholders and separate address roles are unchanged. Created Dates are reported source fields, not formation or rename dates. No current activity, licensure, registration, revenue, headcount, budget or outreach permission is inferred."}};
}
