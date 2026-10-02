import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import catalog from "./registryOfficialDocumentEntries.json";
import fixture from "../../test/fixtures/registry-irs-document.json";
import oldFixtures from "../../test/fixtures/registry-official-documents.json";
import { parseRegistryFinding, stableRegistryJson, registryContentHash } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { RegistryOfficialDocumentEntry } from "./registryOfficialDocuments";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex"),now=new Date("2026-10-02T04:30:00Z"),reviewedAt="2026-10-02T04:20:00Z";
async function setup(){
 const data=structuredClone(catalog),f=structuredClone(fixture),entry=data.entries.find(x=>x.id===f.entryId) as unknown as Extract<RegistryOfficialDocumentEntry,{chain:"official_irs_ein_historical_books_address"}>;
 vi.resetModules();vi.doMock("./registryOfficialDocumentEntries.json",()=>({default:data}));
 const module=await import("./registryOfficialDocuments"),route=await import("./registryOfficialHistory"),context=f.context as CompanyIdentityContext,row=parseRegistryFinding(f.finding,now);
 const proof=()=>{const bare={schema:"official_document_roles_v1" as const,entryId:entry.id,entrySha256:module.registryOfficialDocumentEntry(entry.id).sha256,canonicalIdentitySha256:entry.canonicalIdentitySha256},evidenceSha256=module.registryOfficialDocumentEvidenceHash(row,bare);return{...bare,reader:{taskId:"/test/irs-primary",reviewedAt,evidenceSha256},reviewer:{taskId:"/test/irs-independent",reviewedAt,evidenceSha256}};};
 const check=(p=proof())=>route.verifyRegistryOfficialHistory(row,p,f.company,context,now);
 const rehashSource=(index:number)=>{const s=entry.sources[index];s.textSha256=sha(s.text);s.archive.xmlSha256=s.textSha256;s.archive.memberBytes=Buffer.byteLength(s.text);};
 const rebindCanonical=()=>{entry.canonicalIdentitySha256=module.registryOfficialDocumentCanonicalHash(f.company,context);};
 const rebindTarget=()=>{entry.target.profileSha256=sha(stableRegistryJson(row.profile));entry.target.evidenceSha256=sha(row.evidence);entry.target.rowSha256=row.profile.provenance.rowSha256;};
 return{...f,data,entry,module,route,context,row,proof,check,rehashSource,rebindCanonical,rebindTarget};
}
describe("explicit original IRS EIN and historical books-address document chain",()=>{
 it("accepts the exact role-preserving source with synthetic final witnesses only",async()=>{
  const f=await setup(),before=JSON.stringify({row:f.row,company:f.company,context:f.context}),r=f.check(),entry=r.officialHistory?.entry as typeof f.entry;
  expect(r.method).toBe("reviewed_official_registration_history");expect(entry.historicalRole).toBe("books_in_care_of_address");expect(entry.currentPhysicalAddressClaim).toBe(false);
  expect(entry.assignedDomainConflict.domain).toBe("sb.co");expect(entry.declaredDomain).toBe("springboardse.org");expect(entry.sources.map(x=>x.status)).toEqual([206,200]);
  expect(r.officialHistory?.targetAddress).toMatchObject({role:"exempt_organization",addressLine1:"27762 ANTONIO PKWY L1299"});
  expect(JSON.stringify({row:f.row,company:f.company,context:f.context})).toBe(before);
 });
 it("leaves both previous compiled entries and their hashes unchanged",async()=>{const f=await setup();for(const old of oldFixtures.cases)expect(f.module.registryOfficialDocumentEntry(old.entry.id).sha256).toBe(sha(stableRegistryJson(old.entry)));});
 it.each(["missing_unit","wrong_unit","wrong_city","wrong_state","wrong_zip","wrong_country","wrong_role","wrong_locator","current_claim","target_role"])("rejects altered address-role evidence %s",async kind=>{
  const f=await setup(),e=f.entry;
  if(kind==="missing_unit")e.historicalAddress.addressLine1="555 CORPORATE DR";if(kind==="wrong_unit")e.historicalAddress.addressLine1="555 CORPORATE DR STE 111";
  if(kind==="wrong_city")e.historicalAddress.city="New York";if(kind==="wrong_state")e.historicalAddress.state="NY";if(kind==="wrong_zip")e.historicalAddress.postalCode="926942178";
  if(kind==="wrong_country")Object.assign(e.historicalAddress,{countryCode:"CA"});if(kind==="wrong_role")Object.assign(e,{historicalRole:"filer_mailing_address"});
  if(kind==="wrong_locator")Object.assign(e,{historicalLocator:"Return/ReturnData/IRS990ScheduleR/IdDisregardedEntitiesGrp/USAddress"});
  if(kind==="current_claim")Object.assign(e,{currentPhysicalAddressClaim:true});if(kind==="target_role")Object.assign(e,{targetContinuityRole:"filer_address"});expect(()=>f.check()).toThrow();
 });
 it.each(["missing_unit","wrong_unit","wrong_zip4","wrong_source","duplicated_anchor","absent_anchor"])("requires an exact canonical historical anchor beyond a recomputed context hash: %s",async kind=>{
  const f=await setup(),a=f.context.addresses[0];if(kind==="missing_unit")a.addressLine1="555 Corporate Drive";if(kind==="wrong_unit")a.addressLine1="555 Corporate Drive Suite 111";
  if(kind==="wrong_zip4")a.postalCode="92694-2178";if(kind==="wrong_source")Object.assign(a,{sourceKind:"registry"});if(kind==="duplicated_anchor")f.context.addresses.push({...a});if(kind==="absent_anchor")f.context.addresses=[];
  f.rebindCanonical();expect(()=>f.check()).toThrow();
 });
 it("allows supplied equal ZIP+4 while preserving five-digit canonical comparison",async()=>{const f=await setup();f.context.addresses[0].postalCode="92694-2177";f.rebindCanonical();expect(f.check().method).toBe("reviewed_official_registration_history");});
 it.each(["filer_ein","filer_legal","other_party_only","declared_domain","date","duplicate_filer","duplicate_books","doctype","extra_address_line","wrong_later_unit"])("rejects changed exact XML paths even after test source hashes are recomputed: %s",async kind=>{
  const f=await setup(),s=f.entry.sources[0];
  if(kind==="filer_ein"||kind==="other_party_only")s.text=s.text.replace('<Filer>\r\n      <EIN>812228271</EIN>','<Filer>\r\n      <EIN>384052048</EIN>');
  if(kind==="filer_legal")s.text=s.text.replace('<BusinessNameLine1Txt>SPRINGBOARD SOCIAL ENTERPRISES</BusinessNameLine1Txt>','<BusinessNameLine1Txt>OTHER ENTERPRISES</BusinessNameLine1Txt>');
  if(kind==="declared_domain")s.text=s.text.replace('<WebsiteAddressTxt>www.springboardse.org</WebsiteAddressTxt>','<WebsiteAddressTxt>sb.co</WebsiteAddressTxt>');
  if(kind==="date")s.text=s.text.replace('<TaxYr>2019</TaxYr>','<TaxYr>2020</TaxYr>');
  if(kind==="duplicate_filer")s.text=s.text.replace('</ReturnHeader>','<Filer><EIN>812228271</EIN></Filer></ReturnHeader>');
  if(kind==="duplicate_books")s.text=s.text.replace('</IRS990>','<BooksInCareOfDetail><USAddress>other</USAddress></BooksInCareOfDetail></IRS990>');
  if(kind==="doctype")s.text=s.text.replace('<Return xmlns=','<!DOCTYPE Return [<!ENTITY x "bad">]><Return xmlns=');
  if(kind==="extra_address_line")s.text=s.text.replace('555 CORPORATE DR STE 110</AddressLine1Txt>','555 CORPORATE DR STE 110</AddressLine1Txt><AddressLine2Txt>Floor 7</AddressLine2Txt>');
  if(kind==="wrong_later_unit")f.entry.sources[1].text=f.entry.sources[1].text.replace('27762 ANTONIO PARKWAY L1299','27762 ANTONIO PARKWAY L1298');
  f.rehashSource(0);f.rehashSource(1);expect(()=>f.check()).toThrow();
 });
 it.each(["mirror_url","class","partial_read","range_hash","range_bounds","range_status","whole_archive_claim","date_after_capture","source_hash","source_bytes","extraction_pin"])("preserves original government acquisition provenance: %s",async kind=>{
  const f=await setup(),s=f.entry.sources[0];if(kind==="mirror_url")s.url=s.requestedUrl="https://projects.propublica.org/nonprofits/990.zip";
  if(kind==="class")Object.assign(s,{kind:"official_rendered_record"});if(kind==="partial_read")Object.assign(s,{completeRead:false});
  if(kind==="range_hash")s.archive.range!.sha256="0".repeat(64);if(kind==="range_bounds")s.archive.range!.end=s.archive.range!.total;
  if(kind==="range_status")s.status=200;if(kind==="whole_archive_claim")s.archive.archiveSha256=s.bodySha256;
  if(kind==="date_after_capture")s.sourceDate="2027-12-31";if(kind==="source_hash")s.textSha256="0".repeat(64);if(kind==="source_bytes")s.archive.memberBytes++;if(kind==="extraction_pin")s.archive.extractionReceiptSha256="0".repeat(64);
  expect(()=>f.check()).toThrow();
 });
 it.each(["claim_equivalence","other_ein_missing","same_ein","same_legal","wrong_url","changed_text","changed_quote","lost_conflict"])("keeps assigned sb.co distinct: %s",async kind=>{
  const f=await setup(),e=f.entry,c=e.assignedDomainConflict;
  if(kind==="claim_equivalence"){e.canonicalDomain=f.company.domain=e.declaredDomain;c.domain=e.declaredDomain;f.rebindCanonical();}
  if(kind==="other_ein_missing")c.ein="521234567";if(kind==="same_ein")c.ein=e.ein;if(kind==="same_legal")c.legalName=e.legalName;
  if(kind==="wrong_url")c.url="https://springboardse.org/";if(kind==="changed_text")c.text+="changed";if(kind==="changed_quote")c.identityQuote="Other legal identity";
  if(kind==="lost_conflict")Object.assign(e,{assignedDomainConflict:null});expect(()=>f.check()).toThrow();
 });
 it.each(["wrong_bmf_ein","wrong_bmf_name","wrong_normalized_ein","missing_fact_ein"])("checks original BMF identity beyond recomputed target pins: %s",async kind=>{
  const f=await setup(),parts=f.row.evidence.split("\nOriginal public source row: "),raw=JSON.parse(parts[1]),normalized=JSON.parse(parts[0]);
  if(kind==="wrong_bmf_ein")raw.EIN="522266068";if(kind==="wrong_bmf_name")raw.NAME="OTHER ENTERPRISES";if(kind==="wrong_normalized_ein")normalized.ein="522266068";
  if(kind==="missing_fact_ein")f.row.profile.facts=f.row.profile.facts.filter(x=>x.field!=="ein");
  const rawText=stableRegistryJson(raw);f.row.profile.provenance.sourceRow=normalized;f.row.evidence=stableRegistryJson(normalized)+"\nOriginal public source row: "+rawText;
  f.row.profile.provenance.quote=f.row.evidence;f.row.profile.provenance.rowSha256=sha(rawText);f.rebindTarget();expect(()=>f.check()).toThrow();
 });
 it.each(["same_source_actors","early_source_review","same_final_actors","early_final_review","detail_replay","wrong_company","wrong_entry"])("retains exact final lineage and replay gates: %s",async kind=>{
  const f=await setup(),p=f.proof();if(kind==="same_source_actors")f.entry.sourceReviewer.taskId=f.entry.sourceReader.taskId;
  if(kind==="early_source_review")f.entry.sourceReviewer.reviewedAt="2026-10-02T03:00:00Z";if(kind==="same_final_actors")p.reviewer.taskId=p.reader.taskId;
  if(kind==="early_final_review")p.reviewer.reviewedAt="2026-10-02T03:50:00Z";if(kind==="detail_replay")f.row.detail+=" changed";
  if(kind==="wrong_company")f.company.id="another";if(kind==="wrong_entry")p.entryId="springboard-812228271";
  expect(()=>f.check(kind.endsWith("source_actors")||kind==="early_source_review"?f.proof():p)).toThrow();
 });
 it("does not mutate target content or convert a source review into final witnesses",async()=>{const f=await setup(),before=registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail);f.check();expect(registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail)).toBe(before);expect(f.proof().reader.taskId.startsWith('/test/')).toBe(true);});
});
