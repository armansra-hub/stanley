import { describe, it, expect } from "vitest";
import { parseRegistryFinding, registryContentHash, validatePublishedRegistryAnchors, verifyRegistryIdentity, type RegistryAnchorRow, type RegistryAnchorReceipt, type RegistryProfile } from "./registryProfiles";

const company = {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",netsuite_internal_id:"123",name:"Canonical Brand"};
const context = {aliases:[],addresses:[],context:""};
const now = new Date("2026-10-02T12:00:00Z");
function finding(identity = {legalName:"Example & Sons, Inc.",addressLine1:"123 MAIN ST STE B",city:"Austin",state:"TX",postalCode:"78701-1234"}, recordId="777") {
  const sourceRow={...identity,drivers:2}, evidence=JSON.stringify(sourceRow);
  return parseRegistryFinding({companyId:company.id,internalId:"123",source:"registry",kind:"ops_profile",sourceUrl:"https://data.transportation.gov/resource/public.json",detail:"Dated carrier observation, not current staffing.",evidence,
    registryProfile:{version:1,dataset:"fmcsa",recordId,sourceAsOf:"2025-07-15",observedAt:"2026-09-01T00:00:00Z",identity,facts:[{field:"drivers",value:2}],provenance:{sourceRow,quote:evidence,rowSha256:"a".repeat(64)}}},now);
}
function pair(method: NonNullable<RegistryProfile["verification"]>["method"]="reviewed_official_registration_history") {
  const f=finding(), publication={eventId:"event-original",contentHash:registryContentHash(f.profile,f.sourceUrl,f.detail),publishedAt:"2026-09-02T00:00:00Z"};
  const row: RegistryAnchorRow={id:"row-original",company_id:company.id,netsuite_internal_id:"123",source:"registry",kind:"ops_profile",label:f.label,detail:f.detail,evidence:f.evidence,evidence_url:f.sourceUrl,
    registry_profile:{...f.profile,verification:{method,verifiedAt:"2026-09-01T00:00:00Z",sourceIds:["official:test:actual-binding"]},publication}};
  const receipt: RegistryAnchorReceipt={id:row.id,companyId:row.company_id,internalId:row.netsuite_internal_id,profileKey:row.label,...publication,eventVerified:true};
  return {row,receipt};
}
function check(row: RegistryAnchorRow, receipt: RegistryAnchorReceipt, target=finding(undefined,"888").profile) {
  return verifyRegistryIdentity(target,company,context,[],now,validatePublishedRegistryAnchors([row],[receipt],now));
}
describe("server-validated published profile identity reuse",()=>{
  it("binds original row, company, exact profile, event and recomputed content without changing target facts or dates",()=>{
    const {row,receipt}=pair(), target=finding(undefined,"888").profile, before=JSON.stringify(target);
    const v=check(row,receipt,target)!;
    expect(v.method).toBe("verified_published_profile_identity");
    expect(v.publishedAnchor).toEqual({rowId:row.id,companyId:company.id,internalId:"123",profileKey:row.label,eventId:receipt.eventId,contentHash:receipt.contentHash,method:"reviewed_official_registration_history",sourceAsOf:"2025-07-15"});
    expect(JSON.stringify(target)).toBe(before);expect(v.sourceIds).toContain("official:test:actual-binding");
  });
  it.each(["exact_legal_name_address","exact_registry_dba_address","official_website_corroboration","reviewed_sam_domain_legal_address","reviewed_official_registration_history","reviewed_irs_filing_ein_domain"] as const)("accepts a non-chain strong server method: %s",method=>{const p=pair(method);expect(check(p.row,p.receipt)?.method).toBe("verified_published_profile_identity");});
  it.each(["prior_registry_binding","verified_published_profile_identity"] as const)("rejects chained method %s",method=>{const p=pair(method);expect(check(p.row,p.receipt)).toBeNull();});
  it("rejects a same-profile circular anchor and JSON copies of validated anchors",()=>{
    const {row,receipt}=pair(), anchors=validatePublishedRegistryAnchors([row],[receipt],now);
    expect(verifyRegistryIdentity(finding().profile,company,context,[],now,anchors)).toBeNull();
    expect(verifyRegistryIdentity(finding(undefined,"888").profile,company,context,[],now,JSON.parse(JSON.stringify(anchors)))).toBeNull();
    expect(Object.isFrozen(anchors[0].identity)).toBe(true);expect(Object.isFrozen(anchors[0].binding)).toBe(true);
  });
  it("does not reuse an already published new-method result through the old prior binding fallback",()=>{
    const {row,receipt}=pair(), target=finding(undefined,"888").profile;
    const prior={...target,verification:check(row,receipt,target)!,publication:row.registry_profile.publication};
    expect(verifyRegistryIdentity(target,company,context,[prior],now)).toBeNull();
  });
  it.each([
    ["row company",(r:any)=>{r.company_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";}],
    ["row internal ID",(r:any)=>{r.netsuite_internal_id="124";}],
    ["profile key",(r:any)=>{r.label="registry:fmcsa:wrong";}],
    ["source kind",(r:any)=>{r.kind="trigger";}],
    ["source URL",(r:any)=>{r.evidence_url+="?changed=1";}],
    ["detail",(r:any)=>{r.detail="Changed interpretation";}],
    ["original evidence",(r:any)=>{r.evidence+=" changed";}],
    ["source row hash",(r:any)=>{r.registry_profile.provenance.rowSha256="b".repeat(64);}],
    ["source date",(r:any)=>{r.registry_profile.sourceAsOf="2025-07-16";}],
    ["original source identity",(r:any)=>{r.registry_profile.identity.addressLine1="999 Other St";r.registry_profile.provenance.sourceRow.addressLine1="999 Other St";}],
    ["content hash",(r:any)=>{r.registry_profile.publication.contentHash="b".repeat(64);}],
    ["hidden inherited anchor",(r:any)=>{r.registry_profile.verification.publishedAnchor={};}],
    ["empty source provenance",(r:any)=>{r.registry_profile.verification.sourceIds=[];}],
    ["future publication",(r:any)=>{r.registry_profile.publication.publishedAt="2099-01-01T00:00:00Z";}],
  ] as const)("rejects mutated %s",(_label,mutate)=>{const {row,receipt}=pair();mutate(row);expect(check(row,receipt)).toBeNull();});
  it.each([
    ["unverified event",(r:any)=>{r.eventVerified=false;}], ["event ID",(r:any)=>{r.eventId="wrong";}],
    ["event hash",(r:any)=>{r.contentHash="b".repeat(64);}], ["receipt row",(r:any)=>{r.id="wrong";}],
    ["receipt company",(r:any)=>{r.companyId="wrong";}], ["receipt internal ID",(r:any)=>{r.internalId="wrong";}],
    ["receipt key",(r:any)=>{r.profileKey="wrong";}], ["receipt time",(r:any)=>{r.publishedAt="2026-09-03T00:00:00Z";}],
  ] as const)("rejects %s",(_label,mutate)=>{const {row,receipt}=pair();mutate(receipt);expect(check(row,receipt)).toBeNull();});
  it("requires exactly one row and one event receipt, not missing or duplicate evidence",()=>{
    const {row,receipt}=pair();expect(validatePublishedRegistryAnchors([row],[],now)).toEqual([]);
    expect(validatePublishedRegistryAnchors([row],[receipt,receipt],now)).toEqual([]);
    expect(validatePublishedRegistryAnchors([row,row],[receipt],now)).toEqual([]);
  });
  it("requires both canonical company IDs even after receipt validation",()=>{
    const {row,receipt}=pair(),a=validatePublishedRegistryAnchors([row],[receipt],now),p=finding(undefined,"888").profile;
    for(const c of [{name:company.name},{...company,id:"other"},{...company,netsuite_internal_id:"other"}])expect(verifyRegistryIdentity(p,c,context,[],now,a)).toBeNull();
  });
  it.each([
    ["legal suffix",{legalName:"Example & Sons LLC"}], ["missing legal suffix",{legalName:"Example & Sons"}],
    ["substantive name",{legalName:"Example and Sons, Inc."}], ["unit",{addressLine1:"123 MAIN ST STE C"}],
    ["missing unit",{addressLine1:"123 MAIN ST"}], ["street word",{addressLine1:"123 MAIN RD STE B"}],
    ["city",{city:"Boston"}], ["state",{state:"CA"}], ["ZIP",{postalCode:"78702-1234"}],
    ["ZIP truncation",{postalCode:"78701"}], ["known country",{countryCode:"CA"}], ["missing city",{city:undefined}],
    ["apostrophe",{legalName:"Example's & Sons, Inc."}], ["compound unit",{addressLine1:"123 MAIN ST STE B-1"}],
    ["decimal street number",{addressLine1:"12.3 MAIN ST STE B"}],
    ["terminal unit punctuation",{addressLine1:"123 MAIN ST STE B."}],
  ] as const)("rejects target %s conflict",(_label,change)=>{const {row,receipt}=pair(),p=finding(undefined,"888").profile;Object.assign(p.identity,change);expect(check(row,receipt,p)).toBeNull();});
  it("allows only complete punctuation/case/spacing and ZIP+4 formatting, preserving country absence",()=>{
    const {row,receipt}=pair(),p=finding(undefined,"888").profile;
    p.identity={legalName:"EXAMPLE & SONS INC",addressLine1:"123 MAIN ST",addressLine2:"STE B",city:"AUSTIN",state:"TX",postalCode:"787011234",countryCode:"US"};
    expect(check(row,receipt,p)?.method).toBe("verified_published_profile_identity");
    expect(row.registry_profile.identity.countryCode).toBeUndefined();
  });
  it("preserves existing direct matching without anchor evidence",()=>{
    const p=finding().profile,c={...company,name:p.identity.legalName},ctx={aliases:[],addresses:[{...p.identity,sourceId:"crm:exact",sourceKind:"netsuite_record" as const,capturedAt:"2026-09-01T00:00:00Z"}],context:""};
    expect(verifyRegistryIdentity(p,c,ctx,[],now)).toEqual({method:"exact_legal_name_address",verifiedAt:now.toISOString(),sourceIds:["crm:exact"]});
  });
  it("does not collapse punctuation within an opaque unit",()=>{
    const {row,receipt}=pair();
    row.registry_profile.identity.addressLine1="123 MAIN ST STE B1";
    row.registry_profile.provenance.sourceRow.addressLine1="123 MAIN ST STE B1";
    row.evidence=JSON.stringify(row.registry_profile.provenance.sourceRow);row.registry_profile.provenance.quote=row.evidence;
    row.registry_profile.publication!.contentHash=registryContentHash(row.registry_profile,row.evidence_url,row.detail);receipt.contentHash=row.registry_profile.publication!.contentHash;
    const p=finding(undefined,"888").profile;p.identity.addressLine1="123 MAIN ST STE B.1";
    expect(check(row,receipt,p)).toBeNull();
  });
});
