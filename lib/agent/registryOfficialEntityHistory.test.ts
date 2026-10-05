import { createHash } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import catalog from "./registryOfficialDocumentEntries.json";
import fixture from "../../test/fixtures/registry-official-entity-history.json";
import {parseRegistryFinding,stableRegistryJson} from "./registryProfiles";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex"),now=new Date("2026-10-05T01:30:00Z"),at="2026-10-05T01:00:00Z";
async function setup(index=0){
 const data:any=structuredClone(catalog),company=structuredClone(fixture.company),context:any=structuredClone(fixture.context),entry=data.entries.find((e:any)=>e.id===fixture.entryIds[index]);
 vi.resetModules();vi.doMock("./registryOfficialDocumentEntries.json",()=>({default:data}));
 const m=await import("./registryOfficialDocuments"),row=parseRegistryFinding(structuredClone(fixture.findings[index]),now);
 const proof=()=>{const bare={schema:"official_document_roles_v1" as const,entryId:entry.id,entrySha256:m.registryOfficialDocumentEntry(entry.id).sha256,canonicalIdentitySha256:entry.canonicalIdentitySha256};const evidenceSha256=m.registryOfficialDocumentEvidenceHash(row,bare);return{...bare,reader:{taskId:"test/primary",reviewedAt:at,evidenceSha256},reviewer:{taskId:"test/independent",reviewedAt:at,evidenceSha256}};};
 return{entry,data,company,context,row,proof,check:()=>m.verifyRegistryOfficialDocument(row,proof(),company,context,now)};
}
describe("reviewed official same-entity address history",()=>{
 it.each([0,1,2,3])("validates the exact original target %i without altering it",async index=>{const f=await setup(index),before=stableRegistryJson(f.row),v=f.check();expect(v.method).toBe("reviewed_official_registration_history");expect(stableRegistryJson(f.row)).toBe(before);expect(f.context.addresses).toEqual([]);expect(f.entry.history.identityLink.exactAddressEqualityClaim).toBe(false);expect(f.entry.history.identityLink.reportAddress.addressLine2).toBe("Ste. 317");expect(f.entry.history.identityLink.baseAddress.addressLine2).toBeUndefined();});
 it("leaves all earlier entries and five held targets unchanged",async()=>{const f=await setup();expect(sha(stableRegistryJson(f.data.entries.find((e:any)=>e.id===f.entry.history.baseEntry.id)))).toBe(f.entry.history.baseEntry.sha256);expect(f.data.entries.filter((e:any)=>e.chain!=="official_entity_address_history")).toEqual(catalog.entries.filter(e=>e.chain!=="official_entity_address_history"));for(const key of fixture.heldProfileKeys)expect(f.data.entries.some((e:any)=>e.chain==="official_entity_address_history"&&`registry:${e.target.dataset}:${e.target.recordId}`===key)).toBe(false);});
 it.each(["base_hash","retained_pin","prior_time","original_suite","base_company","base_chain","entity","url_entity","document","source_hash","body_hash","status","complete_read","page_missing","page_hash","visual","source_date","date_role","agent_role","principal_block","target_source","target_suite","target_zip","link_suite","link_zip","equality_claim","current_claim","agent_claim","relocation_claim","source_actor","source_time","original_country","canonical","suffix","raw_row"])("rejects altered %s",async kind=>{
  const f=await setup(1),e=f.entry,s=e.sources[0],h=e.history;
  const base=f.data.entries.find((x:any)=>x.id===h.baseEntry.id);
  if(kind==="base_hash")h.baseEntry.sha256="0".repeat(64);
  if(kind==="retained_pin")s.retainedFileHashes.pop();
  if(kind==="prior_time"){base.sourceReviewer.reviewedAt="2026-10-05T01:00:00Z";h.baseEntry.sha256=sha(stableRegistryJson(base));}
  if(kind==="original_suite"){f.row.profile.identity.addressLine2="Suite 99";e.target.profileSha256=sha(stableRegistryJson(f.row.profile));}
  if(kind==="base_company"){base.companyId="other";h.baseEntry.sha256=sha(stableRegistryJson(base));}
  if(kind==="base_chain"){base.chain="official_entity_address_history";h.baseEntry.sha256=sha(stableRegistryJson(base));}
  if(kind==="entity")h.entityId="20161033966";
  if(kind==="url_entity")s.url=s.url.replace("20161033965","20161033966");
  if(kind==="document")s.documentId="20211248268";
  if(kind==="source_hash")s.text+="changed";
  if(kind==="body_hash")s.bodySha256="0".repeat(64);
  if(kind==="status")s.status=403;
  if(kind==="complete_read")s.completeRead=false;
  if(kind==="page_missing")s.pages.pop();
  if(kind==="page_hash")s.pages[0].textSha256="0".repeat(64);
  if(kind==="visual")s.pages[0].visualSha256="0".repeat(64);
  if(kind==="source_date")s.sourceDate="2021-03-14";
  if(kind==="date_role")s.sourceDateText="10/04/2026 06:32 PM";
  if(kind==="agent_role")e.target.role="registered_agent";
  if(kind==="principal_block")e.sources[1].principalQuote=e.sources[1].principalQuote.replace("principal office","registered agent");
  if(kind==="target_source")h.targetSource=0;
  if(kind==="target_suite")e.targetAddress.addressLine2="Ste. 317";
  if(kind==="target_zip")e.targetAddress.postalCode="80212";
  if(kind==="link_suite")h.identityLink.reportAddress.addressLine2=undefined;
  if(kind==="link_zip")h.identityLink.baseAddress.postalCode="80211-9999";
  if(kind==="equality_claim")h.identityLink.exactAddressEqualityClaim=true;
  if(kind==="current_claim")h.currentOccupancyClaim=true;
  if(kind==="agent_claim")h.agentAsPrincipalClaim=true;
  if(kind==="relocation_claim")h.relocationDateClaim=true;
  if(kind==="source_actor")e.sourceReviewer.taskId=e.sourceReader.taskId;
  if(kind==="source_time")e.sourceReviewer.reviewedAt="2026-09-01T00:00:00Z";
  if(kind==="original_country")e.originalCountry.profileCountryCode="US";
  if(kind==="canonical")f.context.aliases.push("Unrelated LLC");
  if(kind==="suffix"){f.row.profile.identity.legalName="RED SKY Consulting";e.target.profileSha256=sha(stableRegistryJson(f.row.profile));}
  if(kind==="raw_row")f.row.evidence+=" ";
  expect(()=>f.check()).toThrow();
 });
});
