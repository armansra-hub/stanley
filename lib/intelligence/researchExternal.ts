import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { loadCompanyIdentityContext } from "@/lib/companyIdentity";
import { fetchNewsItemsResult } from "@/lib/sources/googleNews";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";

export type ExternalResearchPurpose = "operating_gaps" | "event_followup" | "identity_company_family";
export type ExternalResearchQuery = { query: string; purpose: ExternalResearchPurpose; queryHash: string };
const quote = (value: string) => `"${value.replace(/["\\\r\n]/g, " ").trim().slice(0, 180)}"`;
export function externalResearchQueries(company: { name: string; domain?: string | null }, aliases: string[], missingTopics: string[], eventTitles: string[]): ExternalResearchQuery[] {
  const names = [...new Set([company.name, ...aliases].filter(value => value.trim()))].slice(0, 3);
  const identity = names.length === 1 ? quote(names[0]) : `(${names.map(quote).join(" OR ")})`;
  const topics: Record<string,string> = { systems_project: 'ERP OR "financial systems"', close_reporting: '"financial reporting" OR controller', finance_leadership: 'CFO OR "chief financial officer"', investor_reporting: 'investment OR "private equity"', multi_entity: 'subsidiary OR acquisition', workforce_billing: 'staffing OR payroll', project_financials: '"project accounting" OR utilization', recurring_revenue: 'contract OR subscription' };
  const requested = [...new Set(missingTopics.flatMap(topic => topics[topic] ? [topics[topic]] : []))].slice(0, 2).join(" OR ");
  const companyWords = new Set(names.join(" ").toLowerCase().split(/\W+/));
  const eventQueries = eventTitles.slice(0, 2).map(title => {
    const terms = [...new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3 && !companyWords.has(word)
      && !["with", "from", "that", "this", "announces", "announced", "company"].includes(word)))].slice(0, 5);
    return { purpose: "event_followup" as const, query: `${identity} (${terms.length ? terms.map(quote).join(" OR ") : 'expansion OR contract OR acquisition'})` };
  });
  const rows: {query:string;purpose:ExternalResearchPurpose}[] = [
    ...eventQueries,
    {purpose:"identity_company_family",query:`${identity} (subsidiary OR "parent company" OR "formerly known" OR "joint venture" OR acquired)`},
    ...(missingTopics.length ? [{purpose:"operating_gaps" as const,query:`${identity} (${requested || 'contract OR expansion OR "finance systems" OR operations'})`}] : []),
  ];
  return rows.map(row=>({...row,queryHash:createHash("sha256").update(JSON.stringify(["external-research-v1",row])).digest("hex")}));
}
export async function discoverExternalResearch(company: {id:string;name:string;domain?:string|null;netsuite_internal_id?:string|null}, missingTopics:string[], eventTitles:string[], deadlineMs:number) {
  if (Date.now() > deadlineMs-25_000) return {queries:0,sources:0,outcome:"deadline"};
  const identity = await loadCompanyIdentityContext(company).catch(()=>({aliases:[]}));
  const plans=externalResearchQueries(company,identity.aliases,missingTopics,eventTitles);
  const db=serviceClient();
  const {data,error}=await db.rpc("intelligence_external_research_claim",{p_company:company.id,p_queries:plans});
  if(error||!Array.isArray(data)) throw new Error("external_research_claim_failed");
  let sources=0;
  for(const claim of data as (ExternalResearchQuery & {lease_token:string})[]) {
    const result=await fetchNewsItemsResult(claim.query,6,{deadlineMs:deadlineMs-15_000});
    const items=result.items.filter(item=>{try{return !!validatePublicHttpUrl(item.source_url);}catch{return false;}});
    if(items.length){
      const {error:saveError}=await db.from("intelligence_research_sources").upsert(items.map(item=>({company_id:company.id,source_url:item.source_url,
        title:item.raw_excerpt.slice(0,600),discovered_from:`https://news.google.com/rss/search?q=${encodeURIComponent(claim.query)}`,
        metadata:{researchOrigin:"external_search",researchPurpose:claim.purpose,query:claim.query,queryHash:claim.queryHash,discoveredAt:new Date().toISOString(),
          newsItem:{...item,raw_excerpt:item.raw_excerpt.slice(0,1500),feed_excerpt:item.feed_excerpt?.slice(0,1000)}}})),{onConflict:"company_id,source_url"});
      if(saveError)throw new Error("external_research_sources_failed");sources+=items.length;
    }
    const {data:finished,error:finishError}=await db.rpc("intelligence_external_research_finish",{p_company:company.id,p_hash:claim.queryHash,p_lease:claim.lease_token,
      p_outcome:result.status,p_count:items.length});
    if(finishError||finished!==true)throw new Error("external_research_finish_failed");
  }
  const schedule = await db.from("intelligence_external_research_queries").select("query_hash,next_attempt_at")
    .eq("company_id", company.id).in("query_hash", plans.map(plan => plan.queryHash));
  if (schedule.error) throw new Error("external_research_schedule_unavailable");
  const dates = new Map((schedule.data ?? []).map(row => [row.query_hash, Date.parse(row.next_attempt_at)]));
  // Queries beyond this invocation's two-query cap remain a near-term task,
  // even when the just-searched branches returned no source URLs.
  const next = Math.min(...plans.map(plan => dates.get(plan.queryHash) ?? Date.now()));
  return {queries:data.length,sources,outcome:data.length?"searched":"not_due",nextAttemptAt:new Date(Math.max(Date.now()+600_000,next)).toISOString()};
}
