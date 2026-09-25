import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),native:vi.fn(),budget:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({serviceClient:()=>({rpc:m.rpc,from:m.from}),withServiceDeadline:(_:number,run:()=>unknown)=>run()}));
vi.mock('./observations',()=>({intelligenceEnabled:()=>true}));
vi.mock('./budget',async original=>({...await original<typeof import('./budget')>(),readJevBudgetPolicy:m.budget}));
vi.mock('./nativeJev',async original=>({...await original<typeof import('./nativeJev')>(),evaluateNativeCached:m.native}));
import {accountSelectionInput,accountAnswerInput,questionSections,runAccountQuestionWorker} from './accountQuestions';
import {nativeJevBody,nativeJevFingerprint} from './nativeJev';
beforeEach(()=>{vi.clearAllMocks();m.budget.mockResolvedValue({available:true,enabled:true,phase:'maintenance'});});
describe('account-wide custom questions',()=>{
 it.each([
  ['rollout',{available:true,enabled:true,phase:'ongoing'},true],
  ['rollout',{available:true,enabled:true,phase:'maintenance'},true],
  ['rollout',{available:true,enabled:true,phase:'initial'},false],
  ['rollout',{available:true,enabled:true,phase:'expired'},false],
  ['rollout',{available:false},false],
  ['rollout',{available:true,enabled:false,phase:'ongoing',blockedReason:'policy_disabled'},false],
  ['rollout',{available:true,enabled:false,phase:'ongoing',blockedReason:'provider_balance_exhausted'},false],
  ['pilot',{available:true,enabled:true,phase:'ongoing'},false],
 ])('uses central ongoing authorization while preserving fixed phases and pilot scope (%s,%j)',async(mode,budget,enabled)=>{
  m.budget.mockResolvedValue(budget);m.rpc.mockResolvedValue({data:null,error:null});
  m.from.mockImplementation(()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{catalog_mode:mode},error:null})};return q;});
  expect(await runAccountQuestionWorker()).toMatchObject({enabled,processed:0});
  expect(m.rpc).toHaveBeenCalledTimes(enabled?1:0);expect(m.native).not.toHaveBeenCalled();
 });
 it('combines complementary facts from different sources and preserves native answers and precise citations',async()=>{
  const question='Does Synthetic serve public agencies AND bill projects?';
  const sources=[{id:'one',source_url:'https://agency.test/award',title:'Award',event_date:'2026-09-01',evidence_text:'Synthetic serves public agencies.'},
   {id:'two',source_url:'https://synthetic.test/services',title:'Services',event_date:null,evidence_text:'Synthetic bills projects by milestones.'}];
  let claimed=false;let checkpoint:any=null;let finished:any=null;
  m.rpc.mockImplementation(async(name:string,args:any)=>{if(name.endsWith('_claim'))return{data:claimed?null:(claimed=true,{view_id:'view',company_id:'company',lease_token:'lease',question,company:'Synthetic',source_ids:['one','two'],checkpoint:null}),error:null};finished=args;return{data:true,error:null};});
  m.from.mockImplementation((table:string)=>{let id='';const q:any={};for(const key of ['select','gt'])q[key]=()=>q;q.eq=(key:string,value:string)=>{if(key==='id')id=value;return q;};q.update=(value:any)=>{checkpoint=structuredClone(value.checkpoint);return q;};q.in=()=>q;q.then=(resolve:any)=>Promise.resolve({data:sources.map(s=>({id:s.id})),error:null}).then(resolve);q.maybeSingle=async()=>({data:table==='intelligence_observations'?sources.find(s=>s.id===id):{view_id:'view'},error:null});return q;});
  m.native.mockImplementation(async(input:any)=>({status:'complete',evaluation:{ok:true,provider_result:{model:'jev',answers:input.questions.account_match?{account_match:{type:'noul',noul:.83},evidence_sufficiency:{type:'choice',choice:'sufficient'}}:{relevance:{type:'noul',noul:.8},first:{type:'choice',choice:'s1'},second:{type:'choice',choice:'none'}}}},reused:false}));
  expect(await runAccountQuestionWorker(1,Date.now()+90000)).toMatchObject({processed:1,outcomes:{complete:1}});
  expect(m.native).toHaveBeenCalledTimes(3);
  const answer=m.native.mock.calls[2][0];expect(answer.state.sources.map((s:any)=>s.text)).toEqual(sources.map(s=>s.evidence_text));
  expect(finished.p_result.probability).toBe(.83);expect(finished.p_result.citations.map((s:any)=>s.observationId)).toEqual(['one','two']);
  expect(finished.p_result.selectionReceipts).toHaveLength(2);expect(checkpoint.source).toBe(2);
  expect(Object.keys(answer.questions)).toEqual(['account_match','evidence_sufficiency']);
  expect(answer.state.coverage).not.toHaveProperty('evidenceSnapshotAt');
  expect(finished.p_result.coverage.evidenceSnapshotAt).toBeTruthy();
 });
 it('reuses an unchanged answer across job clocks while preserving meaningful source and coverage changes',()=>{
  const passage={observationId:'one',url:'https://example.test/award',title:'Award',date:'2026-09-01',start:0,end:32,text:'Synthetic serves public agencies.',relevance:.8};
  const coverage={evidenceSnapshotAt:'2026-09-19T01:02:03Z',sourceCount:1,selectedSources:1,skippedSources:0,basis:'Captured source passages'};
  const input=accountAnswerInput('Synthetic','Does Synthetic serve agencies?',[passage],coverage);
  const fingerprint=nativeJevFingerprint(input);
  expect(nativeJevFingerprint(accountAnswerInput('Synthetic','Does Synthetic serve agencies?',[passage],{...coverage,evidenceSnapshotAt:'2026-09-20T04:05:06Z'}))).toBe(fingerprint);
  for(const change of [{text:'Synthetic no longer serves public agencies.'},{date:'2026-09-19'},{url:'https://different.test/award'},{observationId:'different'}])
   expect(nativeJevFingerprint(accountAnswerInput('Synthetic','Does Synthetic serve agencies?',[{...passage,...change}],coverage))).not.toBe(fingerprint);
  expect(nativeJevFingerprint(accountAnswerInput('Other company','Does Synthetic serve agencies?',[passage],coverage))).not.toBe(fingerprint);
  expect(nativeJevFingerprint(accountAnswerInput('Synthetic','Does Synthetic bill projects?',[passage],coverage))).not.toBe(fingerprint);
  expect(nativeJevFingerprint(accountAnswerInput('Synthetic','Does Synthetic serve agencies?',[passage],{...coverage,skippedSources:1}))).not.toBe(fingerprint);
  expect((input.state as any).sources[0]).toEqual({observationId:'one',url:passage.url,title:'Award',date:'2026-09-01',start:0,end:32,text:passage.text});
 });
 it('keeps compound source selection permissive and request size bounded for multilingual evidence',()=>{
  const source={id:'x',title:'Title',source_url:'https://test.test/',event_date:null,evidence_text:'𠜎'.repeat(15000)};
  const sections=questionSections(source.evidence_text);expect(sections[0].start).toBe(0);expect(sections.at(-1)!.end).toBe(3000);
  const input=accountSelectionInput('Synthetic','A'.repeat(1200),source,sections);expect(()=>nativeJevBody(input)).not.toThrow();
  expect(input.questions.relevance.instructions).toContain('ANY part');
  expect(()=>nativeJevBody(accountAnswerInput('Synthetic','A'.repeat(1200),[],{sourceCount:0}))).not.toThrow();
 });
});
