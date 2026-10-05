import { describe, it, expect } from "vitest";
import { parseRegistryFinding, registryContentHash, validatePublishedRegistryAnchors, verifyRegistryIdentity, type RegistryAnchorRow, type RegistryAnchorReceipt, type RegistryProfile } from "./registryProfiles";

type Identity = RegistryProfile["identity"];
const company={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",netsuite_internal_id:"123",name:"Different canonical brand"};
const context={aliases:[],addresses:[],context:""};
const now=new Date("2026-10-05T12:00:00Z");
const identity:Identity={legalName:"Example Services LLC",addressLine1:"123 CAMERON ROAD",city:"Austin",state:"TX",postalCode:"78754-1234",countryCode:"US"};
function finding(id:Identity,recordId:string) {
  const sourceRow=JSON.parse(JSON.stringify({...id,drivers:2})),evidence=JSON.stringify(sourceRow);
  return parseRegistryFinding({companyId:company.id,internalId:"123",source:"registry",kind:"ops_profile",sourceUrl:"https://data.transportation.gov/resource/public.json",detail:"Dated observation.",evidence,
    registryProfile:{version:1,dataset:"fmcsa",recordId,sourceAsOf:"2025-07-15",observedAt:"2026-09-01T00:00:00Z",identity:id,facts:[{field:"drivers",value:2}],provenance:{sourceRow,quote:evidence,rowSha256:"a".repeat(64)}}},now);
}
function check(target:Identity,original:Identity=identity) {
  const f=finding(original,"777"),publication={eventId:"test-direct",contentHash:registryContentHash(f.profile,f.sourceUrl,f.detail),publishedAt:"2026-09-02T00:00:00Z"};
  const row:RegistryAnchorRow={id:"test-row",company_id:company.id,netsuite_internal_id:"123",source:"registry",kind:"ops_profile",label:f.label,detail:f.detail,evidence:f.evidence,evidence_url:f.sourceUrl,
    registry_profile:{...f.profile,verification:{method:"official_website_corroboration",verifiedAt:"2026-09-01T00:00:00Z",sourceIds:["test:source"]},publication}};
  const receipt:RegistryAnchorReceipt={id:row.id,companyId:company.id,internalId:"123",profileKey:f.label,...publication,eventVerified:true};
  const p=finding(target,"888").profile,before=JSON.stringify({p,row,receipt});
  const result=verifyRegistryIdentity(p,company,context,[],now,validatePublishedRegistryAnchors([row],[receipt],now));
  expect(JSON.stringify({p,row,receipt})).toBe(before);
  return result;
}
describe("published-anchor terminal ROAD abbreviation",()=>{
  it("compares RD and ROAD symmetrically while preserving all source values",()=>{
    const rd={...identity,addressLine1:"123 CAMERON RD"};
    expect(check(rd)?.method).toBe("verified_published_profile_identity");
    expect(check(identity,rd)?.method).toBe("verified_published_profile_identity");
  });
  it("preserves a complete separate unit and leading direction",()=>{
    const original={...identity,addressLine1:"123 N OLD MILL ROAD",addressLine2:"STE B-1"};
    expect(check({...original,addressLine1:"123 N OLD MILL RD"},original)?.method).toBe("verified_published_profile_identity");
  });
  it("preserves the existing US-compatible absent-country rule",()=>{
    expect(check({...identity,addressLine1:"123 CAMERON RD",countryCode:undefined})?.method).toBe("verified_published_profile_identity");
  });
  it.each([
    ["different street type",{addressLine1:"123 CAMERON ST"}],
    ["missing suffix",{addressLine1:"123 CAMERON"}],
    ["different civic",{addressLine1:"124 CAMERON RD"}],
    ["decimal civic",{addressLine1:"12.3 CAMERON RD"}],
    ["hyphenated civic",{addressLine1:"12-3 CAMERON RD"}],
    ["different name",{addressLine1:"123 CAMERON NORTH RD"}],
    ["missing directional counterpart",{addressLine1:"123 N CAMERON RD"}],
    ["trailing direction",{addressLine1:"123 CAMERON RD N"}],
    ["trailing locality",{addressLine1:"123 CAMERON RD AUSTIN"}],
    ["RD inside token",{addressLine1:"123 CAMERONRD"}],
    ["RD as street name",{addressLine1:"123 RD CAMERON"}],
    ["legal suffix difference",{legalName:"Example Services Inc",addressLine1:"123 CAMERON RD"}],
    ["missing legal suffix",{legalName:"Example Services",addressLine1:"123 CAMERON RD"}],
    ["city",{city:"Round Rock",addressLine1:"123 CAMERON RD"}],
    ["state",{state:"CA",addressLine1:"123 CAMERON RD"}],
    ["ZIP+4 omitted",{postalCode:"78754",addressLine1:"123 CAMERON RD"}],
    ["ZIP+4 changed",{postalCode:"78754-1235",addressLine1:"123 CAMERON RD"}],
    ["country conflict",{countryCode:"CA" as const,postalCode:"K1A 0B1",addressLine1:"123 CAMERON RD"}],
    ["new unit",{addressLine2:"STE 1",addressLine1:"123 CAMERON RD"}],
  ] as const)("rejects %s",(_label,change)=>{expect(check({...identity,...change})).toBeNull();});
  it.each(["ST","STREET","DR","DRIVE","AVE","AVENUE","BLVD","BOULEVARD","LN","LANE"])("does not collapse %s to ROAD",suffix=>{
    expect(check({...identity,addressLine1:`123 CAMERON ${suffix}`})).toBeNull();
  });
  it.each(["STE","SUITE","UNIT","APT","APARTMENT","FLOOR","FL","RM","ROOM","BLDG","BUILDING","#"])("does not reinterpret inline %s RD as a street type",unit=>{
    expect(check({...identity,addressLine1:`123 MAIN ST ${unit} RD`},{...identity,addressLine1:`123 MAIN ST ${unit} ROAD`})).toBeNull();
  });
  it("keeps line2 RD/ROAD, whole unit punctuation and missing units distinct",()=>{
    for(const line2 of ["STE ROAD","STE B1",undefined]) {
      const original={...identity,addressLine2:line2==="STE ROAD"?"STE RD":"STE B.1"};
      expect(check({...identity,addressLine1:"123 CAMERON RD",addressLine2:line2},original)).toBeNull();
    }
  });
  it("does not add Canadian or unnumbered normalization",()=>{
    const canadian={...identity,state:"ON",postalCode:"K1A 0B1",countryCode:"CA" as const};
    expect(check({...canadian,addressLine1:"123 CAMERON RD"},canadian)).toBeNull();
    expect(check({...identity,addressLine1:"CAMERON RD"},{...identity,addressLine1:"CAMERON ROAD"})).toBeNull();
  });
  it("does not extend RD normalization before post-direction or inline suite",()=>{
    for(const tail of ["N","STE B-1"])expect(check({...identity,addressLine1:`123 CAMERON RD ${tail}`},{...identity,addressLine1:`123 CAMERON ROAD ${tail}`})).toBeNull();
  });
});
