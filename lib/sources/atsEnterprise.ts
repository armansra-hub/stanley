import { createHash } from "node:crypto";
import { fetchPublicHttpText, postPublicHttpJson } from "@/lib/triggers/urlSafety";
import { htmlAttributes, htmlToVisibleText } from "./siteDiscovery";
import { hostedJobDetail } from "./atsHosted";
import type { AtsJob, AtsJobBatch } from "./ats";

export function workdayBoard(token: string) {
  const match = /^([a-z0-9][a-z0-9-]{0,60})\.(wd\d{1,2})\|([a-z0-9][a-z0-9_-]{0,100})$/i.exec(token);
  if (!match) return null;
  const origin = `https://${match[1].toLowerCase()}.${match[2].toLowerCase()}.myworkdayjobs.com`;
  return { origin, site: match[3], url: `${origin}/${match[3]}`, api: `${origin}/wday/cxs/${match[1].toLowerCase()}/${match[3]}` };
}
export function enterpriseBoardFromHtml(html: string): { type: "workday" | "icims"; token: string } | null {
  const workday = /https?:\/\/([a-z0-9][a-z0-9-]*)\.(wd\d{1,2})\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([a-z0-9][a-z0-9_-]*)/i.exec(html);
  if (workday) return { type: "workday", token: `${workday[1].toLowerCase()}.${workday[2].toLowerCase()}|${workday[3]}` };
  const icims = /https?:\/\/([a-z0-9][a-z0-9-]*)\.icims\.com\/(?:jobs|careers)(?:[/?"'])/i.exec(html);
  if (icims && !["www", "developer", "community"].includes(icims[1])) return { type: "icims", token: icims[1].toLowerCase() };
  return null;
}
const relevant = (job: AtsJob) => /finance|account|controller|cfo|billing|systems|operations|payroll|revenue|project/i.test(job.title);
const unavailable = (offset: number): AtsJobBatch => ({ jobs: [], nextOffset: offset, complete: false, status: "unavailable", coverageKind: "public_hosted_board" });
export async function fetchWorkdayBatch(token: string, options: { offset: number; maxJobs: number; deadline: number }): Promise<AtsJobBatch> {
  const board = workdayBoard(token); if (!board || options.deadline - Date.now() < 300) return unavailable(options.offset);
  try {
    const limit = Math.min(20, options.maxJobs);
    const response = await postPublicHttpJson(`${board.api}/jobs`, { appliedFacets: {}, limit, offset: options.offset, searchText: "" }, { timeoutMs: Math.min(5000, options.deadline - Date.now()), maxBytes: 1500000 });
    if (response.status !== 200) return unavailable(options.offset);
    const payload = JSON.parse(response.body) as { total?: number; jobPostings?: { title?: string; externalPath?: string; locationsText?: string }[] };
    if (!Number.isSafeInteger(payload.total) || payload.total! < 0 || !Array.isArray(payload.jobPostings) || payload.jobPostings.length > limit) return unavailable(options.offset);
    const jobs: AtsJob[] = [];
    for (const item of payload.jobPostings) {
      if (typeof item.title !== "string" || !item.title.trim() || !/^\/job\/[^?#\\]+$/.test(item.externalPath ?? "") || item.externalPath!.includes("..")) return unavailable(options.offset);
      jobs.push({ id: item.externalPath, title: item.title.slice(0,300), url: `${board.url}${item.externalPath}`, location: String(item.locationsText ?? "").slice(0,1000), description: "", date: null });
    }
    if (!jobs.length && options.offset < payload.total!) return unavailable(options.offset);
    let descriptionsFetched = 0, descriptionsUnavailable = 0;
    const selected = jobs.filter(relevant).slice(0, 6);
    for (let i = 0; i < selected.length && options.deadline - Date.now() >= 300; i += 3) await Promise.all(selected.slice(i,i+3).map(async job => {
      try {
        const detail = await fetchPublicHttpText(`${board.api}${job.id}`, { timeoutMs: Math.min(3500, options.deadline-Date.now()), maxBytes: 1000000 });
        const info = detail.status === 200 ? JSON.parse(detail.body).jobPostingInfo : null;
        if (!info || info.title !== job.title || typeof info.jobDescription !== "string" || info.jobPostingSiteId !== board.site || new URL(info.externalUrl).pathname !== new URL(job.url).pathname) throw new Error();
        job.description = htmlToVisibleText(info.jobDescription).slice(0,40000);
        job.location = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])].filter(value=>typeof value === "string").join("; ").slice(0,1000);
        // postedOn is relative display text; only the source's absolute startDate is a date.
        job.date = typeof info.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(info.startDate) && Number.isFinite(Date.parse(info.startDate)) ? new Date(info.startDate).toISOString() : null;
        descriptionsFetched++;
      } catch { descriptionsUnavailable++; }
    }));
    const offset = options.offset + jobs.length, complete = offset >= payload.total!;
    return { jobs, nextOffset: complete ? null : offset, complete, status: complete ? "complete" : "partial", expectedTotal: payload.total, coverageKind: "public_hosted_board", descriptionsFetched, descriptionsUnavailable };
  } catch { return unavailable(options.offset); }
}

export function parseIcimsPage(html: string, token: string, page: number) {
  const base = `https://${token}.icims.com`, jobs = new Map<string,AtsJob>();
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    try {
      const href=htmlAttributes(anchor[1]).href; if(!href) continue;
      const url = new URL(href,base), id = /^\/jobs\/(\d+)\/[^/]+\/job\/?$/.exec(url.pathname)?.[1];
      if (url.origin !== base || !id) continue;
      const heading = anchor[2].match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i)?.[1];
      const title = htmlToVisibleText(heading || anchor[2].replace(/<span\b[^>]*class=["'][^"']*sr-only[^"']*["'][^>]*>[\s\S]*?<\/span>/gi," ")).replace(/\s+/g," ").trim();
      if (!title || /^(?:apply|view|share)\b/i.test(title)) continue;
      url.search = ""; jobs.set(id,{id,title:title.slice(0,300),url:url.toString(),description:"",location:"",date:null});
    } catch { /* Unrelated links are not postings. */ }
  }
  const text = htmlToVisibleText(html.match(/<h\d\b[^>]*class=["'][^"']*iCIMS_SubHeader_Jobs[^"']*["'][^>]*>([\s\S]*?)<\/h\d>/i)?.[1] ?? "").replace(/\s+/g," ");
  const paging = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(text);
  const genuineEmpty = /no (?:current |open |available )?(?:jobs|positions|job openings)|no results (?:were )?found/i.test(htmlToVisibleText(html)) && /iCIMS/i.test(html);
  if (!paging && !(genuineEmpty && !jobs.size) || paging && (Number(paging[1]) !== page+1 || Number(paging[2]) < page+1 || Number(paging[2]) > 10000)) return null;
  return { jobs:[...jobs.values()], pages: paging ? Number(paging[2]) : 1, complete: !paging || Number(paging[1]) === Number(paging[2]) };
}
export async function fetchIcimsBatch(token: string, options: { offset: number; maxJobs: number; deadline: number }): Promise<AtsJobBatch> {
  if (!/^[a-z0-9][a-z0-9-]{1,100}$/.test(token) || options.deadline-Date.now()<300) return unavailable(options.offset);
  try {
    const base = `https://${token}.icims.com`;
    const readPage = async (page: number) => {
      if(options.deadline-Date.now()<300) return null;
      const response = await fetchPublicHttpText(`${base}/jobs/search?ss=1&in_iframe=1&pr=${page}`, { timeoutMs:Math.min(5000,options.deadline-Date.now()),maxBytes:2000000 });
      return response.status === 200 && new URL(response.finalUrl).origin === base ? parseIcimsPage(response.body,token,page) : null;
    };
    // Read first-page size rather than assuming every employer uses 20 rows.
    const first = await readPage(0);
    if(!first || options.offset>0 && (!first.jobs.length || options.offset % first.jobs.length !== 0)) return unavailable(options.offset);
    const page = options.offset === 0 ? 0 : options.offset / first.jobs.length;
    const parsed = page === 0 ? first : await readPage(page);
    if (!parsed || parsed.pages !== first.pages || parsed.jobs.length > options.maxJobs || !parsed.jobs.length && !parsed.complete) return unavailable(options.offset);
    let descriptionsFetched=0, descriptionsUnavailable=0;
    const selected=parsed.jobs.filter(relevant).slice(0,6);
    for(let i=0;i<selected.length && options.deadline-Date.now()>=300;i+=3) await Promise.all(selected.slice(i,i+3).map(async job=>{
      try {
        const response=await fetchPublicHttpText(`${job.url}?in_iframe=1`,{timeoutMs:Math.min(3500,options.deadline-Date.now()),maxBytes:1000000});
        if(response.status!==200 || new URL(response.finalUrl).origin!==base || !new URL(response.finalUrl).pathname.startsWith(`/jobs/${job.id}/`)) throw new Error();
        const detail=hostedJobDetail(response.body,job); if(!detail) throw new Error();
        Object.assign(job,detail);descriptionsFetched++;
      } catch{descriptionsUnavailable++;}
    }));
    const offset=options.offset+parsed.jobs.length;
    return {jobs:parsed.jobs,complete:parsed.complete,nextOffset:parsed.complete?null:offset,status:parsed.complete?"complete":"partial",
      snapshotKey:createHash("sha256").update(JSON.stringify([first.pages,first.jobs.map(job=>[job.id,job.title])])).digest("hex"),
      ...(parsed.complete?{expectedTotal:offset}:{}),coverageKind:"public_hosted_board",descriptionsFetched,descriptionsUnavailable};
  } catch{return unavailable(options.offset);}
}
