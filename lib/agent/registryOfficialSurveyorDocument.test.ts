import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../test/fixtures/registry-surveyor-document.json";
import retainedCatalog from "./registryOfficialDocumentEntries.json";
import { parseRegistryFinding, stableRegistryJson } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
const sha=(s:string)=>createHash("sha256").update(s).digest("hex"),now=new Date("2026-10-02T17:00:00Z");
async function setup(){
 const f=structuredClone(fixture) as typeof fixture & { context: CompanyIdentityContext },entry=f.entry;
 vi.resetModules();vi.doMock("./registryOfficialDocumentEntries.json",()=>({default:{schema:"reviewed_official_document_entries_v1",entries:[entry,{...structuredClone(entry),id:"unselected-test-entry"}]}}));
 const module=await import("./registryOfficialDocuments"),row=parseRegistryFinding(f.finding,now);
 const proof=()=>{const bare={schema:"official_document_roles_v1" as const,entryId:entry.id,entrySha256:module.registryOfficialDocumentEntry(entry.id).sha256,canonicalIdentitySha256:entry.canonicalIdentitySha256},evidenceSha256=module.registryOfficialDocumentEvidenceHash(row,bare);return {...bare,reader:{taskId:"/test/eagle-reader",reviewedAt:now.toISOString(),evidenceSha256},reviewer:{taskId:"/test/eagle-reviewer",reviewedAt:now.toISOString(),evidenceSha256}};};
 const check=(p=proof())=>module.verifyRegistryOfficialDocument(row,p,f.company,f.context,now);
 const rebind=()=>{entry.canonicalIdentitySha256=module.registryOfficialDocumentCanonicalHash(f.company,f.context);};
 return {...f,entry,row,module,proof,check,rebind};
}
type Case=Awaited<ReturnType<typeof setup>>;
describe("finite municipal surveyor firm identifier",()=>{
 it("accepts exact source with synthetic final witnesses and preserves raw addresses/date",async()=>{const f=await setup(),before=JSON.stringify([f.row,f.company,f.context]),r=f.check();expect(r.method).toBe("reviewed_official_registration_history");expect(JSON.stringify([f.row,f.company,f.context])).toBe(before);expect(f.row.profile.sourceAsOf).toBe(null);expect(f.row.profile.identity.addressLine1).toBe("212 W. Sycamore Street");expect(f.context.addresses[0].addressLine1).toBe("1517 Centre Place Dr # 250");expect(f.entry.surveyor.addressEquivalenceClaim).toBe(false);});
 it("keeps every prior catalog entry unchanged",()=>{expect(fixture.oldEntryPins).toHaveLength(15);for(const p of fixture.oldEntryPins){const e=retainedCatalog.entries.find(x=>x.id===p.id);expect(sha(stableRegistryJson(e))).toBe(p.sha256);}});
 const cases:Record<string,(f:Case)=>void>={
  "wrong company":f=>{f.company.id="other";},
  "wrong internal ID":f=>{f.company.netsuite_internal_id="142412477";},
  "wrong canonical domain despite new hash":f=>{f.company.domain="other.example";f.rebind();},
  "wrong legal name despite new hash":f=>{f.company.name="Eagle Engineering LLC";f.rebind();},
  "unrelated alias despite new hash":f=>{f.context.aliases.push("Other LLC");f.rebind();},
  "wrong entry company":f=>{f.entry.companyId="other";},
  "wrong dataset":f=>{f.entry.target.dataset="ca_contractors";},
  "wrong exact firm":f=>{f.entry.surveyor.firmNumber="10194178";},
  "wrong firm label":f=>{f.entry.surveyor.titleblockQuote=f.entry.surveyor.titleblockQuote.replace("TX Firm #","Project #");},
  "owner attribution":f=>{f.entry.surveyor.role="parcel_owner";},
  "current office role":f=>{f.entry.surveyor.contactAddressRole="current_headquarters";},
  "missing contact suite":f=>{f.entry.surveyor.contactQuote=f.entry.surveyor.contactQuote.replace("Suite: 200","");},
  "wrong contact city":f=>{f.entry.surveyor.titleblockQuote=f.entry.surveyor.titleblockQuote.replace("Denton","Dallas");},
  "changed original raw row":f=>{f.row.evidence+=" ";},
  "changed original profile":f=>{f.row.profile.identity.addressLine1="222 South Elm Street Suite200";},
  "fabricated sourceAsOf":f=>{f.row.profile.sourceAsOf="2026-04-20";f.entry.target.sourceAsOf="2026-04-20" as never;f.entry.target.profileSha256=sha(stableRegistryJson(f.row.profile));},
  "changed original fact despite new target hash":f=>{f.row.profile.facts[0].value="10194178";f.entry.target.profileSha256=sha(stableRegistryJson(f.row.profile));},
  "wrong body pin":f=>{f.entry.sources[0].bodySha256="0".repeat(64);},
  "wrong source hash":f=>{f.entry.sources[0].textSha256="0".repeat(64);},
  "changed source with new text hash":f=>{f.entry.sources[0].text+="changed";f.entry.sources[0].textSha256=sha(f.entry.sources[0].text);},
  "wrong municipal source":f=>{f.entry.sources[0].url="https://example.com/plan.pdf";},
  "wrong source kind":f=>{f.entry.sources[0].kind="own_website";},
  "unsuccessful capture":f=>{f.entry.sources[0].status=406;},
  "invented rendered HTTP":f=>{Object.assign(f.entry.sources[0],{status:null});},
  "unread source":f=>{f.entry.sources[0].completeRead=false;},
  "missing page":f=>{f.entry.surveyor.pageCount=2;},
  "missing visual":f=>{f.entry.surveyor.visualSha256="";},
  "wrong extraction receipt":f=>{f.entry.surveyor.extractionReceiptSha256="0".repeat(64);},
  "unread annotations":f=>{f.entry.surveyor.annotations.count=5;},
  "changed annotations with new hash":f=>{f.entry.surveyor.annotations.text+=" ";f.entry.surveyor.annotations.sha256=sha(f.entry.surveyor.annotations.text);},
  "invented source date":f=>{Object.assign(f.entry.sources[0],{sourceDate:"2026-04-17",sourceDateText:"20260417"});},
  "wrong titleblock date":f=>{f.entry.surveyor.titleblockDate="04/17/2026";},
  "filename promoted to preparation":f=>{f.entry.surveyor.preparationDate="04/17/2026";},
  "unified date":f=>{Object.assign(f.entry.surveyor,{unifiedSourceDate:"2026-04-20"});},
  "missing preliminary limit":f=>{f.entry.surveyor.preliminary=false;},
  "signed claim":f=>{f.entry.surveyor.approvalAndCertificationUnsigned=false;},
  "final approval claim":f=>{f.entry.surveyor.finalApprovalClaim=true;},
  "current license claim":f=>{f.entry.surveyor.currentLicenseClaim=true;},
  "current address claim":f=>{f.entry.surveyor.currentAddressClaim=true;},
  "address equivalence":f=>{f.entry.surveyor.addressEquivalenceClaim=true;},
  "financial inference":f=>{f.entry.surveyor.financialInference=true;},
  "complete project claim":f=>{f.entry.surveyor.completeProjectPacketClaim=true;},
  "same source actors":f=>{f.entry.sourceReviewer.taskId=f.entry.sourceReader.taskId;},
  "source chronology":f=>{f.entry.sourceReviewer.reviewedAt="2026-09-01T00:00:00Z";},
  "missing source receipt":f=>{f.entry.sourceReader.receiptSha256="";},
  "same original actors":f=>{f.entry.originalReviews.independent.taskId=f.entry.originalReviews.primary.taskId;},
 };
 for(const [name,mutate]of Object.entries(cases))it("rejects "+name,async()=>{const f=await setup();mutate(f);expect(()=>f.check()).toThrow();});
 it("rejects same final actors",async()=>{const f=await setup(),p=f.proof();p.reviewer.taskId=p.reader.taskId;expect(()=>f.check(p)).toThrow();});
 it("rejects final review before full-source pair",async()=>{const f=await setup(),p=f.proof();p.reader.reviewedAt="2026-10-02T16:00:00Z";expect(()=>f.check(p)).toThrow();});
 it("rejects detail change under old actual-content binding",async()=>{const f=await setup(),p=f.proof();f.row.detail+="changed";expect(()=>f.check(p)).toThrow();});
});
