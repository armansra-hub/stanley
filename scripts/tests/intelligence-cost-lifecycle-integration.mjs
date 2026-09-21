/** Apply 0107-0110 together over the real earlier intelligence schema/functions.
 * Entirely local PGlite; no vendor, network, production or simulated model calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal=createRequire(new URL("../../work/intelligence-sql-test/package.json",import.meta.url));
const {PGlite}=requireLocal("@electric-sql/pglite");
const db=await PGlite.create("memory://");
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const migration=async file=>db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));
let passed=0;
async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}
async function company(name){const id=randomUUID();await db.query(`insert into companies(id,name,status,lists,netsuite_internal_id,domain,subindustry)
  values($1,$2,'new',array['netsuite_tam'],'1234','example.test','Management Consulting')`,[id,name]);return id;}
const text="Complete unchanged company evidence.";
const criteria=["project_delivery","multi_entity","multi_location"];
const ordinary={retainedCharacters:text.length,companyName:"Monitored",companyDomain:"example.test",
  researchCriteria:criteria,researchCriteriaBasis:"worker-operating-criteria-v1",researchCriteriaSubindustry:"Management Consulting",researchCriteriaModel:"jev-1.13.0"};
const native={analyzedCharacters:text.length,retainedCharacters:text.length,
  packetFindings:[{start:0,end:text.length,model:"jev-1.13.0",questionVersion:"stanley-business-services-v4",
    criteria:Object.fromEntries(criteria.map(id=>[id,0]))}]};
const observe=(id,metadata=ordinary)=>scalar(`select intelligence_observe($1,'source','website','https://example.test/','Unchanged heading',
  $2,'unchanged-document',null,now(),$3,'[]','evidence-v2')`,[id,text,metadata]);
try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,
      subindustry text,ns_industry text,city text,state text,is_base boolean,claimable boolean);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);
    create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],
      verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
  for(const file of ["0059_intelligence_evidence_and_work.sql","0061_intelligence_operating_topic_search.sql",
    "0062_intelligence_feedback_and_research.sql","0067_intelligence_directed_research_queue.sql",
    "0071_collection_repair.sql","0074_directed_research_discovery.sql","0075_fresh_intelligence_priority.sql",
    "0081_intelligence_document_discoveries.sql","0105_intelligence_reuse_answered_topics.sql"]) await migration(file);
  // Added by the existing broader-research migration; unrelated contract tables
  // from that migration are intentionally outside this focused scaffold.
  await db.exec("alter table intelligence_research_sources add column metadata jsonb not null default '{}'; update intelligence_config set enabled=true");
  const active=await company("Active worker");
  const beforeObservation=await observe(active);
  const [beforeJob]=await rows("select * from intelligence_claim(1)");
  const [beforeSource]=await scalar("select intelligence_research_claim($1,array['https://example.test/'])",[active]);
  for(const file of ["0107_intelligence_research_caught_up.sql","0108_intelligence_coverage_priority.sql",
    "0109_intelligence_symmetric_answer_reuse.sql","0110_intelligence_research_progress.sql"]) await migration(file);

  await check("all four migrations compose without replacing active job or URL ownership",async()=>{
    const [job]=await rows("select * from intelligence_jobs where id=$1",[beforeJob.id]);
    assert.equal(job.lease_token,beforeJob.lease_token);assert.equal(job.status,"running");assert.equal(job.observation_id,beforeObservation.id);
    assert.equal(await scalar("select lease_token from intelligence_research_attempts where company_id=$1",[active]),beforeSource.lease_token);
    assert.equal(await scalar("select context_revision from intelligence_directed_research_jobs where company_id=$1",[active]),0);
    assert.equal((await scalar("select intelligence_research_progress()")).accounts.awaitingInterpretation,1);
  });
  const monitored=await company("Monitored");
  const first=await observe(monitored,{...ordinary,researchTopics:["multi_entity"]});
  await check("replacement interpretation claim and existing finish RPC publish the same native packet",async()=>{
    const claimed=await rows("select * from intelligence_claim(3)");
    assert.equal(claimed.length,1);assert.equal(claimed[0].observation_id,first.id);
    assert.equal(await scalar("select intelligence_finish($1,$2,'complete','{}',$3,'evidence-v2')",[claimed[0].id,claimed[0].lease_token,native]),true);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1",[first.id]),native);
  });
  await check("ordinary capture reuses completed directed evidence across the full migration chain",async()=>{
    const repeated=await observe(monitored);assert.equal(repeated.id,first.id);assert.equal(repeated.queued,false);
    assert.equal(await scalar("select count(*) from intelligence_jobs where observation_id=$1",[first.id]),1);
    assert.equal(await scalar("select count(*) from intelligence_observation_discoveries where observation_id=$1",[first.id]),2);
  });
  await check("directed completion feeds honest caught-up progress while active interpretation remains pending",async()=>{
    const claimed=await rows("select * from intelligence_directed_claim(3)");const done=claimed.find(row=>row.company_id===monitored);assert.ok(done);
    assert.equal(await scalar("select intelligence_directed_finish($1,$2,$3,'complete',86400,$4,null)",
      [monitored,done.lease_token,done.desired_hash,{outcome:"caught_up",sweep:{knownSources:1,unreadSources:0,dueSources:0,leasedSources:0,retrySources:0}}]),true);
    const progress=await scalar("select intelligence_research_progress()");
    assert.equal(progress.accounts.total,2);assert.equal(progress.accounts.caughtUp,1);assert.equal(progress.accounts.awaitingInterpretation,1);
    assert.equal(progress.accounts.blockedInterpretation,0);assert.equal(progress.lastHour.completedInterpretationJobs,1);
  });
  await check("a real company context change advances the epoch and wakes one new exact evidence version",async()=>{
    await db.query("update companies set city='New City' where id=$1",[monitored]);
    assert.equal(await scalar("select context_revision from intelligence_directed_research_jobs where company_id=$1",[monitored]),1);
    const changed=await observe(monitored);assert.notEqual(changed.id,first.id);assert.equal(changed.queued,true);
    assert.equal(await scalar("select metadata->>'accountContextRevision' from intelligence_observations where id=$1",[changed.id]),"1");
    const duplicate=await observe(monitored);assert.equal(duplicate.id,changed.id);assert.equal(duplicate.queued,false);
    assert.equal((await scalar("select intelligence_research_progress()")).accounts.caughtUp,0);
    assert.equal((await rows("select * from intelligence_claim(3)"))[0].observation_id,changed.id);
  });
  await check("source leases still finish through the replaced RPC and normal source rotation remains callable",async()=>{
    assert.equal(await scalar("select intelligence_research_finish($1,$2,$3,'unchanged')",[active,beforeSource.source_url,beforeSource.lease_token]),true);
    const selected=await rows("select * from reserve_company_rotation('site',2,date_trunc('hour',now()),'claimable')");
    assert.deepEqual(new Set(selected.map(row=>row.id)),new Set([active,monitored]));
    assert.equal(await scalar("select has_function_privilege('anon','intelligence_research_progress()','EXECUTE')"),false);
  });
  console.log(`${passed} integrated lifecycle PostgreSQL checks passed`);
}catch(error){console.error(error.message,error.detail??"",error.where??"",error.internalQuery??"");process.exitCode=1;}
finally{await db.close();}
