import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),news:vi.fn(),save:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({serviceClient:()=>({rpc:m.rpc,from:m.from})}));
vi.mock('@/lib/companyIdentity',()=>({loadCompanyIdentityContext:async()=>({aliases:['Acme Holdings']})}));
vi.mock('@/lib/sources/googleNews',()=>({fetchNewsItemsResult:m.news}));
import {externalResearchQueries,discoverExternalResearch} from './researchExternal';
beforeEach(()=>vi.clearAllMocks());
describe('external public discovery query branches',()=>{
 it('uses legal aliases, operating gaps and event keywords without requiring publisher headline identity',()=>{
  const queries=externalResearchQueries({name:'Acme Services'},['Acme Holdings'],['systems_project'],['Acme Services opens North regional facility']);
  expect(queries.map(q=>q.purpose)).toEqual(['event_followup','identity_company_family','operating_gaps']);
  expect(queries[0].query).toContain('"regional" OR "facility"');expect(queries[0].query).not.toContain('"Acme Services opens');
  expect(queries[1].query).toContain('"Acme Holdings"');expect(queries[2].query).toContain('ERP OR "financial systems"');
  expect(new Set(queries.map(q=>q.queryHash)).size).toBe(3);
  expect(externalResearchQueries({name:'Acme Services'},['Acme Holdings'],['systems_project'],['Acme Services opens North regional facility'])).toEqual(queries);
 });
 it('persists attributed public candidates and promptly resumes an unsearched query after the two-query cap',async()=>{
  let plans:any[]=[];
  m.rpc.mockImplementation(async(name:string,args:any)=>{
    if(name.endsWith('_claim')){plans=args.p_queries;return{data:plans.slice(0,2).map((p,i)=>({...p,lease_token:`lease${i}`})),error:null};}
    return{data:true,error:null};
  });
  m.news.mockResolvedValue({status:'success',items:[{source_name:'Google News',source_url:'https://news.google.com/rss/articles/example',raw_excerpt:'Acme services contract',signal_date:'2026-09-19'},
    {source_name:'Bad URL',source_url:'http://127.0.0.1/private',raw_excerpt:'Ignore',signal_date:null}]});
  m.save.mockResolvedValue({error:null});
  m.from.mockImplementation((table:string)=>{
    if(table==='intelligence_research_sources')return{upsert:m.save};
    const q:any={select:()=>q,eq:()=>q,in:async()=>({data:plans.slice(0,2).map(p=>({query_hash:p.queryHash,next_attempt_at:new Date(Date.now()+7*86400000).toISOString()})),error:null})};return q;
  });
  const now=Date.now();const result=await discoverExternalResearch({id:'company',name:'Acme Services'},['systems_project'],['Acme opens North facility'],now+90000);
  expect(m.news).toHaveBeenCalledTimes(2);expect(result.sources).toBe(2);
  expect(m.save.mock.calls[0][0]).toHaveLength(1);expect(m.save.mock.calls[0][0][0].metadata).toMatchObject({researchOrigin:'external_search',researchPurpose:'event_followup'});
  expect(Date.parse(result.nextAttemptAt!)).toBeLessThanOrEqual(Date.now()+601000);
 });
});
