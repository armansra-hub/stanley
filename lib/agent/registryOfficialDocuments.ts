import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { registryContentHash, sameRegistryLegalName, sameRegistryStreet, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import { registryOfficialApiCanonicalHash } from "./registryOfficialApi";
import catalog from "./registryOfficialDocumentEntries.json";

type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
type Witness = { taskId: string; reviewedAt: string; evidenceSha256: string };
type Read = { taskId: string; reviewedAt: string; receiptSha256: string; receiptActorField: string };
type Address = { addressLine1: string; addressLine2?: string; city: string; state: string; postalCode: string; countryCode: "US" };
type Source = { kind: "municipal_pdf" | "official_rendered_record" | "own_website" | "company_pdf"; url: string; requestedUrl: string | null; hops: {url:string;status:number}[] | null; observedAt: string;
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
type IrsContactEntry = Omit<BaseEntry, "sources" | "target"> & { chain: "official_irs_filer_books_own_site_contact";
  sources: [IrsSource, Source]; target: Omit<Target, "dataset" | "role"> & { dataset: "irs_exempt"; role: "exempt_organization" };
  ein: string; canonicalName: string; filerLegalName: string; declaredWebsite: null;
  filerAddressRole: "filer_return_address"; filerAddress: Address; filerPhone: string;
  booksRole: "books_in_care_of_contact"; booksLocator: "Return/ReturnData/IRS990/BooksInCareOfDetail";
  booksPerson: string; booksPhone: string; booksAddress: Address;
  ownSiteRole: "company_contact_block"; ownSiteSubject: string; ownSiteContactQuote: string; ownSitePhoneLiteral: string; ownSiteAddress: Address;
  taxPeriodBegin: string; taxPeriodEnd: string; returnTimestamp: string;
  bmfAddressEquivalenceClaim: false; legalNameNormalizationClaim: false; currentPhysicalAddressClaim: false; financialInference: false };
type MunicipalCslbEntry = Omit<BaseEntry, "target"> & { chain: "official_municipal_dba_cslb_header";
  target: Omit<Target, "dataset" | "role"> & { dataset: "ca_contractors"; role: "contractor_mailing_address" };
  csvHeader: { text: string; sha256: string; inspectionReceiptSha256: string };
  secondName: { column: "BUS-NAME-2"; value: string; typeColumn: "NAME-TP-2"; typeValue: "Current Name" };
  municipal: { recordId: "CLR21-0269"; role: "legal_company_name_and_dba"; legalCompanyName: string; dba: string;
    companyEmail: string; address: Address; identityQuote: string; headerStatus: "Active"; headerExpiry: "03/31/2024";
    detailExpiry: "2024-10-01"; currentLicenseClaim: false };
  ownSiteRole: "company_headquarters"; ownSiteContactQuote: string; sourceStatus: "QUAL Bond SUSP" };
type CompanyPdfEntry = BaseEntry & { chain: "company_pdf_contact_role";
  ownSiteRole: "legal_operator_name_and_phone"; ownSiteLegalName: string; ownSiteIdentityQuote: string;
  pdf: { role: "historical_company_contact_block"; currentAddressClaim: false; publicationDateClaim: false;
    pageCount: number; pages: { page: number; text: string; textSha256: string; visualSha256: string }[];
    extractionReceiptSha256: string; identityPage: number; contactBlock: string; domainLiteral: string;
    phoneLiteral: string; addressLineLiteral: string; localityLiteral: string; address: Address;
    period: { role: "event_brochure_year"; year: string; visibleCoverPage: number; eventPage: number; eventDateQuotes: string[] } } };
type CourtSource = Omit<Source, "kind" | "completeRead"> & { kind: "court_filed_pdf_excerpt";
  completeRead: false; selectedExcerptCompleteRead: true };
type CourtEntry = Omit<BaseEntry, "sources"> & { chain: "court_contract_counterparty_contact";
  sources: [CourtSource, Source]; ownSiteRole: "business_contact_email"; ownSiteContactEmail: string; contactEmailDomain: string;
  originalCountry: { rawCountry: string | null; profileCountryCode: string | null; missingValuesPreserved: true; jurisdiction: "Colorado public UCC registry" };
  court: { role: "historical_contract_counterparty_contact"; filingDate: string; filingDateText: string;
    fullDocumentPages: number; fullDocumentRead: false; selectedPagesCompleteRead: true;
    pages: { page: number; text: string; textSha256: string; visualSha256: string }[]; excerptReceiptSha256: string;
    caseNumber: string; noticeDocument: string; scheduleDocument: string; noticeTitle: string;
    sectionPage: number; rowPage: number; header: string; sectionTitle: string; rowQuote: string;
    row: { counterparty: string; debtor: string; cure: string; agreement: string; addressLine1: string; addressLine2: string;
      city: string; state: string; postalCode: string; email: string; remitEmail: string };
    address: Address; addressEffectiveDate: null; contractDate: null; currentAddressClaim: false;
    counterpartyBankruptcyClaim: false; assignmentCompletedClaim: false; financialInference: false } };
type ConferenceSource = Omit<Source, "kind" | "completeRead"> & { kind: "university_conference_pdf_excerpt"; completeRead: false; selectedExcerptCompleteRead: true };
type ConferenceEntry = Omit<BaseEntry, "sources"> & { chain: "university_conference_business_contact"; sources: [ConferenceSource];
  conference: { role: "historical_attendee_business_contact"; publisher: string; title: string; eventYear: string;
    fullDocumentPages: number; fullDocumentRead: false; selectedPagesCompleteRead: true;
    pages: {page:number;text:string;textSha256:string;visualSha256:string}[]; excerptReceiptSha256:string; identityPage:number;
    contactBlock:string; person:string; personTitle:string; companyDisplay:string; email:string; phoneLiteral:string;
    addressLineLiteral:string; localityLiteral:string; address:Address; publicationDate:null; addressEffectiveDate:null;
    currentAddressClaim:false; registeredOfficeClaim:false; currentEmploymentClaim:false; continuousOccupancyClaim:false; financialInference:false } };
type BrokerEntry = Omit<BaseEntry, "target" | "sources" | "phone"> & { chain: "own_legal_terms_broker_identifiers";
  target: Omit<Target, "dataset" | "role"> & { dataset: "fmcsa"; role: "registered_carrier_broker" }; sources: [Source];
  broker: { ownSiteRole: "contracting_legal_party_and_explicit_broker_identifiers"; termsLegalName: string;
    contractQuote: string; disclosureQuote: string; usdot: string; mc: string;
    registrationAddressRole: "original_fmcsa_only"; websiteStreetAddress: null; physicalAddressCorroborated: false;
    currentAuthorityClaim: false; fullNormalizedTextRead: true; renderedCompletenessClaim: false; termsEffectiveDate: null } };
export type RegistryOfficialDocumentEntry = AuthorEntry | DbaEntry | IrsEntry | IrsContactEntry | MunicipalCslbEntry | CompanyPdfEntry | CourtEntry | ConferenceEntry | BrokerEntry;
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
  need(catalog.schema === "reviewed_official_document_entries_v1" && [2,3,4,6,12,13,14,15].includes(entries.length) && matches.length === 1, "entry missing or ambiguous");
  return { entry: structuredClone(matches[0]), sha256: sha(stableRegistryJson(matches[0])) };
}
export const registryOfficialDocumentCanonicalHash = registryOfficialApiCanonicalHash;
export function registryOfficialDocumentEvidenceHash(row: RegistryFinding, proof: Omit<RegistryOfficialDocumentCorroboration, "reader" | "reviewer">) {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId, contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
function sourceChecks(e: RegistryOfficialDocumentEntry) {
  if (e.chain === "official_irs_ein_historical_books_address") irsSourceChecks(e);
  else if (e.chain === "official_irs_filer_books_own_site_contact") irsContactSourceChecks(e);
  else if (e.chain === "official_municipal_dba_cslb_header") municipalCslbSourceChecks(e);
  else if (e.chain === "company_pdf_contact_role") companyPdfSourceChecks(e);
  else if (e.chain === "court_contract_counterparty_contact") courtSourceChecks(e);
  else if (e.chain === "university_conference_business_contact") conferenceSourceChecks(e);
  else if (e.chain === "own_legal_terms_broker_identifiers") brokerSourceChecks(e);
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
  if (e.chain === "dated_author_address" || e.chain === "company_pdf_contact_role" || e.chain === "court_contract_counterparty_contact" || e.chain === "university_conference_business_contact") {
    const lines = row.evidence.split("\n"); need(p.dataset === "co_ucc" && t.role === "debtor_business" && lines.length === 2, "target debtor role invalid");
    raw = JSON.parse(lines[0]); const filing = JSON.parse(lines[1]);
    if(e.chain === "court_contract_counterparty_contact") {
      const c=e.originalCountry;
      need(c.missingValuesPreserved===true && c.jurisdiction==="Colorado public UCC registry"
        && c.rawCountry===(Object.hasOwn(raw,"country")?raw.country:null)
        && c.profileCountryCode===(Object.hasOwn(p.identity,"countryCode")?p.identity.countryCode:null)
        && (raw.country==="United States" || !Object.hasOwn(raw,"country"))
        && (!Object.hasOwn(p.identity,"countryCode") || p.identity.countryCode==="US")
        && raw.state==="CO" && p.identity.state==="CO","court original country presence differs");
    }
    need(sha(lines[0]) === t.rowSha256 && (raw.country === "United States" || e.chain === "court_contract_counterparty_contact") && p.recordId === `${raw.fileid}:${raw.debtorid}` && filing.fileid === raw.fileid
      && raw.organizationname === p.identity.legalName && raw.address1 === p.identity.addressLine1 && (raw.address2 || "") === (p.identity.addressLine2 || "")
      && raw.city === p.identity.city && raw.state === p.identity.state && raw.zipcode === p.identity.postalCode
      && u.hostname === "data.colorado.gov" && u.pathname === "/resource/8upq-58vz.json" && [...u.searchParams.keys()].join() === "debtorid"
      && u.searchParams.get("debtorid") === raw.debtorid, "original UCC record differs");
  } else if (e.chain === "own_legal_terms_broker_identifiers") {
    const parts=row.evidence.split("\nOriginal public source row: ");
    need(p.dataset==="fmcsa" && t.role==="registered_carrier_broker" && parts.length===2 && p.recordId==="2288433", "target broker role differs");
    const normalized=JSON.parse(parts[0]); raw=JSON.parse(parts[1]);
    need(sha(parts[1])===t.rowSha256 && stableRegistryJson(normalized)===stableRegistryJson(p.provenance.sourceRow)
      && raw.dot_number===p.recordId && raw.dot_number===e.broker.usdot && raw.docket1===e.broker.mc && raw.docket1prefix==="MC"
      && raw.legal_name===p.identity.legalName && raw.phy_street===p.identity.addressLine1 && raw.phy_city===p.identity.city
      && raw.phy_state===p.identity.state && raw.phy_zip===p.identity.postalCode && raw.phy_country===p.identity.countryCode
      && p.sourceAsOf===null && p.provenance.sourceRow.usdot_number===raw.dot_number
      && p.facts.filter(f=>f.field==="usdot_number" && f.value===raw.dot_number).length===1
      && u.href==="https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=2288433", "original broker identity or identifiers differ");
  } else if (e.chain === "official_irs_ein_historical_books_address" || e.chain === "official_irs_filer_books_own_site_contact") {
    const parts=row.evidence.split("\nOriginal public source row: ");
    need(p.dataset==="irs_exempt" && t.role==="exempt_organization" && /^\d{9}$/.test(p.recordId) && parts.length===2,"target IRS role invalid");
    raw=JSON.parse(parts[1]); const normalized=JSON.parse(parts[0]);
    need(sha(parts[1])===t.rowSha256 && stableRegistryJson(normalized)===stableRegistryJson(p.provenance.sourceRow)
      && raw.EIN===p.recordId && p.recordId===e.ein && p.provenance.sourceRow.ein===e.ein
      && p.facts.filter(f=>f.field==="ein" && f.value===e.ein).length===1
      && raw.NAME===p.identity.legalName && raw.STREET===p.identity.addressLine1 && raw.CITY===p.identity.city
      && raw.STATE===p.identity.state && raw.ZIP===p.identity.postalCode && raw.TAX_PERIOD===p.provenance.sourceRow.tax_period
      && u.hostname==="www.irs.gov" && /^\/pub\/irs-soi\/eo[1-4]\.csv$/.test(u.pathname) && !u.search,"original IRS BMF identity differs");
  } else if (e.chain === "official_municipal_dba_cslb_header") {
    need(p.dataset === "ca_contractors" && t.role === "contractor_mailing_address" && p.recordId === "789382"
      && u.href === "https://web.cslb.ca.gov/Onlineservices/DataPortal/ContractorList" && sha(row.evidence) === t.rowSha256,
      "original CSLB target differs");
    const headers=parseCsv(e.csvHeader.text),values=parseCsv(row.evidence);
    need(sha(e.csvHeader.text)===e.csvHeader.sha256 && hash(e.csvHeader.inspectionReceiptSha256)
      && headers.length===1 && values.length===1 && headers[0].length===52 && values[0].length===52
      && new Set(headers[0]).size===52,"CSLB header/row shape differs");
    raw=Object.fromEntries(headers[0].map((h,i)=>[h,values[0][i]]));
    need(raw.LicenseNo===p.recordId && raw.BusinessName===p.identity.legalName && raw.MailingAddress===p.identity.addressLine1
      && raw.City===p.identity.city && raw.State===p.identity.state && raw.ZIPCode===p.identity.postalCode
      && raw.country==="" && raw.FullBusinessName==="" && e.secondName.column==="BUS-NAME-2"
      && e.secondName.typeColumn==="NAME-TP-2" && e.secondName.typeValue==="Current Name"
      && raw[e.secondName.column]===e.secondName.value && raw[e.secondName.typeColumn]===e.secondName.typeValue,
      "typed CSLB business names or mailing address differ");
    const fields={license_number:"LicenseNo",license_status:"PrimaryStatus",license_type:"Classifications(s)",legal_structure:"BusinessType",license_issue_date:"IssueDate",license_expiry_date:"ExpirationDate"};
    need(Object.entries(fields).every(([field,column])=>p.facts.filter(f=>f.field===field && f.value===raw[column]).length===1
      && p.provenance.sourceRow[field]===raw[column]) && raw.PrimaryStatus===e.sourceStatus && e.sourceStatus==="QUAL Bond SUSP",
      "CSLB status or dated facts differ");
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
function irsArchiveSourceChecks(s: IrsSource) {
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
function irsSourceChecks(e: IrsEntry) {
  need(e.sources.length===2,"IRS source count differs");
  for (const s of e.sources) irsArchiveSourceChecks(s);
  const c=e.assignedDomainConflict;
  need(c && c.disposition==="retain_assigned_domain_as_distinct_entity" && c.domain===e.canonicalDomain
    && host(c.url)===e.canonicalDomain && iso(c.observedAt) && hash(c.packetSha256) && c.packetSha256===e.originalReviews.packetSha256
    && hash(c.htmlSha256) && sha(c.text)===c.textSha256 && c.text.length>20 && c.text.length<=150000
    && /^\d{9}$/.test(c.ein) && c.ein!==e.ein && !sameRegistryLegalName(c.legalName,e.legalName)
    && c.text.includes(c.identityQuote) && c.identityQuote.includes(c.legalName)
    && c.identityQuote.includes(c.ein.slice(0,2)+"-"+c.ein.slice(2)),"assigned-domain conflict missing or changed");
  need([e.sourceReader,e.sourceReviewer].every(r=>Date.parse(r.reviewedAt)>=Date.parse(c.observedAt)),"domain conflict source chronology differs");
}
// One reviewed BMF/EIN filing joined to its own-site subject by two separately
// labelled phones and a full books-contact address. This is not a name repair,
// BMF street normalization, declared-domain claim, or current physical address.
function irsContactSourceChecks(e: IrsContactEntry) {
  need(e.id==="seniors-208176668-irs-books-own-site-contact" && e.companyId==="10e99999-acd6-4e4a-bd06-b8b34bf1b5d2"
    && e.internalId==="202585537" && e.canonicalDomain==="seniorsonthegowi.com" && e.canonicalName==="Seniors On The Go"
    && e.target.dataset==="irs_exempt" && e.target.role==="exempt_organization" && e.target.recordId==="208176668"
    && e.sources.length===2,"IRS contact finite scope differs");
  const [filing,own]=e.sources; irsArchiveSourceChecks(filing);
  need(filing.status===206 && filing.archive.member==="202533149349303053_public.xml"
    && filing.url==="https://apps.irs.gov/pub/epostcard/990/xml/2025/2025_TEOS_XML_11B.zip","IRS contact original filing differs");
  need(own.kind==="own_website" && own.status===200 && own.url==="https://seniorsonthegowi.com/" && own.requestedUrl===own.url
    && publicUrl(own.url).hostname===e.canonicalDomain && own.hops?.length===1 && own.hops[0].url===own.url && own.hops[0].status===200
    && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/.test(own.contentType??"") && iso(own.observedAt)
    && hash(own.receiptSha256) && hash(own.originalSourcePin) && hash(own.bodySha256) && own.completeRead===true
    && own.text.length>100 && own.text.length<=150000 && sha(own.text)===own.textSha256
    && own.sourceDate===null && own.sourceDateText===null,"IRS contact own-site source differs");
}
function irsContactIdentityChain(e: IrsContactEntry,context: CompanyIdentityContext) {
  const [filing,own]=e.sources;
  need(e.ein==="208176668" && e.legalName==="SENIORS ON THE GO INC" && e.filerLegalName==="Senior on the Go Inc"
    && e.declaredWebsite===null && e.filerAddressRole==="filer_return_address" && e.booksRole==="books_in_care_of_contact"
    && e.booksLocator==="Return/ReturnData/IRS990/BooksInCareOfDetail" && e.ownSiteRole==="company_contact_block"
    && e.bmfAddressEquivalenceClaim===false && e.legalNameNormalizationClaim===false && e.currentPhysicalAddressClaim===false
    && e.financialInference===false && context.aliases.length===0 && context.addresses.length===0,"IRS contact roles or claim boundary differs");
  const header=xmlPart(filing.text,"ReturnHeader"),filer=xmlPart(header,"Filer"),name=xmlPart(filer,"BusinessName"),
    form=xmlPart(xmlPart(filing.text,"ReturnData"),"IRS990"),books=xmlPart(form,"BooksInCareOfDetail");
  need(xmlValue(filer,"EIN")===e.ein && xmlValue(name,"BusinessNameLine1Txt")===e.filerLegalName
    && !/<BusinessNameLine2Txt(?:\s|>)/.test(name) && !/<WebsiteAddressTxt(?:\s|>)/.test(filing.text)
    && xmlValue(header,"TaxPeriodBeginDt")===e.taxPeriodBegin && e.taxPeriodBegin==="2024-01-01"
    && xmlValue(header,"TaxPeriodEndDt")===e.taxPeriodEnd && e.taxPeriodEnd==="2024-12-31" && filing.sourceDate===e.taxPeriodEnd
    && xmlValue(header,"TaxYr")==="2024" && xmlValue(header,"ReturnTs")===e.returnTimestamp
    && e.returnTimestamp==="2025-11-10T12:00:39-05:00","IRS contact filer, domain absence or period differs");
  need(e.phone==="2623635700" && e.filerPhone===e.phone && e.booksPhone===e.phone && xmlValue(filer,"PhoneNum")===e.filerPhone
    && xmlValue(books,"PhoneNum")===e.booksPhone && xmlValue(books,"PersonNm")===e.booksPerson && e.booksPerson==="Jack Wieber",
    "IRS filer or books-contact phone differs");
  const filerAddress=xmlAddress(filer),booksAddress=xmlAddress(books);
  need(stableRegistryJson(filerAddress)===stableRegistryJson(e.filerAddress)
    && e.filerAddress.addressLine1==="575 Bayview Suite 106" && e.filerAddress.city==="Mukwonago" && e.filerAddress.state==="WI" && e.filerAddress.postalCode==="53149"
    && stableRegistryJson(booksAddress)===stableRegistryJson(e.booksAddress)
    && e.booksAddress.addressLine1==="575 Bayview Rd Suite 106" && e.booksAddress.city==="Mukwonago" && e.booksAddress.state==="WI" && e.booksAddress.postalCode==="53149",
    "IRS separate filer/books address differs");
  const a=e.ownSiteAddress,q=e.ownSiteContactQuote;
  need(e.ownSiteSubject==="Seniors On The Go - Taxi & Transportation" && e.ownSitePhoneLiteral==="(262) 363-5700"
    && e.ownSitePhoneLiteral.replace(/\D/g,"")===e.phone && own.text.startsWith(`${e.ownSiteSubject} - Mukwonago, WI `)
    && q===`${e.ownSitePhoneLiteral} ${e.ownSiteSubject} ${a.addressLine1} ${a.city}, ${a.state} ${a.postalCode}`
    && own.text.slice(0,350).split(q).length===2 && own.text.indexOf(q)<own.text.indexOf("About Us")
    && a.addressLine1==="575 Bayview Road Suite 106" && a.city==="Mukwonago" && a.state==="WI" && a.postalCode==="53149"
    && !a.addressLine2 && fullAddress(e.booksAddress,a),"IRS own-site company-scoped complete contact differs");
  need(e.targetAddress.addressLine1==="575 BAY VIEW RD STE 106" && e.targetAddress.city==="MUKWONAGO"
    && e.targetAddress.state==="WI" && e.targetAddress.postalCode==="53149-1749","IRS original BMF address literal differs");
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
  if (e.chain === "official_irs_filer_books_own_site_contact") { irsContactIdentityChain(e,context); return; }
  if (e.chain === "official_municipal_dba_cslb_header") { municipalCslbIdentityChain(e); return; }
  if (e.chain === "company_pdf_contact_role") { companyPdfIdentityChain(e); return; }
  if (e.chain === "court_contract_counterparty_contact") { courtIdentityChain(e); return; }
  if (e.chain === "university_conference_business_contact") { conferenceIdentityChain(e); return; }
  if (e.chain === "own_legal_terms_broker_identifiers") { brokerIdentityChain(e); return; }
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
// A finite reviewed municipal record; this does not authorize arbitrary municipal
// hosts, records, caller aliases, or an unlabelled second CSV name.
function municipalCslbSourceChecks(e: MunicipalCslbEntry) {
  need(e.companyId==="253e14e5-7273-49af-9874-fb64efeb16d0" && e.internalId==="940173"
    && e.canonicalDomain==="siggins.com" && e.target.recordId==="789382" && e.sources.length===2,"municipal CSLB scope differs");
  const [official,own]=e.sources;
  for(const s of e.sources) need(iso(s.observedAt) && hash(s.receiptSha256) && hash(s.originalSourcePin) && s.completeRead===true
    && s.text.length>20 && s.text.length<=150000 && sha(s.text)===s.textSha256 && s.sourceDate===null && s.sourceDateText===null,
    "municipal complete source or date pin differs");
  need(official.kind==="official_rendered_record" && publicUrl(official.url).href==="https://blaine.ims16.com/ims/Base/Details?EncrID=713445394"
    && official.status===null && official.bodySha256===null && official.contentType===null && official.requestedUrl===null && official.hops===null,
    "municipal DOM capture provenance differs");
  need(own.kind==="own_website" && publicUrl(own.url).href==="https://siggins.com/locations/" && own.requestedUrl===own.url
    && own.status===200 && hash(own.bodySha256) && /^text\/html(?:;|$)/.test(own.contentType??"")
    && own.hops?.length===1 && own.hops[0].url===own.url && own.hops[0].status===200,"retained headquarters capture differs");
}
function municipalCslbIdentityChain(e: MunicipalCslbEntry) {
  const [official,own]=e.sources,m=e.municipal,a=m.address;
  need(m.recordId==="CLR21-0269" && m.role==="legal_company_name_and_dba" && e.ownSiteRole==="company_headquarters"
    && m.currentLicenseClaim===false && m.headerStatus==="Active" && m.headerExpiry==="03/31/2024" && m.detailExpiry==="2024-10-01",
    "municipal roles or conflicting historical dates differ");
  const names=m.legalCompanyName.split(" / ");
  need(names.length===2 && sameRegistryLegalName(names[0],e.secondName.value) && sameRegistryLegalName(names[1],m.dba)
    && words(m.dba)==="siggins company" && words(e.legalName)==="siggins co"
    && /^[^\s@]+@siggins\.com$/.test(m.companyEmail),"municipal legal DBA/domain chain differs");
  const quote=`DBA\n${m.dba}\nLegal/Company Name\n${m.legalCompanyName}\nAddress\n${a.addressLine1}\n${a.city}, ${a.state} ${a.postalCode}\nCompany Email\n${m.companyEmail}\nBusiness Phone\n`;
  need(m.identityQuote===quote && official.text.split(quote).length===2 && official.text.includes(` ${m.recordId}\n`)
    && official.text.includes(`Active\u00a0\u00a0\u00a0Expiration\u00a0Date:\u00a0${m.headerExpiry}`)
    && official.text.includes(`License Information\nExpiration Date\n${m.detailExpiry}\n`),"municipal typed record block differs");
  need(fullAddress(a,e.targetAddress) && e.ownSiteContactQuote===`Headquarters Kansas City, MO 512 E 12th Ave, North Kansas City, MO 64116`
    && own.text.split(e.ownSiteContactQuote).length===2 && own.text.includes("Siggins")
    && fullAddress({addressLine1:"512 E 12th Ave",city:"North Kansas City",state:"MO",postalCode:"64116",countryCode:"US"},e.targetAddress)
    && /^\d{10}$/.test(e.phone) && own.text.replace(/\D/g,"").includes(e.phone),"shared full headquarters or own-site subject differs");
}
// This reusable contact-role check operates only on finite, build-reviewed catalog
// entries. It neither fetches PDFs nor accepts caller-authored page/role evidence.
function companyPdfSourceChecks(e: CompanyPdfEntry) {
  const [pdf,own]=e.sources,p=e.pdf;
  need(e.sources.length===2 && pdf.kind==="company_pdf" && own.kind==="own_website"
    && e.target.dataset==="co_ucc" && e.target.role==="debtor_business","company PDF source classes differ");
  for(const s of e.sources) need(iso(s.observedAt) && hash(s.receiptSha256) && hash(s.originalSourcePin)
    && hash(s.bodySha256) && s.completeRead===true && s.status===200 && s.text.length>20 && s.text.length<=150000
    && sha(s.text)===s.textSha256 && s.sourceDate===null && s.sourceDateText===null,"company PDF complete source/date differs");
  const u=publicUrl(pdf.url),w=publicUrl(own.url);
  need(u.hostname.replace(/^www\./,"")===e.canonicalDomain && u.pathname.endsWith(".pdf") && !u.search
    && pdf.requestedUrl===pdf.url && pdf.contentType==="application/pdf" && pdf.hops?.length===1
    && pdf.hops[0].url===pdf.url && pdf.hops[0].status===200,"company PDF capture authority differs");
  need(w.hostname.replace(/^www\./,"")===e.canonicalDomain && w.pathname==="/" && !w.search
    && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/.test(own.contentType??"")
    && own.hops && own.hops.length>0 && own.hops.length<=5 && own.hops[0].url===own.requestedUrl
    && own.hops.at(-1)?.url===own.url && own.hops.at(-1)?.status===200
    && own.hops.every((h,i)=>host(h.url)===e.canonicalDomain && (i===own.hops!.length-1?h.status===200:[301,302,303,307,308].includes(h.status))),"company website capture provenance differs");
  need(p && Number.isSafeInteger(p.pageCount) && p.pageCount>=1 && p.pageCount<=100 && p.pages.length===p.pageCount
    && hash(p.extractionReceiptSha256) && p.extractionReceiptSha256===pdf.originalSourcePin
    && p.pages.every((page,i)=>page.page===i+1 && page.text.length>0 && sha(page.text)===page.textSha256 && hash(page.visualSha256))
    && pdf.text===p.pages.map(page=>`--- PAGE ${page.page} ---\n${page.text}`).join("\n\n"),"company PDF full-page extraction differs");
}
function companyPdfIdentityChain(e: CompanyPdfEntry) {
  const [pdf,own]=e.sources,p=e.pdf,a=p.address;
  need(p.role==="historical_company_contact_block" && p.currentAddressClaim===false && p.publicationDateClaim===false
    && e.ownSiteRole==="legal_operator_name_and_phone" && sameRegistryLegalName(e.ownSiteLegalName,e.legalName)
    && own.text.split(e.ownSiteIdentityQuote).length===2 && e.ownSiteIdentityQuote.startsWith(`${e.ownSiteLegalName} is `),"company PDF subject or address role differs");
  need(Number.isSafeInteger(p.identityPage) && p.identityPage>=1 && p.identityPage<=p.pageCount
    && p.contactBlock.length>30 && p.pages[p.identityPage-1].text.split(p.contactBlock).length===2
    && pdf.text.split(p.contactBlock).length===2 && host(p.domainLiteral)===e.canonicalDomain
    && p.contactBlock.split(p.domainLiteral).length===2 && /^\d{10}$/.test(e.phone)
    && p.phoneLiteral.replace(/\D/g,"")===e.phone && p.contactBlock.split(p.phoneLiteral).length===2
    && own.text.replace(/\D/g,"").includes(e.phone),"company PDF domain/phone/contact block differs");
  const compactOrdinal=(s:string)=>compact(s).replace(/(\d)\s+(st|nd|rd|th)\b/gi,"$1$2");
  need(p.contactBlock.includes(p.addressLineLiteral) && p.contactBlock.includes(p.localityLiteral)
    && sameRegistryStreet({addressLine1:compactOrdinal(p.addressLineLiteral)},{addressLine1:a.addressLine1,addressLine2:a.addressLine2})
    && p.localityLiteral===`${a.city}, ${a.state} ${a.postalCode}` && fullAddress(a,e.targetAddress),"company PDF full historical address differs");
  const period=p.period;
  need(period.role==="event_brochure_year" && /^\d{4}$/.test(period.year) && Number(period.year)<=new Date(pdf.observedAt).getUTCFullYear()
    && Number.isSafeInteger(period.visibleCoverPage) && period.visibleCoverPage>=1 && period.visibleCoverPage<=p.pageCount
    && Number.isSafeInteger(period.eventPage) && period.eventPage>=1 && period.eventPage<=p.pageCount
    && period.eventDateQuotes.length>0 && period.eventDateQuotes.length<=10 && new Set(period.eventDateQuotes).size===period.eventDateQuotes.length
    && period.eventDateQuotes.every(q=>q.includes(period.year) && q.length>15 && p.pages[period.eventPage-1].text.split(q).length===2),"company PDF visible event period differs");
}
// A filed counterparty schedule is third-party evidence. Full bytes are retained,
// while the actual read claim is limited to the explicitly pinned complete pages.
function courtSourceChecks(e: CourtEntry) {
  const [pdf,own]=e.sources,c=e.court;
  need(e.sources.length===2 && e.companyId==="db1fd9a5-5398-4d5f-8d2a-b90639645309" && e.internalId==="190125582"
    && e.canonicalDomain==="redskyconsulting.co" && e.target.dataset==="co_ucc" && e.target.role==="debtor_business",
    "court finite source scope differs");
  for(const s of e.sources) need(iso(s.observedAt) && hash(s.receiptSha256) && hash(s.originalSourcePin) && hash(s.bodySha256)
    && s.status===200 && s.text.length>20 && s.text.length<=150000 && sha(s.text)===s.textSha256,"court source text/capture differs");
  need(pdf.kind==="court_filed_pdf_excerpt" && pdf.completeRead===false && pdf.selectedExcerptCompleteRead===true
    && pdf.url==="https://casedocs.omniagentsolutions.com/cmsvol2/pub_47557/fb796d69-4cfe-4d40-884e-a605c7a37800_129.pdf"
    && publicUrl(pdf.url).hostname==="casedocs.omniagentsolutions.com" && pdf.requestedUrl===pdf.url && pdf.hops===null
    && pdf.contentType==="application/pdf" && pdf.sourceDate===c.filingDate && pdf.sourceDateText===c.filingDateText
    && c.filingDate==="2025-07-14" && c.filingDateText==="Filed 07/14/25" && Date.parse(c.filingDate)<=Date.parse(pdf.observedAt),
    "court PDF authority, limited scope or filing date differs");
  need(own.kind==="own_website" && own.completeRead===true && own.url==="https://redskyconsulting.co/contact/"
    && publicUrl(own.url).hostname===e.canonicalDomain && own.requestedUrl===own.url && own.hops?.length===1
    && own.hops[0].url===own.url && own.hops[0].status===200 && /^text\/html(?:;|$)/.test(own.contentType??"")
    && own.sourceDate===null && own.sourceDateText===null,"court canonical contact provenance differs");
  const required=[1,2,3,4,5,6,7,47,639];
  need(c.fullDocumentPages===1083 && c.fullDocumentRead===false && c.selectedPagesCompleteRead===true
    && c.pages.length===required.length && c.pages.every((p,i)=>p.page===required[i] && p.text.length>0
      && sha(p.text)===p.textSha256 && hash(p.visualSha256)) && hash(c.excerptReceiptSha256)
    && c.excerptReceiptSha256===pdf.originalSourcePin
    && pdf.text===c.pages.map(p=>`--- PHYSICAL PAGE ${p.page} ---\n${p.text}`).join("\n\n"),"court selected-page coverage differs");
  for(const p of c.pages) {
    const document=p.page<=6?c.noticeDocument:c.scheduleDocument,docketPage=p.page<=6?p.page:p.page-6,total=p.page<=6?6:1077;
    need(p.text.includes(`Case ${c.caseNumber} Doc ${document} ${c.filingDateText} Page ${docketPage} of ${total}`),
      "court selected-page docket label differs");
  }
}
function courtIdentityChain(e: CourtEntry) {
  const [pdf,own]=e.sources,c=e.court,r=c.row,page=(n:number)=>c.pages.find(p=>p.page===n)!.text;
  need(c.role==="historical_contract_counterparty_contact" && e.ownSiteRole==="business_contact_email"
    && c.caseNumber==="25-11195-JKS" && c.noticeDocument==="129" && c.scheduleDocument==="129-1"
    && c.addressEffectiveDate===null && c.contractDate===null && c.currentAddressClaim===false
    && c.counterpartyBankruptcyClaim===false && c.assignmentCompletedClaim===false && c.financialInference===false,
    "court contact role or claim boundary differs");
  need(c.noticeTitle==="AMENDED2 SUPPLEMENTAL NOTICE OF POSSIBLE ASSUMPTION AND ASSIGNMENT OF CERTAIN EXECUTORY CONTRACTS AND UNEXPIRED LEASES"
    && compact(page(1)).includes(c.noticeTitle) && compact(page(2)).includes("Debtors’ claims and noticing agent, Omni Agent Solutions, Inc.")
    && compact(page(3)).includes("The presence of a contract or lease listed on Exhibit 1 attached hereto does not constitute an admission")
    && page(6).includes("Dated: July 14, 2025") && page(7).includes("Exhibit 1"),"court notice attribution/context differs");
  need(c.sectionPage===47 && c.rowPage===639 && c.sectionTitle==="Contracts Related to Job Board Business - Monster Next Customers"
    && c.header==="Contract Counterparty Debtor Cure Agreement Name / Description Address 1 Address 2 City State / Province Zip Site Email Sup Remit Email"
    && page(c.sectionPage).startsWith(c.header+"\r\n") && page(c.sectionPage).includes(c.sectionTitle)
    && r.counterparty==="RED SKY Consulting LLC" && sameRegistryLegalName(r.counterparty,e.legalName)
    && r.debtor==="Monster Worldwide, LLC" && !sameRegistryLegalName(r.debtor,e.legalName)
    && r.cure==="$ -" && r.agreement==="Master Services Agreement; Sales Order" && r.addressLine2==="" && r.remitEmail==="",
    "court counterparty versus debtor table roles differ");
  const quote=`${r.counterparty} ${r.debtor} ${r.cure} ${r.agreement} ${r.addressLine1} ${r.city} ${r.state} ${r.postalCode} ${r.email}`;
  need(c.rowQuote===quote && page(c.rowPage).split("\r\n").filter(line=>line===quote).length===1 && pdf.text.split(quote).length===2,
    "court exact complete row differs");
  need(e.contactEmailDomain==="redsky-consulting.com" && e.ownSiteContactEmail==="contact@redsky-consulting.com"
    && own.text.includes(e.ownSiteContactEmail) && own.text.startsWith("Contact – Red Sky Consulting ")
    && /^[^\s@]+@redsky-consulting\.com$/.test(r.email) && r.email==="stacyw@redsky-consulting.com"
    && /^\d{10}$/.test(e.phone) && own.text.replace(/\D/g,"").includes(e.phone),"court canonical business-email bridge differs");
  need(r.addressLine1==="3015 Wyandot St" && r.city==="Denver" && r.state==="Colorado" && r.postalCode==="80211-3822"
    && c.address.addressLine1===r.addressLine1 && !c.address.addressLine2 && c.address.city===r.city && c.address.state==="CO"
    && c.address.postalCode===r.postalCode && c.address.countryCode==="US" && datedUsAddress(c.address,e.targetAddress),
    "court full address or explicit ZIP5 comparison differs");
}

// One reviewed university attendee block. It is not an office registration,
// a company-authored document, or a general directory/address matching route.
function conferenceSourceChecks(e: ConferenceEntry) {
  const s=e.sources[0],c=e.conference;
  need(e.sources.length===1 && e.companyId==="46996059-aa45-42c2-accc-ee9c18eb9b7f" && e.internalId==="4115726"
    && e.canonicalDomain==="gbsm.com" && e.target.dataset==="co_ucc" && e.target.recordId==="1352541:1087948"
    && e.target.role==="debtor_business","conference finite scope differs");
  need(s.kind==="university_conference_pdf_excerpt" && s.completeRead===false && s.selectedExcerptCompleteRead===true
    && s.status===200 && s.contentType==="application/pdf" && iso(s.observedAt) && hash(s.receiptSha256) && hash(s.bodySha256)
    && hash(s.originalSourcePin) && s.text.length>20 && s.text.length<=150000 && sha(s.text)===s.textSha256
    && s.sourceDate===null && s.sourceDateText===null,"conference capture or scoped text differs");
  need(publicUrl(s.url).href==="https://law.du.edu/sites/default/files/2023-11/2013%20Attendee%20List.pdf"
    && s.requestedUrl==="https://www.law.du.edu/sites/default/files/2023-11/2013%20Attendee%20List.pdf" && s.hops===null,
    "conference university provenance differs");
  need(c.fullDocumentPages===27 && c.fullDocumentRead===false && c.selectedPagesCompleteRead===true
    && c.pages.length===2 && c.pages.every((p,i)=>p.page===[1,7][i] && p.text.length>0 && sha(p.text)===p.textSha256 && hash(p.visualSha256))
    && hash(c.excerptReceiptSha256) && c.excerptReceiptSha256===s.originalSourcePin
    && s.text===c.pages.map(p=>`--- PHYSICAL PAGE ${p.page} ---\n${p.text}`).join("\n\n"),"conference complete selected pages differ");
}
function conferenceIdentityChain(e: ConferenceEntry) {
  const c=e.conference,s=e.sources[0],page=c.pages[1].text;
  need(c.role==="historical_attendee_business_contact" && c.publisher==="University of Denver, Sturm College of Law / Rocky Mountain Land Use Institute"
    && c.title==="2013 ROCKY MOUNTAIN LAND USE INSTITUTE CONFERENCE ATTENDEE LIST" && c.eventYear==="2013"
    && compact(c.pages[0].text).includes(c.title) && Number(c.eventYear)<=new Date(s.observedAt).getUTCFullYear()
    && c.publicationDate===null && c.addressEffectiveDate===null && c.currentAddressClaim===false && c.registeredOfficeClaim===false
    && c.currentEmploymentClaim===false && c.continuousOccupancyClaim===false && c.financialInference===false,"conference role or date claim differs");
  need(c.identityPage===7 && c.pages[0].text.startsWith("Speakers bolded and italicized Page 1\r\n")
    && page.startsWith("Speakers bolded and italicized Page 7\r\n") && c.person==="Davis, Alex" && c.personTitle==="Principal"
    && c.companyDisplay==="GBSM Consulting" && sameRegistryLegalName(e.legalName,"GBSM Inc.")
    && c.email==="alexdavis@gbsm.com" && c.email.split("@")[1]===e.canonicalDomain && c.phoneLiteral==="303-825-6100"
    && e.phone===c.phoneLiteral.replace(/\D/g,""),"conference business identity differs");
  const block=[c.person,c.personTitle,c.companyDisplay,c.addressLineLiteral,c.localityLiteral,c.phoneLiteral,c.email].join("\r\n");
  need(c.contactBlock===block && page.split(block).length===2 && s.text.split(block).length===2
    && page.includes(block+"\r\nDavis, Anna"),"conference exact attendee block differs");
  need(c.addressLineLiteral==="600 17th Street, Suite \r\n2020 South" && c.localityLiteral==="Denver, CO 80202"
    && c.address.addressLine1==="600 17th Street, Suite 2020 South" && !c.address.addressLine2 && c.address.city==="Denver"
    && c.address.state==="CO" && c.address.postalCode==="80202" && c.address.countryCode==="US"
    && e.targetAddress.addressLine1===c.address.addressLine1 && !e.targetAddress.addressLine2
    && fullAddress(c.address,e.targetAddress),"conference exact South address differs");
}

// One fully reviewed own-domain legal contract and explicit DOT/MC disclosure.
// The registry address remains registry evidence; no website address is invented.
function brokerSourceChecks(e: BrokerEntry) {
  const s=e.sources[0];
  need(e.companyId==="8349a8d8-6261-4f3a-8697-b49e8204448f" && e.internalId==="18302043"
    && e.canonicalDomain==="dormroommovers.com" && e.target.dataset==="fmcsa" && e.target.recordId==="2288433"
    && e.target.role==="registered_carrier_broker" && e.sources.length===1, "broker finite scope differs");
  need(s.kind==="own_website" && publicUrl(s.url).href==="https://www.dormroommovers.com/terms"
    && s.requestedUrl===s.url && s.status===200 && s.contentType==="text/html; charset=utf-8"
    && s.hops?.length===1 && s.hops[0].url===s.url && s.hops[0].status===200
    && iso(s.observedAt) && s.observedAt==="2026-10-02T08:04:01.404Z", "broker own-site capture provenance differs");
  need(s.completeRead===true && s.text.length===24445 && sha(s.text)===s.textSha256
    && s.textSha256==="24cff61fe4d974aa93651f03f4c7add9e8bcc5bcbe2220b80d9be38c619df920"
    && s.bodySha256==="17988bd2324fafc61f82b97436898b084540b8c936626d985a763a42add181d1"
    && s.receiptSha256==="e421d0814c751bdd895363783115664bf8c9224a62c3cda8f6b5119f320a99f7"
    && s.originalSourcePin===s.receiptSha256 && s.sourceDate===null && s.sourceDateText===null,
    "broker complete retained terms or dates differ");
}
function brokerIdentityChain(e: BrokerEntry) {
  const b=e.broker,s=e.sources[0];
  need(b.ownSiteRole==="contracting_legal_party_and_explicit_broker_identifiers"
    && b.termsLegalName==="Dorm Room Movers, LLC" && e.legalName==="DORM ROOM MOVERS LLC"
    && sameRegistryLegalName(b.termsLegalName,e.legalName) && b.usdot==="2288433" && b.mc==="746975",
    "broker legal operator or identifier chain differs");
  need(b.contractQuote==='Your registration with Dorm Room Movers, LLC ("DRM") and your purchase of our services is subject to the following Purchase Terms and Conditions ("Purchase Terms")'
    && b.disclosureQuote==="Dorm Room Movers is a broker of household goods moving & storage services. USDOT 2288433, MC-746975. Fla. Broker Reg. No MB154"
    && s.text.split(b.contractQuote).length===2 && s.text.split(b.disclosureQuote).length===2,
    "broker contracting party or disclosure quote differs");
  need(b.registrationAddressRole==="original_fmcsa_only" && b.websiteStreetAddress===null && b.physicalAddressCorroborated===false
    && b.currentAuthorityClaim===false && b.fullNormalizedTextRead===true && b.renderedCompletenessClaim===false
    && b.termsEffectiveDate===null, "broker address, date or authority claim differs");
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
    scope:e.chain==="own_legal_terms_broker_identifiers" ? "Reviewed own-domain contracting legal name and explicit broker identifiers associate the exact FMCSA record only. No website street-address corroboration or current authority is claimed. Registry/CRM address roles and dates remain separate; no canonical mutation, owned fleet, employee, revenue, debt or budget inference." : "Reviewed dated document identity association only. Address roles/dates remain separate; no canonical mutation, current occupancy, debt balance, company revenue, budget or license-wide conclusion is inferred."}};
}
