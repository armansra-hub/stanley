/** Actual catalog migrations in offline PostgreSQL. No provider/production IO.
 * PGlite serializes queries; these tests do not claim a concurrency load test. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0] ?? {})[0];
const rows = async (sql,args=[]) => (await db.query(sql,args)).rows;
const migrate = async name => db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),"utf8"));
const facets = [...(await readFile(new URL("../../lib/intelligence/operatingCatalogData.ts",import.meta.url),"utf8"))
  .matchAll(/"id": "(rr_[a-z][0-9]{2})"/g)].map(m=>m[1]);
assert.equal(facets.length,47);
const version="offline-catalog-v1";
let passed=0;
const check=async(name,run)=>{
  await db.exec("begin");
  try {await run();passed++;console.log(`PASS ${name}`);}
  finally {await db.exec("rollback");}
};
const claim=limit=>rows("select * from intelligence_directed_claim($1)",[limit]);
const snapshot=()=>scalar(`select jsonb_build_object(
 'jobs',(select jsonb_agg(to_jsonb(j) order by company_id) from intelligence_directed_research_jobs j),
 'facets',(select jsonb_agg(to_jsonb(f) order by company_id,facet_id) from intelligence_catalog_facets f),
 'accounts',(select jsonb_agg(to_jsonb(a)-'last_completed_catalog_version' order by company_id) from intelligence_catalog_accounts a),
 'policy',(select to_jsonb(p) from intelligence_jev_budget_policy p),
 'spend',(select jsonb_agg(to_jsonb(s) order by id) from intelligence_spend s))`);
async function account(name,{answered=0,minutes=2,status="pending",requested=version,facetVersion=version,evidence=null}={}) {
  const company=randomUUID(),observation=randomUUID();
  await db.query(`insert into companies(id,name,status,lists,netsuite_internal_id,domain)
    values($1,$2,'new',array['netsuite_tam'],'1234','synthetic.test')`,[company,name]);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash)
    values($1,$2,'site','website','https://synthetic.test/','Full source','Complete retained source evidence','exact-source-hash')`,[observation,company]);
  await db.query("select intelligence_catalog_admit($1,$2)",[company,requested]);
  const key=evidence??(await scalar("select intelligence_catalog_evidence($1)",[company])).evidenceKey;
  for(const id of facets.slice(0,answered)) await db.query(`insert into intelligence_catalog_facets
    (company_id,facet_id,catalog_version,facet_version,evidence_key,status,decision,native_result)
    values($1,$2,$3,'exact-question',$4,'answered','insufficient_evidence',jsonb_build_object('model','jev','native','retained','questionId',$2::text))`,[company,id,facetVersion,key]);
  await db.query(`update intelligence_catalog_accounts set catalog_version=$2,evidence_key=$3,answered_count=$4,status=$5 where company_id=$1`,
    [company,requested,key,answered,status]);
  await db.query(`update intelligence_directed_research_jobs set due_at=now()-make_interval(mins=>$2),
    catalog_checkpoint=$3,result='{"saved":"existing result"}' where company_id=$1`,
    [company,minutes,{catalogVersion:requested,evidenceKey:key,completed:answered===47,pending:{exact:"saved request"}}]);
  return {company,observation,key};
}
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
  "0081_intelligence_document_discoveries.sql","0105_intelligence_reuse_answered_topics.sql"]) await migrate(name);
 await db.exec(`alter table intelligence_research_sources add column metadata jsonb not null default '{}';
  create table intelligence_account_question_jobs(view_id uuid references intelligence_views(id),company_id uuid references companies(id),
    revision bigint default 1,running_revision bigint,status text default 'queued',due_at timestamptz default now(),lease_token uuid,
    lease_until timestamptz,checkpoint jsonb,last_error text,updated_at timestamptz default now(),primary key(view_id,company_id));
  create function intelligence_account_question_claim() returns jsonb language sql as $$select null::jsonb$$;`);
 for(const name of ["0082_jev_request_receipts.sql","0090_native_jev_purposes.sql","0107_intelligence_research_caught_up.sql",
  "0108_intelligence_coverage_priority.sql","0109_intelligence_symmetric_answer_reuse.sql","0112_intelligence_worker_capacity.sql",
  "0117_jev_global_budget_policy.sql","0119_intelligence_catalog_coverage.sql","0123_jev_provider_balance_mode.sql","0124_intelligence_ongoing_queue_admission.sql"]) await migrate(name);
 await db.exec(`update intelligence_config set enabled=true,catalog_mode='rollout';
  update intelligence_jev_budget_policy set enabled=true,enforcement='provider_balance',halt_reason=null;`);
 const complete=await account("Completed",{answered:47,status:"complete",minutes:100});
 const partial=await account("Partial",{answered:16,minutes:1});
 const untouched=await account("Untouched",{minutes:50});
 const oldVersion=await account("Prior version answers",{answered:47,facetVersion:"old-version",minutes:20});
 const staleSource=await account("Prior source answers",{answered:47,evidence:"old-source-key",minutes:10});
 const missingNative=await account("Missing native answer",{answered:47,minutes:5});
 await db.query("update intelligence_catalog_facets set status='pending',decision=null,native_result=null where company_id=$1 and facet_id=$2",[missingNative.company,facets[0]]);
 await check("old implementation reproduces the artificial two-account ceiling",async()=>{
  assert.equal((await claim(50)).length,2);assert.equal((await claim(1)).length,0);
 });
 const before=await snapshot();
 const interpretationBefore=await scalar("select pg_get_functiondef('intelligence_claim(integer)'::regprocedure)");
 await migrate("0127_intelligence_catalog_completion_priority.sql");
 assert.deepEqual(await snapshot(),before,"installation may change scheduling metadata only");
 assert.equal(await scalar("select pg_get_functiondef('intelligence_claim(integer)'::regprocedure)"),interpretationBefore,"news interpretation must not be paused or changed");
 assert.deepEqual((await rows("select company_id from intelligence_catalog_accounts where last_completed_catalog_version=$1",[version])).map(a=>a.company_id).sort(),
  [complete.company,staleSource.company].sort());
 console.log("PASS migration preserves existing rows/leases/checkpoints and backfills only proven 47-answer same-snapshot completion");passed++;

 await check("caller-ready capacity can exceed two while exact live leases remain exclusive",async()=>{
  const first=await claim(4),second=await claim(4);
  assert.equal(first.length,4);assert.equal(second.length,2);
  assert.equal(new Set([...first,...second].map(j=>j.company_id)).size,6);
  assert.equal((await claim(100)).length,0);
  assert.ok([...first,...second].every(j=>j.status==='running'&&j.lease_token&&j.attempts===1));
  assert.ok([...first,...second].every(j=>j.catalog_checkpoint.pending.exact==='saved request'&&j.result.saved==='existing result'));
  assert.equal(await scalar("select count(*)::int from intelligence_spend"),0);
 });
 await check("partial first pass precedes older untouched work, and both precede completed refresh",async()=>{
  assert.equal((await claim(1))[0].company_id,partial.company);
  const rest=[];for(let i=0;i<5;i++)rest.push((await claim(1))[0].company_id);
  assert.equal(rest[0],untouched.company);assert.equal(rest.at(-2),complete.company);assert.equal(rest.at(-1),staleSource.company);
  assert.ok(rest.indexOf(oldVersion.company)<rest.indexOf(complete.company));
 });
 await check("publication remembers 47 answers before discovery and keeps that marker through source invalidation",async()=>{
  for(const id of facets.slice(16)) await db.query(`insert into intelligence_catalog_facets
   (company_id,facet_id,catalog_version,facet_version,evidence_key,status,decision,native_result)
   values($1,$2,$3,'exact-question',$4,'answered','insufficient_evidence',jsonb_build_object('model','jev','questionId',$2::text))`,[partial.company,id,version,partial.key]);
  await db.query("update intelligence_catalog_accounts set answered_count=47,status='running' where company_id=$1",[partial.company]);
  assert.equal(await scalar("select last_completed_catalog_version from intelligence_catalog_accounts where company_id=$1",[partial.company]),version);
  await db.query("update intelligence_observations set content_hash='corrected-source-hash' where id=$1",[partial.observation]);
  assert.equal(await scalar("select status from intelligence_catalog_accounts where company_id=$1",[partial.company]),"stale");
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets where company_id=$1 and status='stale'",[partial.company]),47);
  await db.query("update intelligence_catalog_accounts set answered_count=0,status='running' where company_id=$1",[partial.company]);
  assert.equal(await scalar("select last_completed_catalog_version from intelligence_catalog_accounts where company_id=$1",[partial.company]),version);
  assert.notEqual((await claim(1))[0].company_id,partial.company,"refresh must not masquerade as first-pass work after invalidation");
 });
 await check("a new catalog version earns first-pass priority without inheriting old answers",async()=>{
  await db.query("select intelligence_catalog_admit($1,'offline-catalog-v2')",[complete.company]);
  assert.equal(await scalar("select last_completed_catalog_version from intelligence_catalog_accounts where company_id=$1",[complete.company]),version);
  await db.query("update intelligence_directed_research_jobs set due_at=now()-interval '100 days' where company_id=$1",[complete.company]);
  assert.equal((await claim(1))[0].company_id,partial.company);
  assert.equal((await claim(1))[0].company_id,complete.company);
 });
 await check("future deadlines, blocked holds and healthy account leases are not overridden",async()=>{
  const lease=randomUUID();
  await db.query("update intelligence_directed_research_jobs set status='running',lease_token=$2,lease_until=now()+interval '1 minute' where company_id=$1",[partial.company,lease]);
  await db.query("update intelligence_directed_research_jobs set due_at='infinity',last_error='provider_authentication_unavailable' where company_id=$1",[untouched.company]);
  const held=await rows("select * from intelligence_directed_research_jobs where company_id=any($1::uuid[]) order by company_id",[[partial.company,untouched.company]]);
  const selected=await claim(20);assert.equal(selected.length,4);
  assert.deepEqual(await rows("select * from intelligence_directed_research_jobs where company_id=any($1::uuid[]) order by company_id",[[partial.company,untouched.company]]),held);
  await db.query("update intelligence_directed_research_jobs set lease_until=now()-interval '1 second' where company_id=$1",[partial.company]);
  const resumed=(await claim(1))[0];assert.equal(resumed.company_id,partial.company);assert.notEqual(resumed.lease_token,lease);
 });
 for(const reason of ["manual_pause","provider_billing_unavailable","provider_authentication_unavailable"]) await check(`${reason} preserves its hold and does not admit catalog jobs`,async()=>{
  await db.query("update intelligence_jev_budget_policy set enabled=false,halt_reason=$1",[reason]);const held=await snapshot();
  assert.equal((await claim(100)).length,0);assert.deepEqual(await snapshot(),held);
 });
 await check("pilot, disabled and canonical membership restrictions remain binding",async()=>{
  await db.exec("update intelligence_config set enabled=false");assert.equal((await claim(100)).length,0);
  await db.query("update intelligence_config set enabled=true,catalog_mode='pilot',catalog_pilot_company_id=$1",[untouched.company]);
  assert.deepEqual((await claim(100)).map(j=>j.company_id),[untouched.company]);
  await db.exec("update intelligence_config set catalog_mode='rollout'");
  for(const assignment of ["status='removed_from_tam'","lists=array['netsuite_tam','tam_duplicate']","lists='{}'","netsuite_internal_id='invalid'"]) {
   await db.exec("savepoint eligibility");await db.exec(`update companies set ${assignment}`);assert.equal((await claim(100)).length,0);await db.exec("rollback to savepoint eligibility");
  }
 });
 await check("a stale in-flight source cannot earn completion or publish old native answers",async()=>{
  const job=(await claim(1))[0];assert.equal(job.company_id,partial.company);
  const snap=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[partial.company,job.lease_token,version]);
  await db.query("update intelligence_observations set feedback_excluded=true where id=$1",[partial.observation]);
  assert.equal(await scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,'{}','[]','{}',false,null)",[partial.company,job.lease_token,version,snap.evidenceKey]),false);
  assert.equal(await scalar("select last_completed_catalog_version from intelligence_catalog_accounts where company_id=$1",[partial.company]),null);
 });
 await check("new native work keeps private permissions and invalid limits fail",async()=>{
  for(const role of ["anon","authenticated"]) assert.equal(await scalar("select has_function_privilege($1,'intelligence_directed_claim(integer)','EXECUTE')",[role]),false);
  assert.equal(await scalar("select has_function_privilege('service_role','intelligence_directed_claim(integer)','EXECUTE')"),true);
  assert.equal(await scalar("select has_function_privilege('service_role','intelligence_catalog_remember_completion()','EXECUTE')"),false);
  for(const limit of [null,0,-1]) {await db.exec("savepoint invalid_limit");await assert.rejects(()=>claim(limit),/must be positive/);await db.exec("rollback to savepoint invalid_limit");}
 });
 console.log(`${passed} catalog completion-priority checks passed; no provider calls or live writes.`);
} finally {await db.close();}
