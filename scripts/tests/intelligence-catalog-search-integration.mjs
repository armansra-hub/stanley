/** Disposable PGlite cached-search checks against real0117/0119/0120 and their actual source/visibility prerequisites. No production/provider IO. */
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
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb,detected_at timestamptz);
 create table intelligence_story_jobs(company_id uuid,status text);
 create table intelligence_account_stories(company_id uuid);
 create table intelligence_ats_boards(company_id uuid,last_complete_at timestamptz);
 create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
 for(const name of ["0059_intelligence_evidence_and_work.sql","0061_intelligence_operating_topic_search.sql","0062_intelligence_feedback_and_research.sql",
 "0067_intelligence_directed_research_queue.sql","0071_collection_repair.sql","0073_intelligence_metrics_repair.sql","0074_directed_research_discovery.sql","0075_fresh_intelligence_priority.sql",
 "0081_intelligence_document_discoveries.sql","0105_intelligence_reuse_answered_topics.sql"])await migrate(name);
 await db.exec(`alter table intelligence_research_sources add column metadata jsonb not null default '{}';
 create table intelligence_account_question_jobs(view_id uuid references intelligence_views(id),company_id uuid references companies(id),revision bigint default1,running_revision bigint,status text default 'queued',due_at timestamptz default now(),lease_token uuid,lease_until timestamptz,checkpoint jsonb,last_error text,updated_at timestamptz default now(),primary key(view_id,company_id));
 create function intelligence_account_question_claim() returns jsonb language sql as $$select null::jsonb$$;`.replace("default1","default 1"));
 for(const name of ["0082_jev_request_receipts.sql","0089_intelligence_visibility.sql","0090_native_jev_purposes.sql","0096_intelligence_exploration_cache.sql","0107_intelligence_research_caught_up.sql","0108_intelligence_coverage_priority.sql","0109_intelligence_symmetric_answer_reuse.sql","0112_intelligence_worker_capacity.sql","0116_intelligence_topic_dismiss_and_3pl.sql","0117_jev_global_budget_policy.sql","0119_intelligence_catalog_coverage.sql","0120_intelligence_catalog_topic_search.sql"])await migrate(name);

 const version="synthetic-catalog-v1";
 const versions=Object.fromEntries(ids.map(id=>[id,"exact-"+id]));
 const text="Synthetic 🙂 public retained evidence for equipment installation, continuing service and transportation.";
 const query=async(topics, options={})=>scalar("select intelligence_catalog_topic_search($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  [topics,options.version??version,options.versions??versions,options.after??null,options.limit??8,options.mode??"all",options.showHidden??false,options.visibility??"supported",options.combinations??null]);
 const attributes=topics=>({companyRelationship:"direct",companyRelevance:.99,topicEvidence:topics.map(([topic,probability])=>({topic,probability,start:0,end:text.length}))});
 await db.exec("update intelligence_config set enabled=true,catalog_mode='rollout'");
 const companies={};
 for(const [i,name] of ["Native","Fleet","Hidden","Legacy","Unassessed","Duplicate","Removed","InvalidId"].entries()) {
  companies[name]=await createCompany("Synthetic "+name);
  await db.query("update companies set netsuite_internal_id=$2 where id=$1",[companies[name],String(2000+i)]);
 }
 const observations={}, citations={};
 for(const name of ["Native","Fleet","Hidden","Legacy","Duplicate","Removed","InvalidId"]) {
  const result=await scalar("select intelligence_observe($1,$2,'website',$3,'Synthetic source',$4,$5,null,now(),'{}','[]','evidence-v2')",
   [companies[name],"source-"+name,"https://synthetic.test/"+name.toLowerCase(),text,"hash-"+name]);
  observations[name]=result.id;
  const topics=name==="Native"?[["project_delivery",.93],["multi_entity",.65]]:[["project_delivery",.94]];
  await db.query("update intelligence_observations set attributes=$2 where id=$1",[result.id,attributes(topics)]);
  citations[name]={observationId:result.id,url:"https://synthetic.test/"+name.toLowerCase(),title:"Synthetic source",sourceKind:"website",eventDate:null,
   observedAt:"2026-09-24T00:00:00Z",contentHash:"hash-"+name,sourceTruncated:false,start:0,end:text.length};
 }
 await db.query("update companies set lists=array['netsuite_tam','tam_duplicate'] where id=$1",[companies.Duplicate]);
 await db.query("update companies set status='removed_from_tam' where id=$1",[companies.Removed]);
 await db.query("update companies set netsuite_internal_id='not-an-id' where id=$1",[companies.InvalidId]);
 const seed=async(name,supported)=>{
  const company=companies[name];
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,version]),true);
  const lease=randomUUID();
  await db.query("update intelligence_directed_research_jobs set status='running',lease_token=$2,lease_until=now()+interval '3 minutes' where company_id=$1",[company,lease]);
  const snapshot=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,lease,version]);
  const checkpoint={version:"account-operating-coverage-v1",catalogVersion:version,evidenceKey:snapshot.evidenceKey,phase:"direct",mapped:{},receipts:[]};
  const answers=ids.map(id=>({facetId:id,facetVersion:versions[id],status:"answered",decision:supported.includes(id)?"supported":"insufficient_evidence",
   probability:id==="rr_c02"?.51:null,nativeResult:{answer:{type:"choice",choice:supported.includes(id)?"supported":"insufficient_evidence",
    confidence:id==="rr_c02"?.51:.91},model:"synthetic-native"},citations:[citations[name]],requestFingerprints:["synthetic-receipt"]}));
  assert.equal(await scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,$6,$7,true,null)",
   [company,lease,version,snapshot.evidenceKey,checkpoint,answers,{status:"complete",retainedCharacters:text.length,processedCharacters:text.length}]),true);
 };
 await seed("Native",["rr_c01","rr_c02","rr_t01","rr_t04"]);
 await seed("Fleet",["rr_c01","rr_t02","rr_t04"]);
 await seed("Hidden",["rr_c01"]);
 await db.query("update companies set status='dismissed' where id=$1",[companies.Hidden]);

 await check("native facets hydrate normalized citation sets once per displayed source",async()=>{
  const result=await query(["rr_c01","rr_c02","project_delivery"]);
  assert.deepEqual(result.accounts.map(a=>a.companyId),[companies.Native]);
  assert.equal(result.accounts[0].observations.length,1);
  assert.equal(result.accounts[0].observations[0].id,observations.Native);
  assert.equal(result.accounts[0].observations[0].evidence_text,text);
  const facet=result.accounts[0].catalogFacets.find(f=>f.id==="rr_c02");
  assert.equal(facet.decision,"supported");assert.equal(facet.probability,.51);
  assert.equal(facet.nativeResult.answer.confidence,.51);
  assert.deepEqual(facet.citations,[citations.Native]);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_citation_sets"),3);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets where citations='[]' and citation_set_key is not null"),141);
 });
 await check("exact catalog and facet-version maps gate results and completion counts",async()=>{
  const result=await query(["rr_c01"],{versions:{...versions,rr_c01:"changed-definition-or-model"}});
  assert.equal(result.accounts.length,0);assert.equal(result.topicCounts.rr_c01,0);
  assert.equal(result.catalogCoverage.complete,0);
  assert.equal(result.catalogCoverage.partial,2);
  const old=await query(["rr_c01"],{version:"old-catalog"});
  assert.equal(old.accounts.length,0);
  assert.equal(old.topicCounts.project_delivery,3);
  assert.equal((await query(["rr_c01"],{versions:{}})).accounts.length,0);
  assert.equal((await query(["rr_c01"])).catalogCoverage.complete,2);
 });
 await check("legacy supported/explore thresholds remain separate from native choices",async()=>{
  assert.equal((await query(["multi_entity"])).accounts.length,0);
  assert.deepEqual((await query(["multi_entity"],{visibility:"explore"})).accounts.map(a=>a.companyId),[companies.Native]);
  for(const visibility of ["supported","explore"]) {
   const result=await query(["rr_c02"],{visibility});
   assert.equal(result.accounts.length,1);assert.equal(result.accounts[0].catalogFacets[0].probability,.51);
  }
  assert.equal((await query(["project_delivery"])).accounts.length,3);
 });
 await check("all/any operate at the company level and count unique accounts",async()=>{
  assert.equal((await query(["rr_c02","rr_t02"])).accounts.length,0);
  assert.equal((await query(["rr_c02","rr_t02"],{mode:"any"})).accounts.length,2);
  assert.equal((await query(["rr_c01","rr_c01"])).accounts.length,2);
  assert.equal((await query(["rr_c01"])).topicCounts.rr_c01,2);
 });
 await check("transport recipe preserves AND branches, OR alternatives and non-asset proof",async()=>{
  const topics=["rr_t01","non_asset_based_3pl","rr_t02","rr_t04"];
  const combinations=[["rr_t01","non_asset_based_3pl","rr_t04"],["rr_t02","rr_t04"]];
  assert.deepEqual((await query(topics,{combinations})).accounts.map(a=>a.companyId),[companies.Fleet]);
  await db.query("update intelligence_observations set attributes=$2 where id=$1",
   [observations.Native,attributes([["project_delivery",.93],["multi_entity",.65],["non_asset_based_3pl",.95]])]);
  const result=await query(topics,{combinations});
  assert.equal(result.accounts.length,2);assert.deepEqual(result.combinations,combinations);
  assert.equal(result.coverage.matchingAccounts,2);
 });
 await check("dismissed reviewed and exported accounts remain recoverable without invalidation",async()=>{
  assert.equal((await query(["rr_c01"])).accounts.length,2);
  assert.equal((await query(["rr_c01"],{showHidden:true})).accounts.length,3);
  for(const status of ["dismissed","reviewed","exported-fixture"]) {
   await db.query("update companies set status=$2 where id=$1",[companies.Native,status]);
   assert.equal((await query(["rr_c01"])).accounts.length,1);
   assert.equal((await query(["rr_c01"],{showHidden:true})).accounts.length,3);
   assert.equal(await scalar("select status from intelligence_catalog_accounts where company_id=$1",[companies.Native]),"complete");
  }
  await db.query("update companies set status='new' where id=$1",[companies.Native]);
  assert.equal((await query(["project_delivery"],{showHidden:true})).accounts.length,4);
  assert.equal((await query(["rr_c01"],{showHidden:true})).catalogCoverage.total,5);
 });
 await check("UUID pagination is stable and counts remain global",async()=>{
  const first=await query(["rr_c01"],{limit:1});
  assert.equal(first.accounts.length,1);assert.equal(first.hasMore,true);assert.equal(first.topicCounts.rr_c01,2);
  assert.equal(first.nextCursor,first.accounts[0].companyId);
  const second=await query(["rr_c01"],{limit:1,after:first.nextCursor});
  assert.equal(second.accounts.length,1);assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
  assert.notEqual(first.accounts[0].companyId,second.accounts[0].companyId);
 });
 await check("paused processing permits cached reads without queue/spend mutations",async()=>{
  await db.exec("update intelligence_config set enabled=false,catalog_mode='off';update intelligence_jev_budget_policy set enabled=false");
  const counts=async()=>({jobs:await scalar("select count(*)::int from intelligence_jobs"),research:await scalar("select count(*)::int from intelligence_directed_research_jobs"),
   receipts:await scalar("select count(*)::int from intelligence_jev_requests"),spend:await scalar("select count(*)::int from intelligence_spend")});
  const before=await counts();
  const result=await query(["rr_c01"]);
  assert.equal(result.enabled,true);assert.equal(result.accounts.length,2);assert.equal(result.coverage.cacheOnly,true);
  assert.deepEqual(await counts(),before);
 });
 await check("bad citation identity/hash is excluded safely without uuid cast failures",async()=>{
  const key=await scalar("select citation_set_key from intelligence_catalog_facets where company_id=$1 and facet_id='rr_c01'",[companies.Native]);
  for(const override of [{contentHash:"wrong-hash"},{observationId:"not-a-uuid"},{observationId:observations.Fleet,contentHash:"hash-Fleet"}]) {
   await db.query("update intelligence_catalog_citation_sets set citations=$2 where citation_set_key=$1",[key,[{...citations.Native,...override}]]);
   assert.equal((await query(["rr_c02"])).accounts.length,0);
  }
  await db.query("update intelligence_catalog_citation_sets set citations=$2 where citation_set_key=$1",[key,[citations.Native]]);
  assert.equal((await query(["rr_c02"])).accounts.length,1);
 });
 await check("source exclusion prevents stale catalog matches",async()=>{
  await db.query("update intelligence_observations set feedback_excluded=true where id=$1",[observations.Native]);
  assert.equal((await query(["rr_c02"])).accounts.length,0);
  assert.equal((await query(["rr_c01"])).accounts.length,1);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets where company_id=$1 and status='stale'",[companies.Native]),47);
 });
 await check("unknown category and malformed query/recipe contracts fail closed",async()=>{
  for(const topics of [["rr_o06"],["unknown"],Array(9).fill("rr_c01"),[null]]) await assert.rejects(()=>query(topics),/Invalid operating catalog query/);
  await assert.rejects(()=>query(["rr_c01"],{combinations:[[]]}),/Invalid recipe/);
  await assert.rejects(()=>query(["rr_c01"],{combinations:[["rr_t02"]]}),/Invalid recipe/);
  await assert.rejects(()=>query(["rr_c01"],{combinations:["rr_c01"]}),/Invalid recipe/);
 });
 console.log(`PASS ${passed} catalog cached-search SQL integration checks`);
} catch(error) {
 console.error(JSON.stringify({name:error.name,code:error.code,message:error.message,detail:error.detail,where:error.where,stack:error.code?undefined:error.stack}));process.exitCode=1;
} finally {await db.close();}
