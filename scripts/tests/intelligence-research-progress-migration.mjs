/** Actual progress RPC in local PostgreSQL; no model or production calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const progress = async () => {
  // One transaction timestamp makes the full results directly comparable.
  const pair = (await db.query("select intelligence_research_progress() as optimized, intelligence_research_progress_baseline() as baseline")).rows[0];
  assert.deepEqual(pair.optimized,pair.baseline,"0111 must preserve every 0110 count and policy field");
  return pair.optimized;
};
let passed=0;
async function test(name,run) { await db.exec("truncate companies,intelligence_observations,intelligence_jobs,intelligence_directed_research_jobs"); await run(); passed++; console.log(`PASS ${name}`); }
async function account({ lists=["netsuite_tam"],status="new",internalId="1234",researchStatus=null,outcome="caught_up",dueMinutes=-60 }={}) {
  const id=randomUUID();
  await db.query("insert into companies values($1,$2,$3,$4)",[id,lists,status,internalId]);
  if(researchStatus) await db.query(`insert into intelligence_directed_research_jobs(company_id,status,due_at,result,caught_up_at)
    values($1,$2,now()-make_interval(mins=>$3),$4,case when $2='complete' then now() else null end)`,[id,researchStatus,dueMinutes,{outcome}]);
  return id;
}
async function observation(company,{current=true,excluded=false,interpreted=false}={}) {
  const id=randomUUID();
  await db.query("insert into intelligence_observations values($1,$2,$3,$4,$5)",[id,company,current,excluded,interpreted?{rawAnswers:{native:true}}:null]);
  return id;
}
async function job(observation,{status="queued",kind="interpret",createdMinutes=10,finishedMinutes=null}={}) {
  const id=randomUUID();
  await db.query(`insert into intelligence_jobs values($1,$2,$3,$4,now()-make_interval(mins=>$5),
    case when $6::integer is null then null else now()-make_interval(mins=>$6) end)`,[id,observation,kind,status,createdMinutes,finishedMinutes]);
  return id;
}
try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table companies(id uuid primary key,lists text[],status text,netsuite_internal_id text);
    create table intelligence_observations(id uuid primary key,company_id uuid,is_current boolean,feedback_excluded boolean,attributes jsonb);
    create table intelligence_jobs(id uuid primary key,observation_id uuid,kind text,status text,created_at timestamptz,finished_at timestamptz);
    create table intelligence_directed_research_jobs(company_id uuid primary key,status text,due_at timestamptz,result jsonb,caught_up_at timestamptz);`);
  await db.exec(await readFile(new URL("../../supabase/migrations/0110_intelligence_research_progress.sql",import.meta.url),"utf8"));
  await db.exec("alter function intelligence_research_progress() rename to intelligence_research_progress_baseline");
  await db.exec(await readFile(new URL("../../supabase/migrations/0111_intelligence_research_progress_aggregate.sql",import.meta.url),"utf8"));
  await test("empty scope reports zero work rather than unavailable or null counts",async()=>{
    const value=await progress();
    assert.equal(value.available,true);assert.equal(value.scope,"eligible_tam");assert.ok(Number.isFinite(Date.parse(value.asOf)));
    assert.ok(Object.values(value.accounts).every(count=>count===0));
    assert.deepEqual(value.processing,{pending:0});assert.deepEqual(value.lastHour,{newInterpretationJobs:0,completedInterpretationJobs:0});
  });
  await test("only current exact-ID TAM accounts enter coverage and processing totals",async()=>{
    const eligible=await account(); await observation(eligible,{interpreted:true});
    await account();
    for(const input of [{lists:[]},{lists:["netsuite_tam","tam_duplicate"]},{status:"removed_from_tam"},{internalId:"not-an-id"},{internalId:null}]) {
      const excluded=await account({...input,researchStatus:"running"}); const obs=await observation(excluded,{interpreted:true}); await job(obs);
    }
    const value=await progress();assert.equal(value.accounts.total,2);assert.equal(value.accounts.withEvidence,1);assert.equal(value.accounts.withInterpretation,1);
    assert.equal(value.accounts.researchRunning,0);assert.equal(value.processing.pending,0);assert.equal(value.lastHour.newInterpretationJobs,0);
  });
  await test("caught-up discovery cannot hide queued, running, failed, missing or unfinished interpretation",async()=>{
    const good=await account({researchStatus:"complete"});const goodObs=await observation(good,{interpreted:true});await job(goodObs,{status:"complete",finishedMinutes:5});
    for(const status of ["queued","running","failed","complete",null]) {
      const id=await account({researchStatus:"complete"});const obs=await observation(id);
      if(status) await job(obs,{status,finishedMinutes:status==="complete"?5:null});
    }
    const value=await progress();
    assert.equal(value.accounts.total,6);assert.equal(value.accounts.caughtUp,1);
    assert.equal(value.accounts.awaitingInterpretation,2);assert.equal(value.accounts.blockedInterpretation,3);assert.equal(value.processing.pending,2);
  });
  await test("failed new work remains visible even if older native attributes exist",async()=>{
    const id=await account({researchStatus:"complete"});const obs=await observation(id,{interpreted:true});await job(obs,{status:"failed"});
    const value=await progress();assert.equal(value.accounts.withInterpretation,1);assert.equal(value.accounts.blockedInterpretation,1);assert.equal(value.accounts.caughtUp,0);
  });
  await test("rejected and retired evidence does not create coverage, pending or blocked debt",async()=>{
    const id=await account({researchStatus:"complete"});
    for(const options of [{excluded:true},{current:false}]) {
      const obs=await observation(id,options);await job(obs);await job(obs,{status:"failed"});
    }
    const value=await progress();assert.equal(value.accounts.withEvidence,0);assert.equal(value.accounts.withInterpretation,0);
    assert.equal(value.accounts.caughtUp,1);assert.equal(value.accounts.awaitingInterpretation,0);assert.equal(value.accounts.blockedInterpretation,0);assert.equal(value.processing.pending,0);
  });
  await test("source and discovery status counts distinguish due work, retries, active work and failure",async()=>{
    await account({researchStatus:"queued",outcome:"refreshed",dueMinutes:5});
    await account({researchStatus:"queued",outcome:"waiting_retry",dueMinutes:-60});
    await account({researchStatus:"running"});
    await account({researchStatus:"failed"});
    await account({researchStatus:"complete",dueMinutes:5});
    const value=await progress();
    assert.equal(value.accounts.researchReady,1);assert.equal(value.accounts.sourceRetry,1);assert.equal(value.accounts.researchRunning,1);
    assert.equal(value.accounts.researchFailed,1);assert.equal(value.accounts.discoveryCheckDue,1);assert.equal(value.accounts.caughtUp,1);
  });
  await test("last-hour arrivals and completions use separate clocks, eligible accounts and interpretation jobs",async()=>{
    const id=await account(),obs=await observation(id,{interpreted:true});
    await job(obs,{status:"queued",createdMinutes:5});
    await job(obs,{status:"complete",createdMinutes:120,finishedMinutes:5});
    await job(obs,{status:"complete",createdMinutes:5,finishedMinutes:5});
    await job(obs,{status:"complete",createdMinutes:120,finishedMinutes:120});
    await job(obs,{kind:"view",status:"complete",createdMinutes:5,finishedMinutes:5});
    for(const input of [{status:"removed_from_tam"},{lists:[]},{lists:["netsuite_tam","tam_duplicate"]}]) {
      const other=await account(input),oldObs=await observation(other,{interpreted:true});
      await job(oldObs,{status:"complete",createdMinutes:5,finishedMinutes:5});
    }
    assert.deepEqual((await progress()).lastHour,{newInterpretationJobs:2,completedInterpretationJobs:2});
  });
  await test("progress is read-only and the RPC is available only to service role",async()=>{
    const id=await account({researchStatus:"complete"});const obs=await observation(id,{interpreted:true});await job(obs,{status:"complete",finishedMinutes:5});
    const before=await scalar("select jsonb_agg(to_jsonb(j)) from intelligence_jobs j");
    for(const role of ["anon","authenticated"]) {
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_research_progress()','EXECUTE')",[role]),false);
      await db.exec(`set role ${role}`);await assert.rejects(progress(),/permission denied/);await db.exec("reset role");
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_research_progress()','EXECUTE')"),true);
    await db.exec("set role service_role");assert.equal((await progress()).accounts.caughtUp,1);await db.exec("reset role");
    assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(j)) from intelligence_jobs j"),before);
  });
  if(process.argv.includes("--large")) {
    await db.exec(`truncate companies,intelligence_observations,intelligence_jobs,intelligence_directed_research_jobs;
      insert into companies select md5('company:'||g)::uuid,array['netsuite_tam'],'new',g::text from generate_series(1,7441) g;
      insert into intelligence_observations select md5('observation:'||g)::uuid,md5('company:'||((g-1)%7441+1))::uuid,
        g%5<>0,g%29=0,case when g%7=0 then null else '{"native":true}'::jsonb end from generate_series(1,100000) g;
      insert into intelligence_jobs select md5('job:'||g)::uuid,md5('observation:'||g)::uuid,'interpret',
        case when g%13=0 then 'failed' when g%7=0 then 'running' when g%5=0 then 'queued' else 'complete' end,
        now()-case when g%11=0 then interval '2 hours' else interval '20 minutes' end,
        now()-case when g%17=0 then interval '2 hours' else interval '10 minutes' end from generate_series(1,100000) g;
      insert into intelligence_directed_research_jobs select id,'complete',now()+interval '1 day','{"outcome":"caught_up"}',now() from companies;
      analyze;`);
    let baseline=null,baselineMs=null;
    const baselineStarted=performance.now();
    await db.exec("set statement_timeout='5s'");
    try { baseline=await scalar("select intelligence_research_progress_baseline()");baselineMs=Math.round(performance.now()-baselineStarted); }
    catch(error) { if(!/statement timeout|canceling statement/i.test(error.message)) throw error; }
    const optimizedStarted=performance.now();
    const optimized=await scalar("select intelligence_research_progress()");
    const optimizedMs=Math.round(performance.now()-optimizedStarted);
    if(baseline) { delete baseline.asOf;const comparable={...optimized};delete comparable.asOf;assert.deepEqual(comparable,baseline); }
    assert.equal(optimized.accounts.total,7441);assert.equal(optimized.lastHour.newInterpretationJobs,90910);
    console.log(JSON.stringify({scaleCheck:{accounts:7441,observations:100000,jobs:100000,baselineMs,baselineTimedOut:baseline===null,optimizedMs}}));
  }
  console.log(`${passed} research-progress PostgreSQL checks passed`);
} catch(error) { console.error(error.message,error.detail??"",error.where??"");process.exitCode=1; }
finally { await db.close(); }
