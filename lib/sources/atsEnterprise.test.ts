import { describe,it,expect,vi,beforeEach } from "vitest";
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock("@/lib/triggers/urlSafety",()=>({fetchPublicHttpText:mocks.get,postPublicHttpJson:mocks.post}));
import { enterpriseBoardFromHtml,fetchWorkdayBatch,fetchIcimsBatch,parseIcimsPage } from "./atsEnterprise";
import { adpBoardFromHtml,fetchAdpBatch } from "./atsAdp";
import { isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";
const options=()=>({offset:0,maxJobs:150,deadline:Date.now()+12000});
const response=(body:unknown,url="https://careers-example.icims.com/jobs/search")=>({status:200,body:typeof body==="string"?body:JSON.stringify(body),finalUrl:url});
const icims=(page:number,pages:number,ids:number[])=>`<h2 class="iCIMS_SubHeader_Jobs">Search Results Page ${page} of ${pages}</h2>${ids.map(id=>`<a href="/jobs/${id}/engineer/job"><span class="sr-only">Title</span><h3>Engineer ${id}</h3></a>`).join("")}`;
beforeEach(()=>{mocks.get.mockReset();mocks.post.mockReset();});
describe("public Workday/iCIMS/ADP boards",()=>{
  it("detects published board identity and preserves Workday's case-sensitive site name",()=>{
    expect(enterpriseBoardFromHtml('<a href="https://erm.wd3.myworkdayjobs.com/en-US/ERM_Careers">Jobs</a>')).toEqual({type:"workday",token:"erm.wd3|ERM_Careers"});
    expect(enterpriseBoardFromHtml('<a href="https://careers-e2.icims.com/jobs/search?ss=1">Jobs</a>')).toEqual({type:"icims",token:"careers-e2"});
    expect(adpBoardFromHtml('<a href="https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=b2b6bd03-a123-4280-ae92-ba2b34512e8d&amp;ccId=19000101_000001">Jobs</a>')).toEqual({type:"adp",token:"b2b6bd03-a123-4280-ae92-ba2b34512e8d|19000101_000001"});
    expect(adpBoardFromHtml('<a href="https://workforcenow.adp.com/login">HR</a>')).toBeNull();
  });
  it("continues Workday offsets and reads an exact public job body without inventing relative dates",async()=>{
    mocks.post.mockResolvedValue(response({total:22,jobPostings:[{title:"Controller",externalPath:"/job/Denver/Controller_R123",locationsText:"Denver"}]}));
    mocks.get.mockResolvedValue(response({jobPostingInfo:{title:"Controller",jobPostingSiteId:"Careers",jobDescription:"<p>QuickBooks project accounting</p>",externalUrl:"https://example.wd1.myworkdayjobs.com/Careers/job/Denver/Controller_R123",postedOn:"Posted 2 Days Ago"}}));
    const result=await fetchWorkdayBatch("example.wd1|Careers",{...options(),offset:20});
    expect(result).toMatchObject({complete:false,nextOffset:21,expectedTotal:22,descriptionsFetched:1});
    expect(result.jobs[0]).toMatchObject({description:"QuickBooks project accounting",date:null});
    expect(mocks.post.mock.calls[0][1]).toMatchObject({offset:20,searchText:"",appliedFacets:{}});
  });
  it("keeps failed Workday listings unavailable and empty real boards complete",async()=>{
    mocks.post.mockResolvedValueOnce(response({errors:["failed"]})).mockResolvedValueOnce(response({total:0,jobPostings:[]}));
    expect(await fetchWorkdayBatch("example.wd1|Careers",options())).toMatchObject({status:"unavailable",complete:false});
    expect(await fetchWorkdayBatch("example.wd1|Careers",options())).toMatchObject({status:"complete",expectedTotal:0});
    expect(await fetchWorkdayBatch("../unsafe|Careers",options())).toMatchObject({status:"unavailable"});
  });
  it("traverses iCIMS source pages with observed page size and accurate terminal count",async()=>{
    mocks.get.mockResolvedValueOnce(response(icims(1,2,[1,2]))).mockResolvedValueOnce(response(icims(2,2,[3])));
    const batch=await fetchIcimsBatch("careers-example",{...options(),offset:2});
    expect(batch).toMatchObject({complete:true,nextOffset:null,expectedTotal:3});expect(batch.jobs.map(j=>j.id)).toEqual(["3"]);
    expect(mocks.get.mock.calls[1][0]).toContain("pr=1");
    expect(parseIcimsPage(icims(1,2,[1,2]),"careers-example",1)).toBeNull();
    expect(parseIcimsPage("<p>Challenge required</p>","careers-example",0)).toBeNull();
  });
  it("keeps iCIMS detail title and posting identity bound to the listed job",async()=>{
    mocks.get.mockResolvedValueOnce(response('<h2 class="iCIMS_SubHeader_Jobs">Page 1 of 1</h2><a href="/jobs/4/controller/job"><h3>Controller</h3></a>'))
      .mockResolvedValueOnce(response('<script type="application/ld+json">{"@type":"JobPosting","title":"Controller","description":"<p>Manual reconciliation</p>","datePosted":"2026-09-01"}</script>',"https://careers-example.icims.com/jobs/4/controller/job?in_iframe=1"));
    const batch=await fetchIcimsBatch("careers-example",options());expect(batch.descriptionsFetched).toBe(1);expect(batch.jobs[0].description).toBe("Manual reconciliation");
  });
  it("uses one-based ADP startSequence, distinct job URL, and actual detail description",async()=>{
    const row={itemID:"ABC_1",requisitionTitle:"Controller",postDate:"2026-09-01",customFieldGroup:{stringFields:[{nameCode:{codeValue:"ExternalJobID"},stringValue:"123"}]}};
    mocks.get.mockResolvedValueOnce(response({jobRequisitions:[row],meta:{startSequence:21,totalNumber:21}})).mockResolvedValueOnce(response({...row,requisitionDescription:"<p>Multi-entity accounting</p>"}));
    const batch=await fetchAdpBatch("b2b6bd03-a123-4280-ae92-ba2b34512e8d|19000101_000001",{...options(),offset:20});
    expect(new URL(mocks.get.mock.calls[0][0]).searchParams.get("$skip")).toBe("21");
    expect(batch).toMatchObject({complete:true,expectedTotal:21,descriptionsFetched:1});
    expect(isCareerEvidenceUrl(batch.jobs[0].url)).toBe(true);expect(new URL(batch.jobs[0].url).searchParams.get("jobId")).toBe("123");
  });
  it("rejects internal ADP postings or unexpected pagination without publishing empty coverage",async()=>{
    const row={itemID:"ABC",requisitionTitle:"Controller",customFieldGroup:{stringFields:[{nameCode:{codeValue:"ExternalJobID"},stringValue:"123"}],indicatorFields:[{nameCode:{codeValue:"InternalPostingFlag"},indicatorValue:true}]}};
    mocks.get.mockResolvedValue(response({jobRequisitions:[row],meta:{startSequence:1,totalNumber:1}}));
    expect(await fetchAdpBatch("b2b6bd03-a123-4280-ae92-ba2b34512e8d|19000101_000001",options())).toMatchObject({status:"unavailable",complete:false});
  });
});
