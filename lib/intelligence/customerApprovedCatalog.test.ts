import { describe,it,expect } from "vitest";
import { customerResearchTextHash } from "./customerResearchProfiles";
import { projectCustomerBusinessScopeProof, normalizeCustomerBusinessScopeProof, customerProofHash,
  approvedCustomerCriterionVersion, approvedCustomerCatalogVersion, type CustomerCriterionBinding } from "./customerApprovedCatalog";
const time="2026-09-30T00:00:00Z";
function fixture() {
  const body="We perform monthly reconciliation for clients. 😀";
  const quote="We perform monthly reconciliation for clients.";
  const profile={schema:"customer-research-v1",customerId:"synthetic-1",name:"Synthetic Services",website:"https://example.com/",
    announcementIds:["announcement"],author:{kind:"codex",name:"Codex",authoredAt:time},observedAt:time,completedAt:null,status:"in_progress",
    discovery:{status:"in_progress",methods:[{id:"nav",kind:"navigation",url:"https://example.com/",observedAt:time,outcome:"read",note:"Business scope read; archive remains outside accepted scope."}],
      pages:[{url:"https://example.com/",discoveredBy:["nav"],outcome:"captured",sourceId:"home"},{url:"https://example.com/archive",discoveredBy:["nav"],outcome:"pending"}],notes:[]},
    sources:[{id:"home",url:"https://example.com/",resolvedUrl:"https://example.com/",title:"Services",kind:"company_website",observedAt:time,text:body,textSha256:customerResearchTextHash(body),readAt:time,capture:"full_observed_text"}],
    facts:[{id:"monthly-work",label:"Reconciliation service",kind:"service",value:"Monthly reconciliation",subject:{kind:"customer",name:"Synthetic Services"},state:"supported",explanation:"Provider performs the work; billing cadence remains unestablished.",
      citations:[{sourceId:"home",textSha256:customerResearchTextHash(body),start:0,end:quote.length,quote,role:"supporting"}]}],summary:"Performs reconciliation.",sourceGaps:["Commercial terms undisclosed."]};
  const profileJson=JSON.stringify(profile),profileSha256=customerResearchTextHash(profileJson);
  return {profileJson,profileSha256,validatedAt:time,
    businessScope:{status:"scope_complete_with_gaps" as const,acceptedScope:"Substantive operational and commercial pages; archive excluded.",closedAt:time,
      receipt:{file:"scope.json",sha256:"a".repeat(64)},profileSha256,wholeSiteStatus:"in_progress" as const,wholeSiteDiscoveryStatus:"in_progress" as const},
    mapping:{customerId:profile.customerId,profileSha256,scopeStatus:"scope_complete_with_gaps",ownIndustry:{label:"Accounting services",factIds:["monthly-work"]},
      matches:[{patternId:"continuing-task",factIds:["monthly-work"]}],identityQualification:"Scope limited to the named operating brand.",distinctCompanyKey:"synthetic-1"},bindings:[] as CustomerCriterionBinding[]};
}
function resign<T extends {proofSha256:string}>(input:T):T {const {proofSha256:_old,...body}=input;void _old;return {...input,proofSha256:customerProofHash(body)};}
describe("finite business-scope proof",()=>{
  it("preserves raw pending discovery while admitting a separately closed finite scope",()=>{
    const proof=projectCustomerBusinessScopeProof(fixture());
    expect(proof.status).toBe("in_progress");expect(proof.completedAt).toBeNull();
    expect(proof.coverage.pending).toBe(1);expect(proof.businessScope.status).toBe("scope_complete_with_gaps");
    expect(proof.sources[0]).not.toHaveProperty("text");expect(proof.mapping.identityQualification).toContain("operating brand");
    expect(proof.criterionBindings).toEqual([]); // A field observation is not category membership.
    expect(normalizeCustomerBusinessScopeProof(proof)).toEqual(proof);
  });
  it("requires unchanged full text and exact UTF-16 quoted spans before projection",()=>{
    const input=fixture();const raw=JSON.parse(input.profileJson);raw.sources[0].text+="changed";
    input.profileJson=JSON.stringify(raw);expect(()=>projectCustomerBusinessScopeProof(input)).toThrow("original_profile_hash");
    input.profileSha256=customerResearchTextHash(input.profileJson);expect(()=>projectCustomerBusinessScopeProof(input)).toThrow("source_hash");
  });
  it("rejects changed compact proof and malformed citation spans, even after a fresh compact hash",()=>{
    const proof=projectCustomerBusinessScopeProof(fixture());proof.facts[0].citations[0].end++;
    expect(()=>normalizeCustomerBusinessScopeProof(proof)).toThrow("proof_hash");
    expect(()=>normalizeCustomerBusinessScopeProof(resign(proof))).toThrow("citation");
  });
  it("requires an explicit own-subject positive fact bundle and does not upgrade attribution holds",()=>{
    const input=fixture();const binding:CustomerCriterionBinding={criterionId:"monthly-service",definitionVersion:"semantic-v1",customerId:"synthetic-1",profileSha256:input.profileSha256,
      state:"supported",factIds:["monthly-work"],offeringScope:"Reconciliation service",whyMatches:"Explicit recurring provider work",authoredAt:time,author:"codex",source:"explicit_authored_predicate"};
    input.bindings=[binding];const proof=projectCustomerBusinessScopeProof(input);expect(proof.criterionBindings).toHaveLength(1);
    proof.facts[0].subject.kind="partner";expect(()=>normalizeCustomerBusinessScopeProof(resign(proof))).toThrow("binding_positive");
    proof.facts[0].subject.kind="customer";proof.mapping.matches=[];
    expect(()=>normalizeCustomerBusinessScopeProof(resign(proof))).toThrow("binding_positive");
  });
  it("preserves authored conflicting observations with two supporting quotes but cannot use them as positive membership",()=>{
    const input=fixture(),raw=JSON.parse(input.profileJson);raw.facts[0].state="conflicting";
    raw.facts[0].citations.push({...raw.facts[0].citations[0],start:11,quote:raw.facts[0].citations[0].quote.slice(11)});
    input.profileJson=JSON.stringify(raw);input.profileSha256=customerResearchTextHash(input.profileJson);
    input.businessScope.profileSha256=input.profileSha256;input.mapping.profileSha256=input.profileSha256;
    const proof=projectCustomerBusinessScopeProof(input);expect(proof.facts[0].state).toBe("conflicting");
    proof.criterionBindings.push({criterionId:"test",definitionVersion:"test-v1",customerId:proof.customerId,profileSha256:proof.fullProfileSha256,state:"supported",factIds:["monthly-work"],offeringScope:"Test",whyMatches:"Test",authoredAt:time,author:"codex",source:"explicit_authored_predicate"});
    expect(()=>normalizeCustomerBusinessScopeProof(resign(proof))).toThrow("binding_positive");
  });
});
describe("criterion and immutable snapshot versions",()=>{
  const criterion={id:"synthetic-recurring-work",label:"Recurring work",familyId:"delivery",sourceProposalKey:"synthetic#recurring",originalScope:"universal",
    applicability:{scope:"universal" as const},predicate:"The provider performs specified recurring client work.",evidenceRules:["Affirmative execution evidence."],
    exclusions:["Software enabling clients to work is insufficient."],positiveExamples:[{scenario:"Our staff reconciles each month.",explanation:"Own recurring delivery."}],
    negativeExamples:[{scenario:"Customers reconcile using software.",explanation:"Enabling is not execution."}]};
  it("keeps display/cohort changes out of paid criterion meaning but binds cohort revision in snapshot identity",()=>{
    const definitionVersion=approvedCustomerCriterionVersion(criterion);
    expect(approvedCustomerCriterionVersion({...criterion,label:"New display label"})).toBe(definitionVersion);
    expect(approvedCustomerCriterionVersion({...criterion,predicate:"The provider bills monthly."})).not.toBe(definitionVersion);
    const facets=[{...criterion,definitionVersion}];
    expect(approvedCustomerCatalogVersion({facets,cohortProof:{revision:1}})).not.toBe(approvedCustomerCatalogVersion({facets,cohortProof:{revision:2}}));
  });
});
