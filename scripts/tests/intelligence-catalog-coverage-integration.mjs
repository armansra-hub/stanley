/** Local PGlite only. Real source/research migrations; no production/provider IO. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0] ?? {})[0];
const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
const migrate = async name => db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),"utf8"));
let passed=0;
const check=async(name,run)=>{await run();console.log(`PASS ${name}`);passed++;};
const ids=[...((await readFile(new URL("../../lib/intelligence/operatingCatalogData.ts",import.meta.url),"utf8")).matchAll(/"id": "(rr_[a-z][0-9]{2})"/g))].map(m=>m[1]);
assert.equal(ids.length,47);
const createCompany=async name=>{const id=randomUUID();await db.query(`insert into companies(id,name,status,lists,netsuite_internal_id,domain,subindustry)
 values($1,$2,'new',array['netsuite_tam'],'1234','synthetic.test','Management Consulting')`,[id,name]);return id;};
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
 ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
 signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,subindustry text,ns_industry text,city text,state text,is_base boolean,claimable boolean);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);
 create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
 for(const name of ["0059_intelligence_evidence_and_work.sql","0061_intelligence_operating_topic_search.sql","0062_intelligence_feedback_and_research.sql",
 "0067_intelligence_directed_research_queue.sql","0071_collection_repair.sql","0074_directed_research_discovery.sql","0075_fresh_intelligence_priority.sql",
 "0081_intelligence_document_discoveries.sql","0105_intelligence_reuse_answered_topics.sql"])await migrate(name);
 await db.exec(`alter table intelligence_research_sources add column metadata jsonb not null default '{}';
 create table intelligence_account_question_jobs(view_id uuid references intelligence_views(id),company_id uuid references companies(id),revision bigint default1,running_revision bigint,status text default 'queued',due_at timestamptz default now(),lease_token uuid,lease_until timestamptz,checkpoint jsonb,last_error text,updated_at timestamptz default now(),primary key(view_id,company_id));
 create function intelligence_account_question_claim() returns jsonb language sql as $$select null::jsonb$$;`.replace("default1","default 1"));
 for(const name of ["0082_jev_request_receipts.sql","0090_native_jev_purposes.sql","0107_intelligence_research_caught_up.sql","0108_intelligence_coverage_priority.sql","0109_intelligence_symmetric_answer_reuse.sql","0112_intelligence_worker_capacity.sql","0117_jev_global_budget_policy.sql","0119_intelligence_catalog_coverage.sql"])await migrate(name);
 const budgetStatusDefinition=await scalar("select pg_get_functiondef('public.intelligence_jev_budget_status()'::regprocedure)");
 // Change time only inside this disposable DB; actual production SQL unchanged.
 const phase=async iso=>db.exec(budgetStatusDefinition.replaceAll("clock_timestamp()",`'${iso}'::timestamptz`));
 await phase("2026-09-24T20:00:00Z");
 const company=await createCompany("Synthetic"), other=await createCompany("Other"), version="test-catalog-v1";
 await check("migration is off and does not admit or copy members",async()=>{
  assert.equal(await scalar("select catalog_mode from intelligence_config"),"off");
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_accounts"),0);
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,version]),false);
 });
 await db.exec("update intelligence_jev_budget_policy set enabled=true,confirmed_available_usd=99.81,funding_confirmed_at=now(),funding_receipt='fixture',legacy_reconciliation_status='reconciled',opening_liability_usd=0,reconciliation_receipt='fixture'");
 await db.query("update intelligence_config set enabled=true,catalog_mode='pilot',catalog_pilot_company_id=$1",[company]);
 const observation=await scalar(`select intelligence_observe($1,'site','website','https://synthetic.test/','Services','Full retained 🙂 evidence','source-hash',null,now(),'{}','[]','evidence-v2')`,[company]);
 await check("pilot admits only the exact canonical account and holds old queues",async()=>{
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[other,version]),false);
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,version]),true);
  assert.equal((await rows("select * from intelligence_claim(3)")).length,0);
  assert.equal(await scalar("select intelligence_account_question_claim()"),null);
 });
 const job=(await rows("select * from intelligence_directed_claim(1)"))[0];assert.equal(job.company_id,company);
 const snapshot=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,job.lease_token,version]);
 const citation={observationId:observation.id,url:"https://synthetic.test/",title:"Services",sourceKind:"website",eventDate:null,observedAt:"2026-09-24T00:00:00Z",contentHash:"source-hash",sourceTruncated:false,start:0,end:25};
 const answers=ids.map(id=>({facetId:id,facetVersion:"exact-contract",status:"answered",decision:"insufficient_evidence",nativeResult:{answer:{type:"choice",choice:"insufficient_evidence"},model:"jev"},citations:[citation],requestFingerprints:["exact-receipt"]}));
 const checkpoint={version:"account-operating-coverage-v1",catalogVersion:version,evidenceKey:snapshot.evidenceKey,phase:"direct",mapped:{},receipts:[]};
 const save=(terminal,facets=answers,status="complete")=>scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,$6,$7,$8,null)",
  [company,job.lease_token,version,snapshot.evidenceKey,checkpoint,facets,{status,retainedCharacters:25,processedCharacters:25},terminal]);
 await check("completion requires47native results and atomically shares exact citation provenance",async()=>{
  await assert.rejects(()=>save(true,answers.slice(0,46)),/47_native_answers/);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets"),0);
  assert.equal(await save(true),true);
  assert.equal(await scalar("select answered_count from intelligence_catalog_accounts where company_id=$1",[company]),47);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_citation_sets"),1);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets where citations='[]' and citation_set_key is not null"),47);
  assert.equal(await scalar("select citations->0->>'observationId' from intelligence_catalog_citation_sets"),observation.id);
 });
 await check("capture clocks and display status edits do not invalidate native answers",async()=>{
  await db.query("update intelligence_observations set metadata=metadata||jsonb_build_object('capturedAt',now()) where id=$1",[observation.id]);
  await db.query("update companies set status='dismissed' where id=$1",[company]);
  assert.equal(await scalar("select status from intelligence_catalog_accounts where company_id=$1",[company]),"complete");
  assert.equal((await scalar("select intelligence_catalog_evidence($1)",[company])).evidenceKey,snapshot.evidenceKey);
 });
 await check("real identity change invalidates answers on the same existing account row",async()=>{
  await db.query("update companies set city='New city' where id=$1",[company]);
  assert.equal(await scalar("select status from intelligence_catalog_accounts where company_id=$1",[company]),"stale");
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets where status='stale'"),47);
  assert.equal(await scalar("select count(*)::int from intelligence_directed_research_jobs where company_id=$1",[company]),1);
 });
 await check("stale in-flight checkpoint cannot publish after source correction",async()=>{
  const active=(await rows("select * from intelligence_directed_claim(1)"))[0];
  const snap=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,active.lease_token,version]);
  await db.query("update intelligence_observations set feedback_excluded=true where id=$1",[observation.id]);
  const result=await scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,'[]','{}',false,null)",[company,active.lease_token,version,snap.evidenceKey,checkpoint]);
  assert.equal(result,false);assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1",[company]),"queued");
 });
 await check("maintenance prefers new evidence and retains bounded legacy fairness",async()=>{
  await db.exec("update intelligence_config set catalog_mode='rollout',catalog_legacy_claim_turn=0");await phase("2026-09-25T20:00:00Z");
  await db.query("update intelligence_observations set feedback_excluded=false where id=$1",[observation.id]);
  await db.exec("update intelligence_jobs set created_at=now()-interval '2 days',status='queued',due_at=now()-interval '1 day',attempts=0,lease_until=null,lease_token=null");
  const fresh=await scalar(`select intelligence_observe($1,'fresh','news','https://synthetic.test/news','New evidence','New dated company evidence','new-source-hash',now(),now(),'{}','[]','evidence-v2')`,[company]);
  const first=(await rows("select * from intelligence_claim(1)"))[0];assert.equal(first.observation_id,fresh.id);
  await db.query("update intelligence_jobs set status='complete',lease_until=null where id=$1",[first.id]);
  for(let n=2;n<10;n++)assert.equal((await rows("select * from intelligence_claim(1)")).length,0);
  const legacy=(await rows("select * from intelligence_claim(1)"))[0];assert.equal(legacy.observation_id,observation.id);
 });
 await check("budget deferral preserves checkpoints and schedules the exact reset or explicit hold",async()=>{
  const running=(await rows("select * from intelligence_jobs where status='running'"))[0];
  const retry=await scalar("select now()+interval '1 day'");
  assert.equal(await scalar("select intelligence_job_budget_defer($1,$2,$3,'daily_allowance',$4)",[running.id,running.lease_token,{pendingRequest:{fingerprint:"exact"}},retry]),true);
  const pending=(await rows("select * from intelligence_jobs where id=$1",[running.id]))[0];
  assert.equal(new Date(pending.due_at).toISOString(),new Date(retry).toISOString());assert.deepEqual(pending.result,{pendingRequest:{fingerprint:"exact"}});assert.equal(pending.attempts,0);
  const lease=randomUUID();await db.query("update intelligence_jobs set status='running',lease_token=$2,lease_until=now()+interval '1 minute' where id=$1",[running.id,lease]);
  assert.equal(await scalar("select intelligence_job_budget_defer($1,$2,$3,'authorization_required',null)",[running.id,lease,pending.result]),true);
  assert.equal(await scalar("select due_at::text from intelligence_jobs where id=$1",[running.id]),"infinity");
  const view=randomUUID(),questionLease=randomUUID();await db.query("insert into intelligence_views(id,name,question) values($1,'Fixture','Does this company provide services?')",[view]);
  await db.query("insert into intelligence_account_question_jobs(view_id,company_id,status,lease_token,lease_until,checkpoint) values($1,$2,'running',$3,now()+interval '1 minute',$4)",[view,company,questionLease,{source:2,offset:500}]);
  assert.equal(await scalar("select intelligence_account_question_budget_defer($1,$2,$3,'daily_allowance',$4)",[view,company,questionLease,retry]),true);
  const question=(await rows("select * from intelligence_account_question_jobs where view_id=$1",[view]))[0];
  assert.equal(new Date(question.due_at).toISOString(),new Date(retry).toISOString());assert.deepEqual(question.checkpoint,{source:2,offset:500});
 });
 console.log(`PASS ${passed} catalog SQL integration checks`);
} finally {await db.close();}
