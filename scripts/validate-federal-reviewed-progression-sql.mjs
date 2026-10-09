// Offline actual production DDL. No network, provider, or durable receipt writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {governmentFixture,neutralGovernmentAttributes} from '../test/government-capture-fixture.mjs';
const require=createRequire(new URL('../../stanley-jev-intelligence-20260918/work/intelligence-sql-test/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
export async function runFederalReviewedProgressionChecks(options={}) {
const db=await PGlite.create('memory://',{extensions:{pgcrypto}});
const sql=name=>fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const scalar=async(q,p=[])=> (await db.query(q,p)).rows[0]?.value;
const rpc=(a,p)=>scalar('select intelligence_codex_news($1,$2) value',[a,p]);
const sha=s=>createHash('sha256').update(s).digest('hex');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
const checks=[];
const test=async(name,fn)=>{try{await fn();checks.push(name);}catch(e){e.message=name+': '+e.message;throw e;}};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try {
 await db.exec(`create extension pgcrypto; create role anon; create role authenticated; create role service_role;
  create table intelligence_jev_budget_policy(id text primary key,enabled boolean); insert into intelligence_jev_budget_policy values('jev-rollout-2026-09-24',false);
  create table companies(id uuid primary key,name text,domain text,website_raw text,city text,state text,netsuite_internal_id text,status text,lists text[],tal_claimed boolean,record_dead boolean,description text,subindustry text,ns_industry text,tal_alert boolean);
  create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,type text,strength int,half_life_days int,summary text,source_name text,source_url text,signal_date timestamptz,metadata jsonb,unique(company_id,source_url));
  create table intelligence_events(id uuid primary key,company_id uuid,trigger_id uuid);
  create table intelligence_event_observations(observation_id uuid primary key,event_id uuid);
  create function company_identity_source_context(uuid) returns jsonb language sql stable as $$select '{}'::jsonb$$;
  create function intelligence_event_bind_trigger(uuid,uuid) returns boolean language sql as $$update intelligence_events set trigger_id=$2 where id=$1 returning true$$;`);
 const foundation=sql('0059_intelligence_evidence_and_work.sql'),growth=sql('0041_tam_public_growth.sql'),leases=sql('0047_public_growth_sweep_leases.sql');
 // Exact table definitions including every constraint and default.
 await db.exec(foundation.split('-- Source-key lock')[0]+'commit;');
 await db.exec(sql('0014_app_events.sql'));
 await db.exec(growth.slice(growth.indexOf('create table if not exists government_entities'),growth.indexOf('create table if not exists federal_award_transactions')));
 await db.exec(growth.slice(growth.indexOf('create table if not exists public_growth_sweep_state'),growth.indexOf('-- Public-source intelligence')));
 await db.exec(leases.slice(leases.indexOf('alter table public_growth_sweep_state'),leases.indexOf('create or replace function acquire_public_growth_sweep_lease')));
 for(const name of ['acquire_public_growth_sweep_lease','fail_public_growth_sweep_lease']){
  const start=leases.indexOf('create or replace function '+name),end=leases.indexOf('$$;',start)+3;assert.ok(start>=0&&end>start);await db.exec(leases.slice(start,end));
 }
 await db.exec(sql('0064_federal_source_coverage.sql'));
 await db.exec('alter table intelligence_observations add column feedback_excluded boolean not null default false; update intelligence_config set enabled=true where id=1;');
 for(const name of ['0137_codex_news_analysis.sql','0138_codex_news_scalar_claim.sql','0143_codex_source_review.sql','0144_codex_exact_source_claim.sql','0146_codex_stale_claim_hold.sql','0148_codex_empty_government_capture.sql','0149_federal_reviewed_capture_progression.sql'])await db.exec(sql(name));
 await db.exec(sql('0149_federal_reviewed_capture_progression.sql'));checks.push('Actual DDL and migrations compile and reapply');
 const inspect=company=>scalar('select inspect_federal_reviewed_capture($1) value',[company]);
 const consume=(f,request=f.request)=>scalar('select consume_federal_reviewed_capture($1,$2) value',[request,f.lease]);
 const snapshot=()=>scalar(`select jsonb_build_object('state',(select to_jsonb(s) from public_growth_sweep_state s),
  'events',(select jsonb_agg(to_jsonb(e) order by id) from app_events e),'coverage',(select jsonb_agg(to_jsonb(c) order by company_id) from company_federal_source_coverage c),
  'jobs',(select jsonb_agg(to_jsonb(j) order by id) from intelligence_jobs j),'observations',(select jsonb_agg(to_jsonb(o) order by id) from intelligence_observations o)) value`);
 async function seed(collection='idvs',saved=null) {
  await db.exec('truncate public_growth_sweep_state,app_events,company_federal_source_coverage,intelligence_jobs,intelligence_observations,company_government_matches,federal_awards,government_entities,companies cascade');
  const g=saved?.g??governmentFixture(),o=g.observation,p=o.metadata.continuationBefore;
  if(!saved){p.collection=collection;p.extensionOriginal={untouched:['old',null,{one:1}]};
  o.metadata.sourceRequest.body.filters.award_type_codes=collection==='idvs'?['IDV_A','IDV_B','IDV_B_A','IDV_B_B','IDV_B_C','IDV_C','IDV_D','IDV_E']:['A','B','C','D'];
  o.metadata.requestSha256=sha(JSON.stringify(stable({companyId:g.company.id,companyIdentity:p.companyIdentity,request:o.metadata.sourceRequest})));
  o.source_key=sha(JSON.stringify(['government-json-v1',o.source_url,o.metadata.requestSha256]));}
  await db.query('insert into companies select * from jsonb_populate_record(null::companies,$1)',[g.company]);
  await db.query(`insert into intelligence_observations(id,company_id,source_kind,source_url,source_key,title,evidence_text,content_hash,event_date,observed_at,metadata,sections)
   select id,company_id,source_kind,source_url,source_key,title,evidence_text,content_hash,event_date,observed_at,metadata,sections from jsonb_populate_record(null::intelligence_observations,$1)`,[o]);
  const job=saved?.jobId??randomUUID();await db.query("insert into intelligence_jobs(id,operation_key,observation_id,kind) values($1,$1::uuid::text,$2,'interpret')",[job,o.id]);
  let packet=await rpc('claim',{requestId:randomUUID(),taskId:'/root/reader',sourceKind:'government',companyIds:[g.company.id],observationId:o.id,observedThrough:new Date().toISOString()});
  const scope={version:'government-empty-search-v1',completionScope:'source_capture',historyComplete:false,recipientIdentityVerified:false,requestIdentityConfirmed:true,fullProvenanceRead:true,searchEndDate:p.searchEndDate,collection,requestSha256:o.metadata.requestSha256,retainedJsonSha256:o.metadata.retainedJsonSha256};
  const reader={taskId:'/root/reader',model:'offline-reader',snapshotHash:packet.snapshotHash,readStart:0,readEnd:o.evidence_text.length,fullTextRead:true};
  const bound={jobId:job,lease:packet.lease,snapshotHash:packet.snapshotHash};
  packet=await rpc('analyze',{...bound,analysis:{reader,disposition:'no_signal',rationale:'Exact empty frozen capture only.',attributes:neutralGovernmentAttributes,criteria:{test:0},passage:null,governmentCapture:scope},decisionHash:'a'.repeat(64)});
  packet=await rpc('finish',{...bound,review:{reviewer:{...reader,taskId:'/root/reviewer'},approved:true,decisionHash:'a'.repeat(64),rationale:'Independent full-source review.',identityConfirmed:true,dateChecked:true,sourceLimitationsChecked:true,governmentCapture:scope},trigger:null});
  const hold=saved?.hold??{version:1,status:'held',reason:'reviewed_journal_capacity_recovery_requires_manual_resume',operationId:randomUUID(),journalId:randomUUID(),companyIds:[g.company.id,id(2),id(3),id(4)],evidenceSha256:'c'.repeat(64),readerTaskId:'old-reader',reviewerTaskId:'old-reviewer',heldAt:'2026-10-07T00:00:00.000Z'};
  const capture={version:1,status:collection==='idvs'?'held':'pending',stage:'search',reason:collection==='idvs'?'search_window_captured_awaiting_independent_review':'search_page_captured_continuation_pending',observationId:o.id,requestSha256:o.metadata.requestSha256,retainedJsonSha256:o.metadata.retainedJsonSha256,capturedAt:o.observed_at};
  const current={...p,...(collection==='contracts'?{collection:'idvs'}:{}),sourceCapture:capture};
  const map=saved?.map??{[g.company.id]:current,...Object.fromEntries([2,3,4].map(n=>[id(n),{...p,companyId:id(n),opaqueOldState:{neverRewrite:n}}]))};
  const cursor={offset:17,afterCompanyId:id(999),discoveryAttemptsTotal:3636,discoveryCapacityHold:hold,discoveryContinuations:map,
   discoveryInFlight:[],discoveryInFlightEventId:null,discoverySourceOnlyOperation:saved?.sourceOnlyOperation??{status:'checkpointed',rawOriginal:'unchanged'},
   discoveryReadbackHold:{companyIds:[id(8)],rawOldHold:{uncertain:true}},retryQueue:[{companyId:id(9),failureAttempts:2,rawExtension:{verbatim:1}}],
   deadLetters:[{companyId:id(10),resolvedAt:null,oldDebt:'unchanged'}],discoveryStrategyTimeouts:[{companyId:id(11),heldAt:'old',oldExtension:true}],unknownCursorExtension:{raw:['unchanged']}};
  const lease=randomUUID();await db.query("insert into public_growth_sweep_state(source,cursor,lease_token,lease_until,last_succeeded_at,last_error) values('federal-discovery',$1,$2,now()+interval '1 hour','2026-09-20','retained-old-error')",[cursor,lease]);
  if(saved){for(const event of [saved.holdEvent,saved.recoveryEvent])await db.query('insert into app_events(id,ts,module,kind,entity_type,entity_id,summary,meta) select id,ts,module,kind,entity_type,entity_id,summary,meta from jsonb_populate_record(null::app_events,$1)',[event]);}
  else await db.query("insert into app_events(id,module,kind,entity_type,entity_id,summary,meta) values($1,'headhunter','federal.discovery.capacity_hold','cron','federal-discovery','Original capacity recovery',$2)",[hold.operationId,{hold}]);
  const request={operationId:randomUUID(),companyId:g.company.id,expectedContinuationSha256:(await inspect(g.company.id)).continuationSha256,jobId:job,finishEventId:packet.review.receipt.eventId,snapshotHash:packet.snapshotHash,decisionHash:'a'.repeat(64),manualRunCutoff:'2026-10-08'};
  return {g,packet,cursor,lease,request};
 }
 if(options.savedEvidenceDirectory){
  const dir=options.savedEvidenceDirectory.replace(/\\/g,'/').replace(/\/$/,'');
  const saved=(path,hash)=>{const b=fs.readFileSync(dir+'/'+path);assert.equal(sha(b),hash);return JSON.parse(b);};
  const holdEvent=saved('federal-capacity-release/event.response.json','e7691fd2af2ed56210c67c608bd754e2ae40540543142f63788e9e46a5d5cfa8').payload.rows[0];
  const pending=saved('federal-event-summary-release/pending-after-three.response.json','76e17a1bd0839dd1baf9f784610ee1c9ed878180a821063e68addec1a46cdf3d');
  const recoveryEvent=saved('federal-event-summary-release/event-after.response.json','208c46d905d02e967197977bd08540d4478e3e81c41bbf658cf91211d4a5f336').payload.rows[0];
  const original=saved('federal-source-only-incident-001/first-source-readback.json','dff987ed4cc2f86d991b527d0df9782a8b07075f27c68eb005f673410aae7146').result;
  const o=original.observations[0],i=o.metadata.companyIdentity;
  const g={observation:o,company:{id:i.id,name:i.name,domain:i.domain,website_raw:i.website,city:i.city,state:i.state,netsuite_internal_id:i.netsuiteInternalId,
    status:'offline_synthetic_current_eligibility',lists:['netsuite_tam'],tal_claimed:false,record_dead:false}};
  const data={g,jobId:original.jobs[0].id,hold:pending.capacityHold,holdEvent,recoveryEvent,map:Object.fromEntries(pending.items.map(x=>[x.companyId,x.continuation])),sourceOnlyOperation:pending.sourceOnlyOperation};
  await test('Exact hash-pinned saved capacity event and pending-after-three representations accept completed review of the retained original; other three positions remain unchanged',async()=>{
   assert.deepEqual(holdEvent.meta.hold,pending.capacityHold);
   const f=await seed('idvs',data),before=await snapshot(),r=await consume(f),after=await snapshot();
   assert.equal(r.queryRetired,true);assert.deepEqual(r.priorContinuation,pending.items.find(x=>x.companyId===i.id).continuation);
   for(const row of pending.items.filter(x=>x.companyId!==i.id))assert.deepEqual(after.state.cursor.discoveryContinuations[row.companyId],row.continuation);
   for(const event of [holdEvent,recoveryEvent])assert.deepEqual(after.events.find(x=>x.id===event.id),before.events.find(x=>x.id===event.id));
  });
  await test('Recovered capture without its exact canonical recovery event remains held',async()=>{
   const f=await seed('idvs',data);await db.query('delete from app_events where id=$1',[recoveryEvent.id]);const before=await snapshot();await assert.rejects(()=>consume(f));assert.deepEqual(await snapshot(),before);
  });
 }
 await test('Exact terminal IDV receipt retires only its frozen query, preserving all other cursor fields and immutable job/event originals',async()=>{
  const f=await seed(),before=await snapshot(),r=await consume(f),after=await snapshot();
  assert.equal(r.queryRetired,true);assert.equal(r.historyComplete,false);assert.equal(r.companyComplete,false);assert.equal(r.sourceRequests,0);
  assert.deepEqual(r.priorContinuation,f.cursor.discoveryContinuations[f.g.company.id]);assert.equal(r.nextContinuation,null);
  const keys=['discoveryContinuations','discoveryManualSourceOnly'];const preserved=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!keys.includes(k)));
  assert.deepEqual(preserved(after.state.cursor),preserved(before.state.cursor));
  for(const n of [2,3,4])assert.deepEqual(after.state.cursor.discoveryContinuations[id(n)],before.state.cursor.discoveryContinuations[id(n)]);
  assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.observations,before.observations);
  for(const event of before.events)assert.deepEqual(after.events.find(x=>x.id===event.id),event);
  assert.deepEqual(after.state.cursor.discoveryCapacityHold,f.cursor.discoveryCapacityHold);
  assert.deepEqual(after.state.cursor.discoveryManualSourceOnly.retiredCapacityCompanyIds,[f.g.company.id]);
  assert.equal(after.coverage[0].status,'partial');assert.equal(after.coverage[0].searched_through,'2026-09-29');assert.equal(after.coverage[0].last_completed_at,null);
  assert.deepEqual(await consume(f),r);assert.deepEqual(await snapshot(),after);
  await assert.rejects(()=>consume(f,{...f.request,operationId:randomUUID()}));assert.deepEqual(await snapshot(),after);
 });
 await test('Contracts capture already advanced to IDVs; consumption only clears sourceCapture and never advances again',async()=>{
  const f=await seed('contracts'),r=await consume(f);assert.equal(r.queryRetired,false);
  const want=structuredClone(f.cursor.discoveryContinuations[f.g.company.id]);delete want.sourceCapture;
  assert.deepEqual((await inspect(f.g.company.id)).continuation,want);assert.equal(want.collection,'idvs');assert.equal(want.searchEndDate,'2026-09-29');
 });
 await test('Prior newer broad complete coverage scope/status/dates and unknown detail remain intact',async()=>{
  const f=await seed();await db.query("insert into company_federal_source_coverage values($1,'federal-discovery','complete','Older independently verified broad scope','2007-10-01','2026-10-08','2026-10-08','2026-10-08',$2)",[f.g.company.id,{unrelated:{evidence:'preserved'},historyComplete:true,recipientIdentityVerified:true,completionScope:'whole_source',queryRetired:false}]);
  const before=(await snapshot()).coverage[0],r=await consume(f),after=(await snapshot()).coverage[0];
  assert.deepEqual(r.priorCoverage,before);for(const [k,v] of Object.entries(before))if(k!=='detail')assert.deepEqual(after[k],v);
  for(const [k,v] of Object.entries(before.detail))assert.deepEqual(after.detail[k],v);assert.equal(after.detail.lastReviewedSourceCapture.completionScope,'source_capture');
 });
 await test('Incidental post-completion description/status changes reuse the completed receipt while current identity still matches',async()=>{
  const f=await seed();await db.exec("update companies set status='incidental_new_status',description='New description after completion'");
  assert.equal((await consume(f)).queryRetired,true);
 });
 for(const [name,mutate] of [
  ['wrong continuation hash',async f=>{f.request.expectedContinuationSha256='f'.repeat(64);}],
  ['wrong snapshot hash',async f=>{f.request.snapshotHash='f'.repeat(64);}],
  ['wrong decision hash',async f=>{f.request.decisionHash='f'.repeat(64);}],
  ['wrong canonical event',async f=>{f.request.finishEventId=randomUUID();}],
  ['expired lease',async()=>db.exec("update public_growth_sweep_state set lease_until=now()-interval '1 second'")],
  ['unknown lease',async f=>{f.lease=randomUUID();}],
  ['changed current company identity',async()=>db.exec("update companies set name='Different company'")],
  ['missing current TAM and TAL membership',async()=>db.exec("update companies set lists=null,tal_claimed=false")],
  ['unfinished source job',async()=>db.exec("update intelligence_jobs set status='queued'")],
  ['missing full independent read',async()=>db.exec("update intelligence_jobs set result=jsonb_set(result,'{codexNews,independentReview,reviewer,fullTextRead}','false')")],
  ['self reviewer',async()=>db.exec("update intelligence_jobs set result=jsonb_set(result,'{codexNews,independentReview,reviewer,taskId}','\"/root/reader\"')")],
  ['unknown in-flight write',async()=>db.exec("update public_growth_sweep_state set cursor=cursor||'{\"discoveryInFlight\":[\"unknown\"]}'")],
  ['retired without event',async f=>{
    const hold=f.cursor.discoveryCapacityHold;const mode={version:1,status:'manual_source_only',holdOperationId:hold.operationId,establishedEventId:randomUUID(),manualRunCutoff:'2026-10-08',retiredCapacityCompanyIds:[id(2)]};
    await db.query("update public_growth_sweep_state set cursor=jsonb_set(cursor,'{discoveryContinuations}',(cursor->'discoveryContinuations')-$1)||jsonb_build_object('discoveryManualSourceOnly',$2::jsonb)",[id(2),mode]);
  }],
  ['exact unresolved old hold',async f=>db.query("update public_growth_sweep_state set cursor=jsonb_set(cursor,'{discoveryReadbackHold,companyIds}',$1)",[[f.g.company.id]])],
  ['old cutoff cannot be relabeled current',async f=>{f.request.manualRunCutoff='2026-09-28';}],
 ])await test(name+' rejects without writes',async()=>{const f=await seed();await mutate(f);const before=await snapshot();
  await assert.rejects(()=>consume(f),name==='missing current TAM and TAL membership'?/exact eligible original capture required/:undefined);assert.deepEqual(await snapshot(),before);});
 for(const table of ['public_growth_sweep_state','company_federal_source_coverage','app_events'])await test(table+' write failure rolls back all three writes',async()=>{
  const f=await seed();await db.exec(`create function deny_review_write() returns trigger language plpgsql as $$begin raise exception 'simulated exact write failure'; end$$;
   create trigger deny_review_write before insert or update on ${table} for each row execute function deny_review_write();`);
  const before=await snapshot();await assert.rejects(()=>consume(f));assert.deepEqual(await snapshot(),before);
  await db.exec(`drop trigger deny_review_write on ${table};drop function deny_review_write()`);
 });
 await test('Canonical selector includes outside/removed claimed TAL, excludes duplicate and removed unclaimed TAM, preserves verified recipient and award exclusions',async()=>{
  const f=await seed();
  for(const [n,lists,status,tal] of [[20,[],null,true],[21,['tam_removed'],'removed_from_tam',true],[22,['netsuite_tam'],'active',false],[23,['netsuite_tam'],'removed_from_tam',false],[24,['tam_duplicate'],'active',true],[25,['netsuite_tam'],'active',false],[26,['netsuite_tam'],'active',false]])await db.query('insert into companies(id,name,lists,status,tal_claimed) values($1,$2,$3,$4,$5)',[id(n),'Company '+n,lists,status,tal]);
  for(const n of [25,26]){await db.query("insert into government_entities(id,legal_name,source,usaspending_recipient_id) values($1,'Known','verified',$2)",[id(100+n),n===25?'recipient':null]);
   await db.query("insert into company_government_matches(company_id,government_entity_id,match_status,match_method) values($1,$2,'verified','reviewed')",[id(n),id(100+n)]);}
  await db.query("insert into federal_awards(government_entity_id,generated_award_id,source_url) values($1,'award','https://example.test')",[id(126)]);
  const rows=(await db.query('select id from list_federal_discovery_tam_batch(21,null)')).rows.map(x=>x.id);
  assert.deepEqual(rows,[id(20),id(21),id(22),f.g.company.id].sort());
  assert.deepEqual((await db.query('select id from list_federal_discovery_tam_batch(1,$1)',[id(21)])).rows.map(x=>x.id),[id(22)]);
 });
 await test('Consumption/inspection are unavailable to anon and authenticated',async()=>{
  for(const role of ['anon','authenticated'])for(const signature of ['consume_federal_reviewed_capture(jsonb,uuid)','inspect_federal_reviewed_capture(uuid)'])assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') value',[role,signature]),false);
 });
 if(options.controller)await test('Actual TypeScript controller uses real lease, transaction, exact event and complete SQL inspection response',()=>options.controller({db,seed,inspect,snapshot,consume}));
 return {ok:true,checks:checks.length,results:checks,networkCalls:0,productionWrites:0};
}
finally{await db.close();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{console.log(JSON.stringify(await runFederalReviewedProgressionChecks({savedEvidenceDirectory:process.env.STANLEY_FEDERAL_SAVED_EVIDENCE_DIR})));}
 catch(error){console.error(JSON.stringify({ok:false,message:error.message,code:error.code,detail:error.detail,where:error.where,position:error.position}));process.exitCode=1;}
}
