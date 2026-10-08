// In-memory PostgreSQL only; no connection to a live database or provider.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../stanley-jev-intelligence-20260918/work/intelligence-sql-test/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create('memory://');
await db.exec(`create role anon; create role authenticated; create role service_role;
create table public_growth_sweep_state(source text primary key,cursor jsonb not null,updated_at timestamptz default now(),
lease_until timestamptz,lease_token uuid,last_started_at timestamptz,last_succeeded_at timestamptz,last_error text,last_receipt jsonb);
create table app_events(id uuid primary key,ts timestamptz default now(),module text,kind text,entity_type text,entity_id text,summary text,meta jsonb);`);
const migration = fs.readFileSync(new URL('../supabase/migrations/0147_federal_discovery_capacity_hold.sql', import.meta.url), 'utf8');
await db.exec(migration);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ids=[id(2001),id(2002),id(2003),id(2004)];
const continuation = companyId => ({version:1,companyId,companyIdentity:'a'.repeat(64),searchEndDate:'2026-09-29',
targets:[{query:'Original exact company query',identity:null}],targetIndex:0,page:1,candidate:null,lastPageHash:null,searchAfter:null,collection:'idvs'});
const hold={version:1,status:'unresolved',reason:'interrupted_wave_outcome_unknown',companyIds:[id(1900)],
originalEventId:id(8000),evidenceSha256:'b'.repeat(64),observedAt:'2026-09-18T00:00:00Z',heldAt:'2026-09-19T00:00:00Z'};
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
const checks=[];
async function fixture(count=997,mutate=()=>{}) {
  await db.exec('truncate public_growth_sweep_state,app_events');
  const journalId=randomUUID(), operationId=randomUUID();
  const cursor={offset:17,afterCompanyId:id(1500),discoveryInFlight:ids,discoveryInFlightEventId:journalId,
    discoveryAttemptsTotal:3636,discoveryContinuations:Object.fromEntries(Array.from({length:count},(_,i)=>[id(i+1),continuation(id(i+1))])),
    discoveryReadbackHold:hold,retryQueue:[{companyId:id(1800),rawExtension:{preserve:'verbatim'}}],
    deadLetters:[{companyId:id(1801),resolvedAt:null,rawExtension:'preserved'}],discoveryStrategyTimeouts:[{companyId:id(1802),heldAt:'old',rawExtension:'preserved'}],
    discoveryLastJournalResume:{eventId:id(7000),kind:'old-recovery'},lastDiscoveryOutcomes:[{companyId:id(1799),status:'in_progress'}],untouched:{arbitrary:'preserved'}};
  const meta={source:'federal-discovery',requestStrategy:'name-only-v1',attemptedAt:'2026-09-29T22:00:48.856Z',
    historyComplete:false,coverageVerified:false,newStrategyHeldCompanyIds:[],unresolvedReadbackCompanyIds:hold.companyIds,
    readbackHoldStatus:hold.status,readbackHoldReason:hold.reason,
    attemptedCompanies:ids.map(companyId=>({companyId,status:'in_progress',stage:'award_search',reason:'searching_contract_vehicles',
      sourceRequests:1,mayHaveWritten:false,verified:false,historyComplete:false,exhaustive:false,elapsedMs:2200,
      searchEndDate:'2026-09-29',continuation:continuation(companyId)}))};
  const input={cursor,meta,leaseUntil:null};mutate(input);
  await db.query("insert into public_growth_sweep_state values('federal-discovery',$1,'2026-09-29T22:00:00Z',$2,null,'2026-09-29T22:00:00Z','2026-09-29T21:55:47Z','interrupted_discovery_requires_readback',$3)",[input.cursor,input.leaseUntil,{priorReceipt:'preserved'}]);
  await db.query("insert into app_events(id,ts,module,kind,entity_type,summary,meta) values($1,'2026-09-29T22:00:50Z','headhunter','federal.discovery.attempts','cron','Original journal',$2)",[journalId,input.meta]);
  const request={operationId,journalId,companyIds:ids,expectedCursorMd5:await scalar("select md5(cursor::text) value from public_growth_sweep_state"),
    expectedJournalMd5:await scalar('select md5(meta::text) value from app_events where id=$1',[journalId]),evidenceSha256:'c'.repeat(64),readerTaskId:'reader-task',reviewerTaskId:'distinct-reviewer-task'};
  return {request,cursor:input.cursor,meta:input.meta};
}
const rpc = request => scalar('select reconcile_federal_discovery_capacity_hold($1) value',[request]);
const snapshot = () => scalar("select jsonb_build_object('state',(select to_jsonb(s) from public_growth_sweep_state s),'events',(select jsonb_agg(to_jsonb(e) order by id) from app_events e)) value");
async function rejected(name,mutate,count=997) {
  const f=await fixture(count,mutate);const before=await snapshot();await assert.rejects(()=>rpc(f.request));assert.deepEqual(await snapshot(),before);checks.push(name);
}
{
 const f=await fixture();const before=await snapshot();const r=await rpc(f.request);const after=await snapshot();
 assert.equal(r.pendingSearches,1001);assert.equal(r.priorContinuationCount,997);assert.equal(r.attemptsCredited,0);assert.equal(r.sourceRequests,0);assert.equal(r.providerReplay,false);assert.equal(r.historyComplete,false);assert.equal(r.coverageVerified,false);
 const got=after.state.cursor;assert.equal(got.afterCompanyId,f.cursor.afterCompanyId);assert.equal(got.discoveryAttemptsTotal,3636);
 const preserved=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!['discoveryContinuations','discoveryInFlight','discoveryInFlightEventId','discoveryCapacityHold'].includes(k)));
 assert.deepEqual(preserved(got),preserved(f.cursor));for(const [key,value] of Object.entries(f.cursor.discoveryContinuations)) assert.deepEqual(got.discoveryContinuations[key],value);
 for(const id of ids) assert.deepEqual(got.discoveryContinuations[id],continuation(id));assert.deepEqual(got.discoveryInFlight,[]);assert.equal(got.discoveryInFlightEventId,null);assert.deepEqual(got.discoveryCapacityHold,r.hold);
 for(const key of ['lease_until','lease_token','last_started_at','last_succeeded_at','last_error','last_receipt']) assert.deepEqual(after.state[key],before.state[key]);
 assert.equal(after.events.length,2);assert.deepEqual(after.events.find(x=>x.id===f.request.journalId),before.events[0]);
 assert.deepEqual(await rpc(f.request),r);assert.deepEqual(await snapshot(),after);
 await assert.rejects(()=>rpc({...f.request,evidenceSha256:'d'.repeat(64)}));assert.deepEqual(await snapshot(),after);
 checks.push('Lossless 997+4 merge, preserved keyset/counters/old hold/all unrelated fields and original journal; exact idempotent readback, retarget conflict');
}
await rejected('Active lease blocks mutation',x=>{x.leaseUntil='2099-01-01T00:00:00Z';});
{
 const f=await fixture();await db.query('update public_growth_sweep_state set lease_token=$1,lease_until=null',[randomUUID()]);
 const before=await snapshot();await assert.rejects(()=>rpc(f.request));assert.deepEqual(await snapshot(),before);checks.push('Opaque lease without expiry follows existing lease busy semantics');
}
await rejected('Possible enrollment write is never reconciled',x=>{x.meta.attemptedCompanies[0].mayHaveWritten=true;});
await rejected('Changed exact ordered journal IDs block mutation',x=>{x.meta.attemptedCompanies.reverse();});
await rejected('Uncertain outcomes block mutation',x=>{x.cursor.discoveryUncertainOutcomes=[{companyId:ids[0]}];});
await rejected('Existing reconciliation reason blocks mutation',x=>{x.cursor.discoveryReconciliationReason='enrollment_write_requires_readback';});
await rejected('Existing continuation is never replaced',x=>{x.cursor.discoveryContinuations[ids[0]]=continuation(ids[0]);});
await rejected('Previously credited journal cannot be consumed again',x=>{x.cursor.discoveryLastJournalResume={eventId:x.cursor.discoveryInFlightEventId};});
await rejected('Below-keyset scope cannot invent prefix progress',x=>{x.cursor.afterCompanyId=id(2100);});
await rejected('Exact retry debt cannot be silently removed',x=>{x.cursor.retryQueue.push({companyId:ids[0]});});
await rejected('Unknown outcome evidence fails closed',x=>{x.meta.attemptedCompanies[0].hiddenWrite=true;});
await rejected('Malformed source continuation fails closed',x=>{x.meta.attemptedCompanies[0].continuation.targets[0].query={bad:true};});
await rejected('No non-overflow use of recovery headroom',()=>{},996);
await rejected('No preexisting unheld overflow accepted',()=>{},1001);
{
 const f=await fixture(1000);const r=await rpc(f.request);assert.equal(r.pendingSearches,1004);checks.push('Exact one-wave recovery ceiling is 1004');
}
for(const field of ['expectedCursorMd5','expectedJournalMd5']) {
 const f=await fixture();const before=await snapshot();await assert.rejects(()=>rpc({...f.request,[field]:'0'.repeat(32)}));assert.deepEqual(await snapshot(),before);checks.push(`${field} mismatch rolls back without event or state changes`);
}
{
 const f=await fixture();await db.exec("create function deny_capacity_event() returns trigger language plpgsql as $$ begin raise exception 'simulated audit insert failure'; end $$; create trigger deny_capacity_event before insert on app_events for each row execute function deny_capacity_event();");
 const before=await snapshot();await assert.rejects(()=>rpc(f.request));assert.deepEqual(await snapshot(),before);await db.exec('drop trigger deny_capacity_event on app_events; drop function deny_capacity_event()');checks.push('Audit insert failure rolls back the state update atomically');
}
{
 const f=await fixture();for(const role of ['anon','authenticated']) {await db.exec(`set role ${role}`);await assert.rejects(()=>rpc(f.request));await db.exec('reset role');}
 await db.exec('set role service_role');const r=await rpc(f.request);assert.equal(r.pendingSearches,1001);await db.exec('reset role');checks.push('Only service_role can call the security-definer reconciliation');
}
await db.close();console.log(JSON.stringify({offline:true,providerCalls:0,liveDatabaseCalls:0,passed:checks.length,checks},null,2));
