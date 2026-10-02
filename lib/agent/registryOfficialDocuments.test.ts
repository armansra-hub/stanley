import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/registry-official-documents.json";
import { parseRegistryFinding, registryContentHash, stableRegistryJson } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { RegistryOfficialDocumentEntry } from "./registryOfficialDocuments";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const now=new Date("2026-10-02T04:00:00Z"),reviewedAt="2026-10-02T03:50:00Z";
async function setup(index=0){
 const all=structuredClone(fixture.cases),f=all[index],entry=f.entry as unknown as RegistryOfficialDocumentEntry,context=f.context as CompanyIdentityContext;
 vi.resetModules();vi.doMock("./registryOfficialDocumentEntries.json",()=>({default:{schema:"reviewed_official_document_entries_v1",entries:all.map(x=>x.entry)}}));
 const module=await import("./registryOfficialDocuments"),route=await import("./registryOfficialHistory");
 const row=parseRegistryFinding(f.finding,now);
 const proof=()=>{const bare={schema:"official_document_roles_v1" as const,entryId:entry.id,entrySha256:module.registryOfficialDocumentEntry(entry.id).sha256,canonicalIdentitySha256:entry.canonicalIdentitySha256};const evidenceSha256=module.registryOfficialDocumentEvidenceHash(row,bare);return {...bare,reader:{taskId:"/test/document-primary",reviewedAt,evidenceSha256},reviewer:{taskId:"/test/document-independent",reviewedAt,evidenceSha256}};};
 const check=(p=proof())=>route.verifyRegistryOfficialHistory(row,p,f.company,context,now);
 return {...f,all,entry,context,row,module,route,proof,check};
}
describe("opt-in compiled official document role proofs",()=>{
 it.each([0,1])("accepts retained two-reader source fixture %i with explicitly synthetic final witnesses",async index=>{
  const f=await setup(index),before=JSON.stringify(f.row),content=registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail),r=f.check();
  expect(r.method).toBe("reviewed_official_registration_history");expect(r.officialHistory?.targetAddress).toMatchObject({role:index?"borrower_business":"debtor_business",...f.row.profile.identity});
  expect(r.officialHistory?.canonicalAddresses).toEqual(f.context.addresses);expect(r.officialHistory?.scope).toContain("no canonical mutation");
  expect(JSON.stringify(f.row)).toBe(before);expect(registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail)).toBe(content);
  const {reader,reviewer,...bare}=f.proof();expect(f.route.registryOfficialHistoryEvidenceHash(f.row,bare)).toBe(reader.evidenceSha256);
 });
 it.each(["companyId","internalId","sourceUrl","evidence","detail"])("rejects changed final %s with old witnesses",async key=>{const f=await setup(),p=f.proof();(f.row as unknown as Record<string,unknown>)[key]+="changed";expect(()=>f.check(p)).toThrow();});
 it.each(["recordId","rowSha256","sourceAsOf","observedAt","fact","city","unit","raw"])("rejects changed original %s even with fresh test witnesses",async kind=>{
  const f=await setup();if(kind==="rowSha256")f.row.profile.provenance.rowSha256="0".repeat(64);else if(kind==="fact")f.row.profile.facts[0].value="wrong";
  else if(kind==="city")f.row.profile.identity.city="Dallas";else if(kind==="unit")f.row.profile.identity.addressLine1="1300 E Lookout Dr Ste 305";
  else if(kind==="raw")f.row.profile.provenance.sourceRow.legalName="Another LLC";else (f.row.profile as unknown as Record<string,unknown>)[kind]="changed";
  expect(()=>f.check()).toThrow();
 });
 it.each(["reader_actor","source_chronology","source_pin","original_actor","original_chronology","original_pin","source_text","source_hash","source_class","source_url","status","source_date"])("rejects corrupt source provenance %s",async kind=>{
  const f=await setup(1),e=f.entry;
  if(kind==="reader_actor")e.sourceReviewer.taskId=e.sourceReader.taskId;
  if(kind==="source_chronology")e.sourceReviewer.reviewedAt="2026-09-01T00:00:00Z";
  if(kind==="source_pin")e.sourceReader.receiptSha256="missing";
  if(kind==="original_actor")e.originalReviews.independent.taskId=e.originalReviews.primary.taskId;
  if(kind==="original_chronology")e.originalReviews.primary.reviewedAt="2026-09-01T00:00:00Z";
  if(kind==="original_pin")e.originalReviews.packetSha256="missing";
  if(kind==="source_text")e.sources[0].text+="substantive changed text";
  if(kind==="source_hash")e.sources[0].textSha256="0".repeat(64);
  if(kind==="source_class")e.sources[0].kind="municipal_pdf";
  if(kind==="source_url")e.sources[0].url="https://evil.test/record";
  if(kind==="status")e.sources[0].status=200;
  if(kind==="source_date")e.sources[0].sourceDate="2027-01-01";
  expect(()=>f.check()).toThrow();
 });
 it.each(["recipient_role","wrong_page","signature","domain","address_city","address_unit","missing_unit","phone"])("rejects NewGen identity/role corruption %s",async kind=>{
  const f=await setup();if(f.entry.chain!=="dated_author_address")throw Error("fixture");const e=f.entry;
  if(kind==="recipient_role")Object.assign(e,{authorRole:"report_recipient"});if(kind==="wrong_page")e.identityPage.page=3;
  if(kind==="signature")e.signature="Very truly yours, City of Murphy";if(kind==="domain")e.domainLiteral="www.other.test";
  if(kind==="address_city")e.targetAddress.city="Murphy";if(kind==="address_unit")e.targetAddress.addressLine2="Suite 305";
  if(kind==="missing_unit")delete e.targetAddress.addressLine2;if(kind==="phone")e.phone="9722322234";
  expect(()=>f.check()).toThrow();
 });
 it.each(["missing_hops","wrong_origin","wrong_end","unrelated_host","unsuccessful_end","rendered_http_claim","source_actor_field"])("rejects corrupt retained capture/role metadata %s",async kind=>{
  const f=await setup(1),e=f.entry,s=e.sources[1];
  if(kind==="missing_hops")s.hops=null;if(kind==="wrong_origin")s.requestedUrl="http://launch-pm.com/changed";
  if(kind==="wrong_end")s.hops![1].url="https://launch-pm.com/other";if(kind==="unrelated_host")s.hops!.unshift({url:"http://evil.test/",status:301});
  if(kind==="unsuccessful_end")s.hops![1].status=404;if(kind==="rendered_http_claim")e.sources[0].requestedUrl=e.sources[0].url;
  if(kind==="source_actor_field")e.sourceReader.receiptActorField="inventedActor";expect(()=>f.check()).toThrow();
 });
 it.each(["regulator_street","wrong_role","wrong_dba","wrong_roc","missing_roc","official_city","site_city","site_unit","missing_site_unit","wrong_status"])("rejects EJS source/role corruption %s",async kind=>{
  const f=await setup(1);if(f.entry.chain!=="official_dba_own_site_address")throw Error("fixture");const e=f.entry;
  if(kind==="regulator_street")Object.assign(e.targetAddress,{addressLine1:"1700 W. Washington St.",addressLine2:"Suite 105",city:"Phoenix",postalCode:"85007-2812"});
  if(kind==="wrong_role")Object.assign(e,{ownSiteRole:"regulator_address"});if(kind==="wrong_dba")e.dba="AnotherPM";
  if(kind==="wrong_roc")e.identifier.value="999999";if(kind==="missing_roc")e.ownSiteContactQuote=e.ownSiteContactQuote.replace("ROC 329136 B-1","");
  if(kind==="official_city")e.locality.city="Phoenix";if(kind==="site_city")e.targetAddress.city="Phoenix";if(kind==="site_unit")e.targetAddress.addressLine2="Suite 1061";
  if(kind==="missing_site_unit")delete e.targetAddress.addressLine2;if(kind==="wrong_status")e.sourceStatus="Active";
  expect(()=>f.check()).toThrow();
 });
 it.each(["same_actor","early","future","stale","hash","unknown_field","wrong_entry","springboard"])("rejects invalid final proof %s",async kind=>{
  const f=await setup(),p=f.proof();if(kind==="same_actor")p.reviewer.taskId=p.reader.taskId;if(kind==="early")p.reviewer.reviewedAt="2026-10-02T01:00:00Z";
  if(kind==="future")p.reviewer.reviewedAt="2026-10-03T00:00:00Z";if(kind==="stale")p.reviewer.reviewedAt="2026-09-01T00:00:00Z";
  if(kind==="hash")p.reviewer.evidenceSha256="0".repeat(64);if(kind==="unknown_field")Object.assign(p,{address:f.entry.targetAddress});
  if(kind==="wrong_entry")p.entryId=fixture.cases[1].entry.id;if(kind==="springboard")p.entryId="springboard-812228271";
  expect(()=>f.check(p)).toThrow();
 });
 it.each(["domain","name","id","alias","address","source_id","capture_date"])("binds complete current canonical identity %s",async kind=>{
  const f=await setup();if(kind==="domain")f.company.domain="other.test";if(kind==="name")f.company.name="Other LLC";if(kind==="id")f.company.id=fixture.cases[1].company.id;
  if(kind==="alias")f.context.aliases.push("Other LLC");if(kind==="address")f.context.addresses[0].addressLine1="other";
  if(kind==="source_id")f.context.addresses[0].sourceId="other";if(kind==="capture_date")f.context.addresses[0].capturedAt="2026-10-02T05:00:00Z";
  expect(()=>f.check()).toThrow();
 });
 it("preserves serialization-aware omitted optional canonical values",async()=>{const f=await setup();Object.assign(f.context.addresses[0],{addressLine2:undefined});expect(f.check().method).toBe("reviewed_official_registration_history");});
 it("returns independent entry copies and excludes Springboard/held sibling scope",async()=>{const f=await setup();f.module.registryOfficialDocumentEntry(f.entry.id).entry.targetAddress.city="bad";expect(f.module.registryOfficialDocumentEntry(f.entry.id).entry.targetAddress.city).toBe("Richardson");expect(()=>f.module.registryOfficialDocumentEntry("registry:co_ucc:1691307:1339635")).toThrow();expect(()=>f.module.registryOfficialDocumentEntry("812228271")).toThrow();});
 it("does not reinterpret browser capture, source status or raw SBA legal structure",async()=>{const f=await setup(1),r=f.check(),e=r.officialHistory?.entry as RegistryOfficialDocumentEntry;expect(e.sources[0].status).toBeNull();expect(e.sources[0].bodySha256).toBeNull();expect(e.limitations.join(" ")).toContain("CORPORATION");expect(f.row.profile.provenance.sourceRow.legal_structure).toBe("CORPORATION");});
 it("legacy history/API hash function is byte-compatible for an old proof shape",async()=>{const f=await setup();const bare={schema:"colorado_sos_history_v1" as const,bundleId:"old",bundleSha256:"a".repeat(64),canonicalIdentitySha256:"b".repeat(64),addressEntryKey:"university_mailing_2006" as const};const before=sha(stableRegistryJson({companyId:f.row.companyId,internalId:f.row.internalId,contentHash:registryContentHash(f.row.profile,f.row.sourceUrl,f.row.detail),evidenceSha256:sha(f.row.evidence),observedAt:f.row.profile.observedAt,proof:bare}));expect(f.route.registryOfficialHistoryEvidenceHash(f.row,bare)).toBe(before);});
});
