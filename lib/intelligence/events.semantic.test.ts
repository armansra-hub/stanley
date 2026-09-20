import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),native:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({serviceClient:()=>({rpc:m.rpc})}));
vi.mock('./nativeJev',async original=>({...await original<typeof import('./nativeJev')>(),evaluateNativeCached:m.native}));
import {eventMatchInput,reconcileObservationEvent,EventReconciliationDeferred} from './events';
import {nativeJevBody} from './nativeJev';
const snapshot={company:'Synthetic',incoming:{title:'Northern office serves clients',passage:'The North facility opened September 1'},candidates:[{id:'existing',title:'New Acme regional hub',sources:[{passage:'North facility opened September 1'}]}]};
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockImplementation(async(name:string)=>({data:name.endsWith('_claim')?{status:'claimed',lease_token:'lease',snapshot}:{status:'complete',event:{id:'existing'}},error:null}));});
describe('native event identity without rejudging evidence',()=>{
 it('uses one native identity choice and persists the untouched answer before publication',async()=>{
  const native={model:'jev',answers:{same_event:{type:'choice',choice:'existing',confidence:.87}}};m.native.mockResolvedValue({status:'complete',evaluation:{ok:true,provider_result:native},reused:true});
  expect(await reconcileObservationEvent('obs','company',{signalType:'operating_change'},Date.now()+60000)).toEqual({id:'existing'});
  expect(m.native).toHaveBeenCalledWith(eventMatchInput(snapshot),expect.objectContaining({purpose:'event_match',companyId:'company'}));
  expect(m.rpc).toHaveBeenLastCalledWith('intelligence_event_reconcile_finish',{p_observation:'obs',p_lease:'lease',p_target:'existing',p_native:native});
 });
 it.each(['busy','budget_deferred'])('defers publication on %s without fabricating a distinct event',async(status)=>{
  m.native.mockResolvedValue({status});await expect(reconcileObservationEvent('obs','company',{},Date.now()+60000)).rejects.toBeInstanceOf(EventReconciliationDeferred);
  expect(m.rpc).toHaveBeenCalledOnce();
 });
 it('does not call a model when there are no competing events',async()=>{
  m.rpc.mockResolvedValueOnce({data:{status:'claimed',lease_token:'lease',snapshot:{...snapshot,candidates:[]}},error:null});
  await reconcileObservationEvent('obs','company',{},Date.now()+60000);expect(m.native).not.toHaveBeenCalled();
 });
 it('bounds six multilingual publisher contexts below the real request cap',()=>{
  const text='𠜎'.repeat(10000);const source={url:text,title:text,passage:text};
  expect(()=>nativeJevBody(eventMatchInput({company:text,incoming:source,candidates:Array.from({length:6},(_,i)=>({id:'event'+i,title:text,sources:[source,source]}))}))).not.toThrow();
 });
});
