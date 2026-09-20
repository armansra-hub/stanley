import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FederalIdentityContext from "@/components/FederalIdentityContext";
import { federalCoverage, type FederalSourceCoverage } from "./federalPresentation";
import { federalCoverageHeadline, federalIdentityDecision, federalPublicSourceUrl, federalSourcePresentation } from "./federalCoveragePresentation";

const source=(status:FederalSourceCoverage["status"],source="federal-discovery"):FederalSourceCoverage=>({source,status,scope:"Saved recipient search",searched_from:"2007-10-01",searched_through:"2026-09-20",last_attempted_at:"2026-09-20T10:00:00Z",last_completed_at:null});

describe("federal source coverage presentation",()=>{
  it("keeps failed, unfinished, unsearched, completed and identity-dependent searches distinct",()=>{
    expect(federalSourcePresentation()).toMatchObject({state:"unsearched",label:"Not searched yet"});
    expect(federalSourcePresentation(source("failed"))).toMatchObject({state:"failed",label:"Query failed"});
    expect(federalSourcePresentation(source("partial"))).toMatchObject({state:"partial",label:"Search unfinished"});
    expect(federalSourcePresentation(source("no_match"))).toMatchObject({state:"no_verified_match",label:"Search complete · no verified match"});
    expect(federalSourcePresentation(source("complete"))).toMatchObject({state:"complete",label:"Search complete"});
    expect(federalSourcePresentation(source("ambiguous"))).toMatchObject({state:"needs_identity"});
    expect(federalSourcePresentation({...source("partial"),detail:{reason:"not_linked"}})).toMatchObject({state:"needs_identity"});
    expect(federalSourcePresentation({...source("partial"),detail:{reason:"candidate_search_continues",collection:"idvs"}})).toMatchObject({state:"partial",reason:"candidate_search_continues",collection:"idvs"});
  });

  it("does not turn a failed or unfinished source into a completed no-match headline",()=>{
    expect(federalCoverageHeadline(federalCoverage([],[],[],false,[source("failed")])).label).toContain("query failure");
    expect(federalCoverageHeadline(federalCoverage([],[],[],false,[source("partial")])).label).toContain("unfinished");
    expect(federalCoverageHeadline(federalCoverage([],[],[],false,[source("no_match")])).label).toBe("Completed search found no verified match");
    expect(federalCoverageHeadline(federalCoverage([{id:"direct"}],[],[{id:"award"}],false,[source("failed")])).label).toBe("Direct federal award history");
  });

  it("shows a failed SAM query alongside prior completion dates without losing known awards",()=>{
    const coverage=federalCoverage([{id:"direct"}],[],[{id:"award"}],false,[{...source("failed","sam-entity"),last_completed_at:"2026-09-18T00:00:00Z"},source("partial","usaspending")]);
    const html=renderToStaticMarkup(React.createElement(FederalIdentityContext,{entities:[],pendingEntities:[],relatedEntities:[],coverage}));
    expect(html).toContain("Direct federal award history");expect(html).toContain("SAM registration search");
    expect(html).toContain("Query failed");expect(html).toContain("Last completed:");expect(html).toContain("Sep 18, 2026");
    expect(html).toContain("Search unfinished");expect(html).toContain("Search dates:");
    expect(html).not.toContain("Search complete · no verified match");
  });

  it("keeps a pending related-company Jev decision separate from established related awards and preserves the original answers",()=>{
    const raw={candidateId:"candidate",outcome:"related_company",relationship:"subsidiary",status:"needs_evidence",supportingSourceIds:["site:1"],
      nativeJev:{answers:{related_company:{type:"noul",noul:.823,confidence:.61}},note:"<script>not executable</script>"},requestFingerprint:"fingerprint",reused:true};
    const candidate={id:"candidate",legal_name:"Example Subsidiary",match_status:"pending",match_evidence:{jevIdentity:raw},source_url:"https://sam.gov/entity/example"};
    expect(federalIdentityDecision(candidate).raw).toBe(raw);
    const html=renderToStaticMarkup(React.createElement(FederalIdentityContext,{entities:[],pendingEntities:[candidate],relatedEntities:[],coverage:federalCoverage([],[candidate],[])}));
    expect(html).toContain("Related-company candidate");expect(html).toContain("binding has not been established");
    expect(html).toContain("Saved Jev identity decision");expect(html).toContain("0.823");expect(html).toContain("0.61");
    expect(html).toContain("&lt;script&gt;");expect(html).not.toContain("<script>");
    expect(html).not.toContain("Stored related-entity awards");expect(html).not.toContain("Direct verified legal entities");
  });

  it("separates a same-company decision awaiting binding from an established direct identity",()=>{
    const raw={outcome:"same_company",status:"needs_evidence",nativeJev:{original:true}};
    expect(federalIdentityDecision({match_status:"pending",match_evidence:{jevIdentity:raw}}).label).toBe("Same-company candidate");
    expect(federalIdentityDecision({match_status:"verified",match_evidence:{jevIdentity:raw}}).label).toBe("Same legal entity · verified");
    expect(federalIdentityDecision({match_status:"pending"}).label).toBe("Candidate awaiting identity evidence");
  });

  it("renders only ordinary public source links",()=>{
    expect(federalPublicSourceUrl("https://sam.gov/entity/example")).toBe("https://sam.gov/entity/example");
    for(const url of ["javascript:alert(1)","data:text/html,source","https://credential@sam.gov/entity/example",null])expect(federalPublicSourceUrl(url)).toBeNull();
  });
});
