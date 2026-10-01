/** Disposable PGlite only; no cloud, network or provider requests. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const { PGlite } = createRequire(process.env.STANLEY_SQL_TEST_PACKAGE ?? new URL("../../work/intelligence-sql-test/package.json",import.meta.url))("@electric-sql/pglite");
const db=await PGlite.create("memory://");
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
const migrate=async name=>db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),"utf8"));
let passed=0;
const check=async(name,fn)=>{await fn();console.log(`PASS ${name}`);passed++;};
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
 description text,record_dead boolean,ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
 signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,subindustry text,ns_industry text,city text,state text,is_base boolean,claimable boolean);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb,type text,summary text,source_name text,source_url text,signal_date timestamptz);
 create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
 for(const name of ["0059_intelligence_evidence_and_work.sql","0061_intelligence_operating_topic_search.sql","0062_intelligence_feedback_and_research.sql",
 "0067_intelligence_directed_research_queue.sql","0071_collection_repair.sql","0074_directed_research_discovery.sql","0075_fresh_intelligence_priority.sql",
 "0081_intelligence_document_discoveries.sql","0105_intelligence_reuse_answered_topics.sql"])await migrate(name);
 await db.exec(`alter table intelligence_research_sources add column metadata jsonb not null default '{}';
 create table intelligence_account_question_jobs(view_id uuid references intelligence_views(id),company_id uuid references companies(id),revision bigint default 1,running_revision bigint,status text default 'queued',due_at timestamptz default now(),lease_token uuid,lease_until timestamptz,checkpoint jsonb,last_error text,updated_at timestamptz default now(),primary key(view_id,company_id));
 create function intelligence_account_question_claim() returns jsonb language sql as $$select null::jsonb$$;`);
 for(const name of ["0082_jev_request_receipts.sql","0089_intelligence_visibility.sql","0090_native_jev_purposes.sql","0096_intelligence_exploration_cache.sql","0107_intelligence_research_caught_up.sql","0108_intelligence_coverage_priority.sql",
 "0109_intelligence_symmetric_answer_reuse.sql","0112_intelligence_worker_capacity.sql","0117_jev_global_budget_policy.sql","0119_intelligence_catalog_coverage.sql",
 "0123_jev_provider_balance_mode.sql","0127_intelligence_catalog_completion_priority.sql","0128_customer_reference_matches.sql",
 "0131_private_customer_reference_registry.sql"])await migrate(name);
 if(process.argv[2]==="--bundle") await db.exec(await readFile(process.argv[3],"utf8"));
 else for(const name of ["0134_jev_classifier_purpose_policy.sql","0135_customer_research_profiles.sql",
  "0140_customer_catalog_runtime.sql","0141_customer_criteria_readers.sql","0142_customer_business_scope_proofs.sql"])await migrate(name);
 const company=randomUUID(), originalHash="a".repeat(64),proofHash="b".repeat(64);
 await db.query("insert into companies(id,name,status,lists,netsuite_internal_id,domain) values($1,'Synthetic','new',array['netsuite_tam'],'1234','synthetic.test')",[company]);
 await scalar("select intelligence_customer_reference_import($1)",[[{id:"customer",name:"Synthetic Customer",domain:"customer.test",website:"https://customer.test/",
  announcementDate:"2026-09-01",announcementType:"new_customer",asOf:"2026-09-30",announcements:[{id:"announcement",date:"2026-09-01",type:"new_customer"}],candidateUrls:[],identityNotes:[]}]]);
 const registry=await scalar("select to_jsonb(r) from intelligence_customer_reference_registry r where id='customer'");
 const proof={schema:"customer-research-proof-v2",customerId:"customer",name:registry.name,announcementIds:["announcement"],sourceStorage:"private_local_full_text",
  author:{kind:"codex"},status:"in_progress",fullProfileSha256:originalHash,proofSha256:proofHash,sources:[],facts:[],criterionBindings:[],
  businessScope:{status:"scope_complete",profileSha256:originalHash,wholeSiteStatus:"in_progress",receipt:{sha256:"c".repeat(64)},acceptedScope:"Finite business pages",closedAt:"2026-09-30T00:00:00Z"},
  validation:{kind:"local_full_text_hash_and_utf16_validation"},mapping:{customerId:"customer",profileSha256:originalHash,scopeStatus:"business_scope_review_closed",matches:[]},coverage:{read:0,pending:1,unread:0,unavailable:0}};
 await check("v2 finite scope remains separate from whole-site status and enforces exact CAS",async()=>{
  assert.equal((await scalar("select intelligence_customer_research_scope_put($1,null,$2)",[proof,registry.updated_at])).unchanged,false);
  assert.equal((await scalar("select intelligence_customer_research_scope_put($1,null,$2)",[proof,registry.updated_at])).unchanged,true);
  await assert.rejects(()=>scalar("select intelligence_customer_research_scope_put($1,null,$2)",[{...proof,proofSha256:"d".repeat(64)},registry.updated_at]),/write conflict/);
  const progress=await scalar("select intelligence_customer_research_progress()");
  assert.equal(progress.businessScopeComplete,1);assert.equal(progress.inProgress,1);assert.equal(progress.complete,0);
 });
 const make=(version,suffix="a")=>({version,dictionary:{schema:"customer-approved-catalog-v1",version,status:"approved",
  cohortProof:{cohortCount:1,accountedForCount:1,customers:[{customerId:"customer",profileSha256:originalHash,proofSha256:proofHash}]},
  facets:[{id:"test-one",definitionVersion:"one"},{id:"test-two",definitionVersion:suffix}],industryContextDefinitions:[{id:"G01"}]},
  facets:[{facetId:"test-one",facetVersion:"1".repeat(64),wireId:"cf_one",kind:"criterion"},
   {facetId:"test-two",facetVersion:suffix.repeat(64),wireId:"cf_two",kind:"criterion"},
   {facetId:"industry_context_G01",facetVersion:"3".repeat(64),wireId:"industry_context_G01",kind:"industry_context"}]});
 const one=make("fixture-catalog-one"),two=make("fixture-catalog-two","c");
 const register=c=>scalar("select intelligence_catalog_register($1,$2,$3)",[c.version,c.dictionary,c.facets]);
 await check("installation has no paid activation, selection or queue admission",async()=>{
  assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),false);
  assert.equal(await scalar("select selected_catalog_version from intelligence_config"),null);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_accounts"),0);
 });
 await check("registered dictionary is immutable and complete cohort is mandatory",async()=>{
  assert.equal((await register(one)).unchanged,false);assert.equal((await register(one)).unchanged,true);
  await assert.rejects(()=>register({...one,dictionary:{...one.dictionary,changed:true}}),/immutable_catalog_conflict/);
  const bad=make("bad-cohort");bad.dictionary.cohortProof.accountedForCount=0;
  await assert.rejects(()=>register(bad),/invalid_catalog_dictionary/);
  const stale=make("stale-cohort");stale.dictionary.cohortProof.customers[0].proofSha256="0".repeat(64);
  await assert.rejects(()=>register(stale),/catalog_cohort_changed_or_unfinished/);
  await register(two);
 });
 await check("selection never changes paid policy and admits nothing",async()=>{
  const priorJobs=await scalar("select count(*)::int from intelligence_directed_research_jobs");
  assert.equal((await scalar("select intelligence_catalog_select($1)",[one.version])).jobsAdmitted,0);
  assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),false);
  assert.equal(await scalar("select count(*)::int from intelligence_directed_research_jobs"),priorJobs);
  assert.equal((await scalar("select intelligence_catalog_dictionary_get(null)")).version,one.version);
 });
 await db.exec("update intelligence_config set enabled=true,catalog_mode='rollout'");
 const observation=await scalar("select intelligence_observe($1,'site','website','https://synthetic.test/','Services','Retained full source','source-hash',null,now(),'{}','[]','evidence-v2')",[company]);
 await check("only selected registered dictionaries enter the existing queue",async()=>{
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,two.version]),false);
  await assert.rejects(()=>scalar("select intelligence_catalog_admit($1,'invented-version')",[company]),/catalog_not_registered/);
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,one.version]),true);
  assert.equal((await rows("select * from intelligence_directed_claim(1)")).length,0);
 });
 // Fixture-only authorization permits testing leases; no native transport exists here.
 await db.exec("update intelligence_jev_budget_policy set enabled=true");
 const job=(await rows("select * from intelligence_directed_claim(1)"))[0];assert(job);
 const snap=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,job.lease_token,one.version]);
 const checkpoint={version:"account-operating-coverage-v2",catalogVersion:one.version,evidenceKey:snap.evidenceKey};
 const citation={observationId:observation.id,contentHash:"source-hash",start:0,end:20,url:"https://synthetic.test/"};
 const answers=one.facets.map((f,index)=>({facetId:f.facetId,facetVersion:f.facetVersion,status:"answered",decision:index===1?"insufficient_evidence":"supported",
  nativeResult:{questionId:f.facetId,wireQuestionId:f.wireId,answer:{type:"choice",choice:index===1?"unknown":"supported",extra:"native preserved"}},
  citations:[citation],requestFingerprints:["original-receipt"]}));
 const save=(facets=answers,status="complete",terminal=false)=>scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,$6,$7,$8,null)",
  [company,job.lease_token,one.version,snap.evidenceKey,checkpoint,facets,{status},terminal]);
 await check("complete publication requires the exact criterion and context set",async()=>{
  await assert.rejects(()=>save(answers.slice(0,2)),/exact_native_set/);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_facets"),0);
  await assert.rejects(()=>save([{...answers[0],facetVersion:"f".repeat(64)}],"running"),/invalid_catalog_facets/);
  await assert.rejects(()=>save([answers[0],answers[0]],"running"),/invalid_catalog_facets/);
  await assert.rejects(()=>save([{...answers[0],decision:"not_supported"}],"running"),/invalid_catalog_native_result/);
  assert.equal(await save(),true);
  assert.deepEqual((await rows("select total_count,answered_count,context_total_count,context_answered_count from intelligence_catalog_accounts"))[0],
   {total_count:2,answered_count:2,context_total_count:1,context_answered_count:1});
  assert.equal(await scalar("select native_result->'answer'->>'choice' from intelligence_catalog_facets where facet_id='test-two'"),"unknown");
 });
 const versions=Object.fromEntries(one.facets.map(f=>[f.facetId,f.facetVersion]));
 const candidates=()=>scalar("select intelligence_customer_match_candidates($1,$2,false)",[one.version,versions]);
 const evidence=()=>scalar("select intelligence_customer_match_evidence($1,$2,$3)",[[{companyId:company,facets:["test-one"]}],one.version,versions]);
 const topics=ids=>scalar("select intelligence_catalog_topic_search($1,$2,$3)",[ids,one.version,versions]);
 await check("dynamic readers expose two visible criteria plus exact provider-industry evidence",async()=>{
  assert.deepEqual((await candidates()).accounts[0].industryIds,["G01"]);
  assert.equal((await candidates()).accounts[0].decisions['test-two'],"insufficient_evidence");
  assert.equal((await evidence())[0].catalogFacets[0].nativeResult.answer.extra,"native preserved");
  const found=await topics(["test-one"]);assert.equal(found.accounts.length,1);assert.equal(found.catalogCoverage.publicFacets,2);
  assert.deepEqual(Object.keys(found.topicCounts).sort(),["test-one","test-two"]);
  await assert.rejects(()=>topics(["industry_context_G01"]),/Invalid operating catalog query/);
  await assert.rejects(()=>scalar("select intelligence_customer_match_candidates($1,$2,false)",[one.version,{...versions,'test-one':'f'.repeat(64)}]),/version mismatch/);
 });
 await check("selection cannot silently replace an in-flight leased dictionary",async()=>{
  await scalar("select intelligence_catalog_select($1)",[two.version]);
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,two.version]),false);
  assert((await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,job.lease_token,one.version])).evidenceKey);
  assert.equal(await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,job.lease_token,two.version]),null);
  assert.equal(await save([],"complete",true),true);
 });
 await check("new catalog mirrors preserve old native answers and account history",async()=>{
  assert.equal(await scalar("select intelligence_catalog_admit($1,$2)",[company,two.version]),true);
  const next=(await rows("select * from intelligence_directed_claim(1)"))[0];
  const nextSnap=await scalar("select intelligence_catalog_snapshot($1,$2,$3)",[company,next.lease_token,two.version]);
  const pending=two.facets.map(f=>({facetId:f.facetId,facetVersion:f.facetVersion,status:"pending"}));
  assert.equal(await scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,$6,$7,false,null)",
   [company,next.lease_token,two.version,nextSnap.evidenceKey,{...checkpoint,catalogVersion:two.version},pending,{status:"running"}]),true);
  assert.equal(await scalar("select count(*)::int from intelligence_catalog_read_facets where catalog_version=$1 and native_result->'answer'->>'extra'='native preserved'",[one.version]),3);
  assert.equal(await scalar("select answered_count from intelligence_catalog_read_accounts where company_id=$1 and catalog_version=$2",[company,one.version]),2);
  assert.equal((await evidence())[0].catalogFacets.length,1);
  assert.equal((await topics(["test-one"])).accounts.length,1);
  await db.query("update intelligence_observations set feedback_excluded=true where id=$1",[observation.id]);
  assert.equal(await scalar("select intelligence_catalog_checkpoint($1,$2,$3,$4,$5,'[]','{}',false,null)",
   [company,next.lease_token,two.version,nextSnap.evidenceKey,{...checkpoint,catalogVersion:two.version}]),false);
  assert.equal((await evidence())[0].catalogFacets.length,0);
  assert.equal((await topics(["test-one"])).accounts.length,0);
  assert.equal((await candidates()).accounts[0].industryIds,null);
 });
 await check("dictionary/history writes are RPC-only and paid pause remains separate",async()=>{
  assert.equal(await scalar("select has_table_privilege('service_role','intelligence_catalog_dictionaries','UPDATE')"),false);
  assert.equal(await scalar("select has_table_privilege('anon','intelligence_catalog_facet_history','SELECT')"),false);
  await db.exec("update intelligence_jev_budget_policy set enabled=false");
  await scalar("select intelligence_catalog_select(null)");
  assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),false);
 });
 console.log(`PASS ${passed} customer catalog SQL checks; provider calls 0`);
} finally {await db.close();}
