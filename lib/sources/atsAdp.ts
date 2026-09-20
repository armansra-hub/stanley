import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { decodeEntities, htmlToVisibleText } from "./siteDiscovery";
import type { AtsJob, AtsJobBatch } from "./ats";
export function adpBoard(token: string) {
  const match=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\|([a-z0-9_-]{1,80})$/i.exec(token);
  if(!match) return null;
  const params=new URLSearchParams({cid:match[1],ccId:match[2],lang:"en_US",locale:"en_US"});
  return {url:`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?${params}`,api:"https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions",params};
}
export function adpBoardFromHtml(html: string): {type:"adp";token:string}|null {
  for(const match of html.matchAll(/https?:\/\/workforcenow\.adp\.com\/mascsr\/default\/mdf\/recruitment\/recruitment\.html\?[^\s"'<>]+/gi)) {
    try {const u=new URL(decodeEntities(match[0]));const token=`${u.searchParams.get("cid")}|${u.searchParams.get("ccId")}`;if(adpBoard(token)) return{type:"adp",token};}catch{ /* Requires published board IDs, not a guessed employer slug. */ }
  }return null;
}
type AdpRow={itemID?:string;requisitionTitle?:string;requisitionDescription?:string;postDate?:string;customFieldGroup?:{stringFields?:{stringValue?:string;nameCode?:{codeValue?:string}}[];indicatorFields?:{indicatorValue?:boolean;nameCode?:{codeValue?:string}}[]};requisitionLocations?:{nameCode?:{shortName?:string}}[]};
export async function fetchAdpBatch(token:string,options:{offset:number;maxJobs:number;deadline:number}):Promise<AtsJobBatch>{
  const unavailable:AtsJobBatch={jobs:[],nextOffset:options.offset,complete:false,status:"unavailable",coverageKind:"public_hosted_board"};
  const board=adpBoard(token);if(!board || options.deadline-Date.now()<300)return unavailable;
  try{
    const params=new URLSearchParams(board.params);params.set("$top",String(Math.min(20,options.maxJobs)));
    // ADP public career-center startSequence is one-based (0 returns 19 of a 20-row page).
    params.set("$skip",String(options.offset+1));
    const response=await fetchPublicHttpText(`${board.api}?${params}`,{timeoutMs:Math.min(5000,options.deadline-Date.now()),maxBytes:1500000,accept:"application/json"});
    if(response.status!==200)return unavailable;
    const payload=JSON.parse(response.body) as {jobRequisitions?:AdpRow[];meta?:{totalNumber?:number;startSequence?:number}};
    const total=payload.meta?.totalNumber;
    if(!Number.isSafeInteger(total)||total!<0||payload.meta?.startSequence!==options.offset+1||!Array.isArray(payload.jobRequisitions)||payload.jobRequisitions.length>options.maxJobs||payload.jobRequisitions.length>20)return unavailable;
    const jobs:AtsJob[]=[];
    for(const row of payload.jobRequisitions){
      const externalId=row.customFieldGroup?.stringFields?.find(f=>f.nameCode?.codeValue==="ExternalJobID")?.stringValue;
      if(!/^[a-z0-9_-]{1,100}$/i.test(externalId??"")||typeof row.itemID!=="string"||!row.requisitionTitle?.trim())return unavailable;
      // This endpoint should expose external roles only; reject a malformed/private feed instead of leaking it.
      if(row.customFieldGroup?.indicatorFields?.some(f=>f.nameCode?.codeValue==="InternalPostingFlag"&&f.indicatorValue===true))return unavailable;
      const url=new URL(board.url);url.searchParams.set("jobId",externalId!);
      jobs.push({id:row.itemID,title:row.requisitionTitle.slice(0,300),url:url.toString(),description:"",location:(row.requisitionLocations??[]).map(l=>l.nameCode?.shortName).filter(Boolean).join("; ").slice(0,1000),date:typeof row.postDate==="string"&&Number.isFinite(Date.parse(row.postDate))?new Date(row.postDate).toISOString():null});
    }
    if(!jobs.length&&options.offset<total!)return unavailable;
    let descriptionsFetched=0,descriptionsUnavailable=0;
    const selected=jobs.filter(job=>/finance|account|controller|cfo|billing|systems|operations|payroll|revenue|project/i.test(job.title)).slice(0,6);
    for(let i=0;i<selected.length&&options.deadline-Date.now()>=300;i+=3)await Promise.all(selected.slice(i,i+3).map(async job=>{
      try{const id=new URL(job.url).searchParams.get("jobId");const r=await fetchPublicHttpText(`${board.api}/${id}?${board.params}`,{timeoutMs:Math.min(3500,options.deadline-Date.now()),maxBytes:1000000,accept:"application/json"});
        const row=r.status===200?JSON.parse(r.body) as AdpRow:null;
        if(!row||row.itemID!==job.id||row.requisitionTitle!==job.title||typeof row.requisitionDescription!=="string")throw new Error();
        job.description=htmlToVisibleText(row.requisitionDescription).slice(0,40000);descriptionsFetched++;
      }catch{descriptionsUnavailable++;}
    }));
    const offset=options.offset+jobs.length,complete=offset>=total!;
    return{jobs,nextOffset:complete?null:offset,complete,status:complete?"complete":"partial",expectedTotal:total,coverageKind:"public_hosted_board",descriptionsFetched,descriptionsUnavailable};
  }catch{return unavailable;}
}
