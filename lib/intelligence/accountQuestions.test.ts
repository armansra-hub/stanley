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
 it('retires the worker without claims, database reads, budget polls, provider calls, or retries',async()=>{
  for(const [limit,deadline] of [[1,Date.now()+90000],[8,Date.now()+900000],[0,0]])
   expect(await runAccountQuestionWorker(limit,deadline)).toEqual({enabled:false,processed:0,outcomes:{},stoppedBy:'purpose_retired'});
  expect(m.rpc).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();expect(m.native).not.toHaveBeenCalled();expect(m.budget).not.toHaveBeenCalled();
 }); it('reuses an unchanged answer across job clocks while preserving meaningful source and coverage changes',()=>{
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
