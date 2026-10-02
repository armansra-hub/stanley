import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { registryContentHash, sameRegistryLegalName, sameRegistryStreet, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import { registryOfficialApiCanonicalHash } from "./registryOfficialApi";
import catalog from "./registryOfficialDocumentEntries.json";

type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
type Witness = { taskId: string; reviewedAt: string; evidenceSha256: string };
type Read = { taskId: string; reviewedAt: string; receiptSha256: string; receiptActorField: string };
type Address = { addressLine1: string; addressLine2?: string; city: string; state: string; postalCode: string; countryCode: "US" };
type Source = { kind: "municipal_pdf" | "official_rendered_record" | "own_website"; url: string; requestedUrl: string | null; hops: {url:string;status:number}[] | null; observedAt: string;
  receiptSha256: string; bodySha256: string | null; text: string; textSha256: string; completeRead: true;
  status: 200 | null; contentType: string | null; originalSourcePin: string; sourceDate: string | null; sourceDateText: string | null };
type Target = { dataset: "co_ucc" | "sba_7a"; recordId: string; sourceUrl: string; rowSha256: string; evidenceSha256: string;
  profileSha256: string; sourceAsOf: string | null; observedAt: string; role: "debtor_business" | "borrower_business" };
type BaseEntry = { id: string; companyId: string; internalId: string; canonicalDomain: string; canonicalIdentitySha256: string;
  target: Target; sources: [Source, Source]; originalReviews: { primary: Read; independent: Read; packetSha256: string };
  sourceReader: Read; sourceReviewer: Read; legalName: string; phone: string; targetAddress: Address; limitations: string[] };
type AuthorEntry = BaseEntry & { chain: "dated_author_address"; authorRole: "report_author_letterhead";
  identityPage: { text: string; sha256: string; page: number; visualSha256: string }; authorHeader: string; signature: string;
  documentDate: string; domainLiteral: string };
type DbaEntry = BaseEntry & { chain: "official_dba_own_site_address"; officialRole: "licensed_legal_entity_and_dba";
  ownSiteRole: "company_contact_address"; dba: string; identifier: { kind: "arizona_roc"; value: string };
  officialIdentityQuote: string; ownSiteContactQuote: string; locality: { city: string; state: string; postalCode: string };
  sourceStatus: string; sourceSubStatus: string };
type IrsSource = Omit<Source, "kind" | "status"> & { kind: "official_irs_xml_archive_member"; status: 200 | 206;
  archive: { member: string; memberBytes: number; xmlSha256: string; extractionReceiptSha256: string;
    archiveSha256: string | null; range: { start: number; end: number; total: number; sha256: string; etag: string; crc32: number } | null } };
type IrsEntry = Omit<BaseEntry, "sources" | "target"> & { chain: "official_irs_ein_historical_books_address";
  sources: [IrsSource, IrsSource]; target: Omit<Target, "dataset" | "role"> & { dataset: "irs_exempt"; role: "exempt_organization" };
  ein: string; declaredDomain: string; historicalAddress: Address; historicalRole: "books_in_care_of_address";
  historicalLocator: "Return/ReturnData/IRS990/BooksInCareOfDetail/USAddress"; targetContinuityRole: "books_in_care_of_address";
  historicalDate: string; laterDate: string; currentPhysicalAddressClaim: false;
  assignedDomainConflict: { disposition: "retain_assigned_domain_as_distinct_entity"; domain: string; legalName: string; ein: string;
    url: string; observedAt: string; text: string; textSha256: string; htmlSha256: string; packetSha256: string; identityQuote: string } };
export type RegistryOfficialDocumentEntry = AuthorEntry | DbaEntry | IrsEntry;
export type RegistryOfficialDocumentCorroboration = { schema: "official_document_roles_v1"; entryId: string; entrySha256: string;
  canonicalIdentitySha256: string; reader: Witness; reviewer: Witness };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (x: unknown): x is Record<string, unknown> => Boolean(x && typeof x === "object" && !Array.isArray(x));
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const iso = (x: unknown): x is string => typeof x === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
const task = (x: unknown): x is string => typeof x === "string" && x.length <= 160 && /^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(x);
const words = (x: string) => x.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const compact = (x: string) => x.replace(/\s+/g, " ").trim();
function need(x: unknown, message: string): asserts x { if (!x) throw new Error(`official document ${message}`); }
function publicUrl(value: string) { const u = new URL(value); need(u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash, "source URL invalid"); return u; }
function host(value: string) { const u = new URL(value.includes("://") ? value : `https://${value}`); need(/^https?:$/.test(u.protocol) && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname === "/", "canonical domain invalid"); return u.hostname.toLowerCase().replace(/^www\./, ""); }
function fullAddress(a: Address, b: Address) {
  return a.countryCode === "US" && b.countryCode === "US" && words(a.city) === words(b.city) && a.state.toUpperCase() === b.state.toUpperCase()
    && /^\d{5}(?:-?\d{4})?$/.test(a.postalCode) && /^\d{5}(?:-?\d{4})?$/.test(b.postalCode)
    && a.postalCode.replace(/-/g, "") === b.postalCode.replace(/-/g, "") && sameRegistryStreet(a, b);
}
// Versioned, build-reviewed data is the trust boundary. No caller can supply a
// document, address-role claim, alias, or source-review attestation in its proof.
export function registryOfficialDocumentEntry(id: string) {
  const entries = catalog.entries as unknown as RegistryOfficialDocumentEntry[], matches = entries.filter(e => e.id === id);
  need(catalog.schema === "reviewed_official_document_entries_v1" && [2,3].includes(entries.length) && matches.length === 1, "entry missing or ambiguous");
  return { entry: structuredClone(matches[0]), sha256: sha(stableRegistryJson(matches[0])) };
}
export const registryOfficialDocumentCanonicalHash = registryOfficialApiCanonicalHash;
export function registryOfficialDocumentEvidenceHash(row: RegistryFinding, proof: Omit<RegistryOfficialDocumentCorroboration, "reader" | "reviewer">) {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId, contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
function sourceChecks(e: RegistryOfficialDocumentEntry) {
  if (e.chain === "official_irs_ein_historical_books_address") irsSourceChecks(e);
  else {
  need(e.sources.length === 2 && e.sources[1].kind === "own_website", "source classes differ");
  for (const s of e.sources) {
    need(iso(s.observedAt) && hash(s.receiptSha256) && hash(s.originalSourcePin) && s.completeRead === true
      && s.text.length > 20 && s.text.length <= 150000 && sha(s.text) === s.textSha256, "complete source or text pin invalid");
    const u = publicUrl(s.url);
    if (s.kind === "official_rendered_record") need(s.status === null && s.bodySha256 === null && s.contentType === null && s.requestedUrl === null && s.hops === null
      && u.hostname === "azroc.my.site.com" && u.pathname === "/AZRoc/s/contractor-search" && [...u.searchParams.keys()].join() === "licenseId"
      && /^[a-zA-Z0-9]{18}$/.test(u.searchParams.get("licenseId") ?? ""), "rendered ROC capture provenance invalid");
    else need(s.status === 200 && hash(s.bodySha256) && (s.kind === "municipal_pdf"
      ? s.contentType === "application/pdf" && s.requestedUrl === s.url && s.hops === null && u.hostname === "waterinfo.murphytx.org" && u.pathname.endsWith(".pdf") && !u.search
      : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/.test(s.contentType ?? "") && u.hostname.replace(/^www\./, "") === e.canonicalDomain), "source authority or capture class differs");
    if (s.kind === "own_website") need(s.hops && s.hops.length > 0 && s.hops.length <= 5 && s.hops[0].url === s.requestedUrl
      && s.hops.at(-1)?.url === s.url && s.hops.at(-1)?.status === 200 && s.hops.every((h,i)=>host(h.url) === e.canonicalDomain
        && (i === s.hops!.length-1 ? h.status === 200 : [301,302,303,307,308].includes(h.status))), "own-site captured redirect provenance differs");
    if (s.sourceDate !== null) need(/^\d{4}-\d{2}-\d{2}$/.test(s.sourceDate) && Number.isFinite(Date.parse(s.sourceDate))
      && Date.parse(s.sourceDate) <= Date.parse(s.observedAt) && s.sourceDateText && s.text.includes(s.sourceDateText), "document date invalid");
    else need(s.sourceDateText === null, "undated source has asserted date");
  }
  }
  const reviews = [e.sourceReader, e.sourceReviewer], originals = [e.originalReviews.primary, e.originalReviews.independent];
  need(hash(e.originalReviews.packetSha256) && reviews[0].taskId !== reviews[1].taskId && originals[0].taskId !== originals[1].taskId
    && [...reviews,...originals].every(r => task(r.taskId) && iso(r.reviewedAt) && hash(r.receiptSha256) && ["readerTaskId","reviewerTaskId","readBy"].includes(r.receiptActorField))
    && reviews.every(r => Date.parse(r.reviewedAt) >= Math.max(...e.sources.map(s => Date.parse(s.observedAt))))
    && originals.every(r => Date.parse(r.reviewedAt) >= Date.parse(e.target.observedAt))
    && Date.parse(reviews[1].reviewedAt) >= Date.parse(reviews[0].reviewedAt)
    && Date.parse(originals[1].reviewedAt) >= Date.parse(originals[0].reviewedAt), "actual full-source lineage invalid");
}
function originalTarget(row: RegistryFinding, e: RegistryOfficialDocumentEntry) {
  const p = row.profile, t = e.target, u = publicUrl(row.sourceUrl);
  need(p.dataset === t.dataset && p.recordId === t.recordId && row.sourceUrl === t.sourceUrl && sha(row.evidence) === t.evidenceSha256
    && p.provenance.rowSha256 === t.rowSha256 && sha(stableRegistryJson(p)) === t.profileSha256 && p.sourceAsOf === t.sourceAsOf
    && p.observedAt === t.observedAt && row.evidence === p.provenance.quote, "original target pin changed");
  let raw: Record<string, unknown>;
  if (e.chain === "dated_author_address") {
    const lines = row.evidence.split("\n"); need(p.dataset === "co_ucc" && t.role === "debtor_business" && lines.length === 2, "target debtor role invalid");
    raw = JSON.parse(lines[0]); const filing = JSON.parse(lines[1]);
    need(sha(lines[0]) === t.rowSha256 && raw.country === "United States" && p.recordId === `${raw.fileid}:${raw.debtorid}` && filing.fileid === raw.fileid
      && raw.organizationname === p.identity.legalName && raw.address1 === p.identity.addressLine1 && (raw.address2 || "") === (p.identity.addressLine2 || "")
      && raw.city === p.identity.city && raw.state === p.identity.state && raw.zipcode === p.identity.postalCode
      && u.hostname === "data.colorado.gov" && u.pathname === "/resource/8upq-58vz.json" && [...u.searchParams.keys()].join() === "debtorid"
      && u.searchParams.get("debtorid") === raw.debtorid, "original UCC record differs");
  } else if (e.chain === "official_irs_ein_historical_books_address") {
    const parts=row.evidence.split("\nOriginal public source row: ");
    need(p.dataset==="irs_exempt" && t.role==="exempt_organization" && /^\d{9}$/.test(p.recordId) && parts.length===2,"target IRS role invalid");
    raw=JSON.parse(parts[1]); const normalized=JSON.parse(parts[0]);
    need(sha(parts[1])===t.rowSha256 && stableRegistryJson(normalized)===stableRegistryJson(p.provenance.sourceRow)
      && raw.EIN===p.recordId && p.recordId===e.ein && p.provenance.sourceRow.ein===e.ein
      && p.facts.filter(f=>f.field==="ein" && f.value===e.ein).length===1
      && raw.NAME===p.identity.legalName && raw.STREET===p.identity.addressLine1 && raw.CITY===p.identity.city
      && raw.STATE===p.identity.state && raw.ZIP===p.identity.postalCode && raw.TAX_PERIOD===p.provenance.sourceRow.tax_period
      && u.hostname==="www.irs.gov" && /^\/pub\/irs-soi\/eo[1-4]\.csv$/.test(u.pathname) && !u.search,"original IRS BMF identity differs");
  } else {
    const parts = row.evidence.split("\nOriginal public source row: ");
    need(p.dataset === "sba_7a" && t.role === "borrower_business" && parts.length === 2, "target borrower role invalid");
    raw = JSON.parse(parts[1]); const normalized = JSON.parse(parts[0]);
    need(sha(parts[1]) === t.rowSha256 && stableRegistryJson(normalized) === stableRegistryJson(p.provenance.sourceRow)
      && raw.BorrName === p.identity.legalName && raw.BorrStreet === p.identity.addressLine1 && raw.BorrCity === p.identity.city
      && raw.BorrState === p.identity.state && raw.BorrZip === p.identity.postalCode && raw.AsOfDate === p.sourceAsOf
      && raw.BusinessType === p.provenance.sourceRow.legal_structure && u.hostname === "data.sba.gov"
      && u.pathname.startsWith("/sites/default/files/uploaded_resources/FOIA_7a_") && u.pathname.endsWith(".csv") && !u.search, "original SBA borrower differs");
  }
  need(!p.identity.countryCode || p.identity.countryCode === "US", "target country differs");
  need(sameRegistryLegalName(p.identity.legalName,e.legalName) && fullAddress({ ...p.identity, countryCode:"US" } as Address,e.targetAddress), "target full legal address differs");
}
// These locators inspect immutable, fully read catalog XML, never caller XML.
// Reject declarations/comments/CDATA that could spoof the closed element paths.
function xmlPart(text: string, tag: string) {
  const matches=[...text.matchAll(new RegExp(`<${tag}(?:\\s[^<>]*?)?>([\\s\\S]*?)<\\/${tag}>`,"g"))];
  need(matches.length===1,`IRS XML ${tag} missing or ambiguous`); return matches[0][1];
}
function xmlValue(text: string, tag: string) {
  const value=xmlPart(text,tag); need(!/[<>]|&(?!(?:amp|lt|gt|quot|apos);)/.test(value),"IRS scalar differs");
  return value.replace(/&(amp|lt|gt|quot|apos);/g,(_,x:string)=>({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}[x]!)).trim();
}
function xmlAddress(parent: string): Address {
  const a=xmlPart(parent,"USAddress");
  need(!/<AddressLine2Txt(?:\s|>)/.test(a),"IRS additional address line is not represented");
  return {addressLine1:xmlValue(a,"AddressLine1Txt"),city:xmlValue(a,"CityNm"),state:xmlValue(a,"StateAbbreviationCd"),postalCode:xmlValue(a,"ZIPCd"),countryCode:"US"};
}
function datedUsAddress(a: Address,b: Address) {
  // A five-digit ZIP may be compared to its stated ZIP+4; two supplied ZIP+4s
  // must agree. Street, unit, city, state and country remain required.
  const az=a.postalCode.replace(/-/g,""),bz=b.postalCode.replace(/-/g,"");
  return /^\d{5}(?:-?\d{4})?$/.test(a.postalCode) && /^\d{5}(?:-?\d{4})?$/.test(b.postalCode)
    && (az.length===5 || bz.length===5 || az===bz) && fullAddress({...a,postalCode:az.slice(0,5)},{...b,postalCode:bz.slice(0,5)});
}
function irsSourceChecks(e: IrsEntry) {
  need(e.sources.length===2,"IRS source count differs");
  for (const s of e.sources) {
    const u=publicUrl(s.url),a=s.archive;
    need(s.kind==="official_irs_xml_archive_member" && u.hostname==="apps.irs.gov" && /^\/pub\/epostcard\/990\/xml\/\d{4}\/[A-Za-z0-9_]+\.zip$/.test(u.pathname)
      && !u.search && s.requestedUrl===s.url && s.hops===null && s.contentType==="application/zip"
      && hash(s.receiptSha256) && hash(s.originalSourcePin) && hash(s.bodySha256) && iso(s.observedAt)
      && s.completeRead===true && s.text.length>100 && s.text.length<=150000 && sha(s.text)===s.textSha256
      && a && /^\d{18}_public\.xml$/.test(a.member) && Buffer.byteLength(s.text,"utf8")===a.memberBytes
      && a.xmlSha256===s.textSha256 && hash(a.extractionReceiptSha256) && a.extractionReceiptSha256===s.originalSourcePin,"original IRS archive source differs");
    need(s.text.replace(/^\uFEFF/,"").startsWith('<?xml version="1.0" encoding="utf-8"?>') && !/<!|<\?(?!xml )/.test(s.text)
      && /<Return\s[^>]*xmlns="http:\/\/www.irs.gov\/efile"/.test(s.text) && s.text.trimEnd().endsWith("</Return>"),"IRS XML envelope differs");
    if(s.status===206) {
      const r=a.range;
      need(a.archiveSha256===null && r && [r.start,r.end,r.total,r.crc32].every(Number.isSafeInteger)
        && r.start>=0 && r.end>r.start && r.end<r.total && r.crc32>=0 && r.crc32<=0xffffffff
        && /^"[^"\r\n]+"$/.test(r.etag) && r.sha256===s.bodySha256,"IRS range provenance differs");
    } else need(s.status===200 && a.range===null && a.archiveSha256===s.bodySha256,"IRS whole archive provenance differs");
    need(s.sourceDate && /^\d{4}-\d{2}-\d{2}$/.test(s.sourceDate) && Number.isFinite(Date.parse(s.sourceDate))
      && Date.parse(s.sourceDate)<=Date.parse(s.observedAt) && s.sourceDateText===`<TaxPeriodEndDt>${s.sourceDate}</TaxPeriodEndDt>`
      && s.text.includes(s.sourceDateText),"IRS filing date differs");
  }
  const c=e.assignedDomainConflict;
  need(c && c.disposition==="retain_assigned_domain_as_distinct_entity" && c.domain===e.canonicalDomain
    && host(c.url)===e.canonicalDomain && iso(c.observedAt) && hash(c.packetSha256) && c.packetSha256===e.originalReviews.packetSha256
    && hash(c.htmlSha256) && sha(c.text)===c.textSha256 && c.text.length>20 && c.text.length<=150000
    && /^\d{9}$/.test(c.ein) && c.ein!==e.ein && !sameRegistryLegalName(c.legalName,e.legalName)
    && c.text.includes(c.identityQuote) && c.identityQuote.includes(c.legalName)
    && c.identityQuote.includes(c.ein.slice(0,2)+"-"+c.ein.slice(2)),"assigned-domain conflict missing or changed");
  need([e.sourceReader,e.sourceReviewer].every(r=>Date.parse(r.reviewedAt)>=Date.parse(c.observedAt)),"domain conflict source chronology differs");
}
function irsIdentityChain(e: IrsEntry,context: CompanyIdentityContext) {
  need(/^\d{9}$/.test(e.ein) && e.ein===e.target.recordId && e.historicalRole==="books_in_care_of_address"
    && e.historicalLocator==="Return/ReturnData/IRS990/BooksInCareOfDetail/USAddress" && e.targetContinuityRole==="books_in_care_of_address"
    && e.currentPhysicalAddressClaim===false && e.historicalDate===e.sources[0].sourceDate && e.laterDate===e.sources[1].sourceDate
    && Date.parse(e.historicalDate)<Date.parse(e.laterDate) && host(e.declaredDomain)!==e.canonicalDomain,"IRS identity roles or dated sequence differ");
  for (const [index,s] of e.sources.entries()) {
    const header=xmlPart(s.text,"ReturnHeader"),filer=xmlPart(header,"Filer"),data=xmlPart(s.text,"ReturnData"),form=xmlPart(data,"IRS990"),books=xmlPart(form,"BooksInCareOfDetail");
    need(xmlValue(filer,"EIN")===e.ein && sameRegistryLegalName(xmlValue(xmlPart(filer,"BusinessName"),"BusinessNameLine1Txt"),e.legalName)
      && !/<BusinessNameLine2Txt(?:\s|>)/.test(xmlPart(filer,"BusinessName"))
      && xmlValue(header,"TaxPeriodEndDt")===s.sourceDate && xmlValue(header,"TaxYr")===s.sourceDate!.slice(0,4)
      && host(xmlValue(form,"WebsiteAddressTxt"))===host(e.declaredDomain),"IRS filer EIN, legal name, date or declared domain differs");
    const observed=xmlAddress(books),expected=index===0?e.historicalAddress:e.targetAddress;
    need(datedUsAddress(observed,expected),"IRS books address differs");
    if(index===0) {
      need(/^\d{10}$/.test(e.phone) && xmlValue(books,"PhoneNum")===e.phone,"IRS historical books phone differs");
      need(context.addresses.filter(a=>a.sourceKind==="netsuite_record" && datedUsAddress(a as Address,e.historicalAddress)).length===1,"exact historical canonical anchor missing or ambiguous");
    } else need(xmlValue(filer,"PhoneNum")===e.phone,"IRS filer phone continuity differs");
  }
}
function identityChain(e: RegistryOfficialDocumentEntry, context: CompanyIdentityContext) {
  if (e.chain === "official_irs_ein_historical_books_address") { irsIdentityChain(e,context); return; }
  const [official, own] = e.sources;
  need(/^\d{10}$/.test(e.phone) && own.text.replace(/\D/g, "").includes(e.phone), "own-site phone differs");
  if (e.chain === "dated_author_address") {
    need(official.kind === "municipal_pdf" && e.authorRole === "report_author_letterhead" && e.identityPage.page === 2
      && hash(e.identityPage.visualSha256) && sha(e.identityPage.text) === e.identityPage.sha256 && official.text.includes(e.identityPage.text)
      && official.sourceDate === e.documentDate, "author page, role or date differs");
    const page = compact(e.identityPage.text), header = compact(e.authorHeader);
    need(page.includes(header) && page.indexOf(header) < 250 && page.indexOf(header) < page.indexOf("Subject:")
      && compact(e.identityPage.text).includes(compact(e.signature)) && compact(e.signature).startsWith("Very truly yours,")
      && compact(e.signature).endsWith(e.legalName) && header.includes(e.domainLiteral) && host(e.domainLiteral) === e.canonicalDomain
      && header.replace(/\D/g, "").includes(e.phone), "authored document attribution differs");
    const a=e.targetAddress;
    need(header.includes(a.addressLine1) && (!a.addressLine2 || header.includes(a.addressLine2))
      && header.includes(a.city) && header.includes(a.state) && header.includes(a.postalCode), "author address components differ");
  } else {
    need(e.chain === "official_dba_own_site_address" && official.kind === "official_rendered_record"
      && e.officialRole === "licensed_legal_entity_and_dba" && e.ownSiteRole === "company_contact_address"
      && e.identifier.kind === "arizona_roc" && /^\d{6}$/.test(e.identifier.value), "DBA source roles differ");
    need(official.text.includes(e.officialIdentityQuote) && e.officialIdentityQuote.startsWith(`Business Entity Name\t${e.legalName}\nDoing Business As\t${e.dba}\nCity and State\t`)
      && e.officialIdentityQuote.endsWith(`${e.locality.city}, ${e.locality.state}, ${e.locality.postalCode}`)
      && official.text.includes(`LICENSE NUMBER ROC ${e.identifier.value}`) && official.text.includes(`Phone\t${e.phone.slice(0,3)}-${e.phone.slice(3,6)}-${e.phone.slice(6)}`)
      && official.text.includes(`Status / Action\t\n${e.sourceStatus}\n`) && official.text.includes(`Sub Status\t${e.sourceSubStatus}\n`), "official legal DBA identifier differs");
    need(own.text.includes(e.ownSiteContactQuote) && e.ownSiteContactQuote.startsWith("Get in touch ")
      && e.ownSiteContactQuote.includes(`ROC ${e.identifier.value} B-1`) && own.text.startsWith(e.dba)
      && e.ownSiteContactQuote.replace(/\D/g, "").includes(e.phone), "own-site identity block differs");
    const a=e.targetAddress,q=e.ownSiteContactQuote;
    need(q.includes(a.addressLine1) && (!a.addressLine2 || q.includes(a.addressLine2)) && q.includes(a.city) && q.includes(a.state) && q.includes(a.postalCode)
      && words(a.city)===words(e.locality.city) && a.state===e.locality.state && a.postalCode===e.locality.postalCode, "own-site full address/locality differs");
  }
}
/** A retained dated association only; never a canonical-field update or a claim
 * that an old address, license status, debt or financial value is current. */
export function verifyRegistryOfficialDocument(row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now=new Date()): NonNullable<RegistryProfile["verification"]> {
  const keys=["schema","entryId","entrySha256","canonicalIdentitySha256","reader","reviewer"];
  need(object(raw) && Object.keys(raw).every(k=>keys.includes(k)) && keys.every(k=>Object.hasOwn(raw,k)) && raw.schema==="official_document_roles_v1" && typeof raw.entryId==="string", "proof shape invalid");
  const {entry:e,sha256}=registryOfficialDocumentEntry(raw.entryId);
  need(raw.entrySha256===sha256, "entry changed"); sourceChecks(e); originalTarget(row,e); identityChain(e,context);
  need(company.id===e.companyId && row.companyId===e.companyId && company.netsuite_internal_id===e.internalId && row.internalId===e.internalId
    && host(company.domain||company.website_raw||"")===e.canonicalDomain && sameRegistryLegalName(company.name,e.legalName)
    && context.aliases.every(x=>sameRegistryLegalName(x,e.legalName)) && raw.canonicalIdentitySha256===e.canonicalIdentitySha256
    && raw.canonicalIdentitySha256===registryOfficialDocumentCanonicalHash(company,context), "canonical identity or legal operator changed");
  const {reader,reviewer,...bare}=raw,bound=registryOfficialDocumentEvidenceHash(row,bare as Omit<RegistryOfficialDocumentCorroboration,"reader"|"reviewer">);
  const earliest=Math.max(Date.parse(row.profile.observedAt),...e.sources.map(s=>Date.parse(s.observedAt)),...[e.sourceReader,e.sourceReviewer,e.originalReviews.primary,e.originalReviews.independent].map(r=>Date.parse(r.reviewedAt)),...context.addresses.map(a=>Date.parse(a.capturedAt)));
  need(Number.isFinite(earliest),"canonical/source date invalid");
  for(const w of [reader,reviewer]) need(object(w) && Object.keys(w).every(k=>["taskId","reviewedAt","evidenceSha256"].includes(k)) && task(w.taskId) && iso(w.reviewedAt)
    && Date.parse(w.reviewedAt)>=earliest && Date.parse(w.reviewedAt)<=now.getTime()+60000 && now.getTime()-Date.parse(w.reviewedAt)<=7*86400000 && w.evidenceSha256===bound,"final witness invalid");
  need((reader as Witness).taskId!==(reviewer as Witness).taskId && Date.parse((reviewer as Witness).reviewedAt)>=Date.parse((reader as Witness).reviewedAt),"independent ordered final witnesses required");
  return {method:"reviewed_official_registration_history",verifiedAt:now.toISOString(),sourceIds:[`document:${e.id}:${sha256}`],officialHistory:{...bare,reader,reviewer,evidenceSha256:bound,entry:e,
    targetAddress:{role:e.target.role,...row.profile.identity},canonicalAddresses:structuredClone(context.addresses),
    scope:"Reviewed dated document identity association only. Address roles/dates remain separate; no canonical mutation, current occupancy, debt balance, company revenue, budget or license-wide conclusion is inferred."}};
}
