/** Local PostgreSQL semantics for metrics integrations, including 0092; no live data. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const localRequire = createRequire(new URL('../../work/intelligence-sql-test/package.json', import.meta.url));
const { PGlite } = localRequire('@electric-sql/pglite');
const db = await PGlite.create('memory://');
const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,source_url text,metadata jsonb,detected_at timestamptz default now());`);
  for(const name of ['0059_intelligence_evidence_and_work.sql','0060_intelligence_shared_sources.sql','0061_intelligence_operating_topic_search.sql','0062_intelligence_feedback_and_research.sql','0063_intelligence_event_stories.sql','0065_intelligence_runtime_metrics.sql','0066_intelligence_ats_lifecycle.sql','0067_intelligence_directed_research_queue.sql','0068_intelligence_regional_industry_sources.sql','0069_adaptive_source_revisit.sql','0070_intelligence_story_force_lifecycle.sql','0071_collection_repair.sql','0072_business_services_intelligence.sql','0073_intelligence_metrics_repair.sql','0074_directed_research_discovery.sql']) {
    try { await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')); }
    catch(error) { throw new Error(`${name}: ${error.message}`); }
  }
  console.log('PASS actual migrations 0071/0072/0073/0074 compile with their supporting schema');
  await db.exec('update intelligence_config set enabled=true');
  for(let n=1;n<=6;n++) await db.query(`insert into companies values($1,$2,$3,'example.test','Management Consulting',$4,$5)`,
    [id(n),n===4?'removed_from_tam':'new',`Account ${n}`,String(n),n===5?['netsuite_tam','tam_duplicate']:n===6?[]:['netsuite_tam']]);
  async function source(n,topics,{ago=120,delay=20,current=true,interpreted=true,key=randomUUID(),related=false}={}){
    const observation=randomUUID(),text='Public project delivery context and accounting terms.';
    const attrs={companyRelationship:related?'related':'direct',companyRelevance:.95,topicEvidence:topics.map(topic=>({topic,probability:.95,start:0,end:text.length}))};
    await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,observed_at,interpreted_at,attributes,is_current)
      values($1,$2,$3,'website',$4,'Public source',$5,$1::uuid::text,now()-make_interval(secs=>$6),case when $7 then now()-make_interval(secs=>$6)+make_interval(secs=>$8) else null end,$9,$10)`,
      [observation,id(n),key,`https://example.test/${key}`,text,ago,interpreted,delay,interpreted?attrs:null,current]);return observation;
  }
  await source(1,['project_delivery'],{ago:200000,current:false,key:'homepage'});
  const current=await source(1,['project_delivery'],{ago:120,key:'homepage'});
  await source(1,['project_billing'],{ago:110});
  const peer=await source(2,['project_delivery'],{ago:100});
  await source(2,[],{ago:90,interpreted:false});
  await source(3,[],{ago:80,interpreted:false});
  for(const n of [4,5,6]) await source(n,['project_delivery','project_billing']);
  // A related customer's finance details are deliberately not a trait of this account.
  await source(3,['project_billing'],{related:true});
  const query=(topics=[],mode='all',after=null,limit=8)=>scalar('select intelligence_topic_search($1,$2,$3,$4)',[topics,after,limit,mode]);
  let result=await query();
  assert.equal(result.accounts.length,0);assert.equal(result.topicCounts.project_delivery,2);assert.equal(result.topicCounts.project_billing,1);
  assert.equal(result.topicCounts.inventory,0);assert.equal(Object.keys(result.topicCounts).length,21);
  assert.equal(result.coverage.tamAccounts,3);assert.equal(result.coverage.accountsWithNoInterpretedEvidence,0);
  assert.equal(result.coverage.accountsWithoutSelectedEvidence,null);
  result=await query(['project_delivery','project_billing'],'all');assert.deepEqual(result.accounts.map(a=>a.companyId),[id(1)]);
  result=await query(['project_delivery','project_billing'],'any',null,1);assert.equal(result.hasMore,true);assert.equal(result.nextCursor,id(1));
  result=await query(['project_delivery','project_billing'],'any',result.nextCursor,1);assert.deepEqual(result.accounts.map(a=>a.companyId),[id(2)]);
  assert.equal(result.coverage.accountsWithoutSelectedEvidence,1);
  await assert.rejects(query(['inventory'],'invalid'));await assert.rejects(query(['inventory','inventory','inventory','inventory','inventory','inventory','inventory','inventory','inventory']));
  assert.equal(await scalar("select has_function_privilege('anon','intelligence_topic_search(text[],uuid,integer,text)','EXECUTE')"),false);
  console.log('PASS Any/All, 21 explicit counts, cross-source account matching, unknowns, pagination and service-only grants');
  const excluded = await source(1,[],{ago:300000,current:false,interpreted:false});
  await db.query("insert into intelligence_feedback(company_id,observation_id,reason) values($1,$2,'irrelevant')",[id(1),excluded]);
  // Existing legacy card with retained Jev context counts once as a Jev-bearing card.
  for(const metadata of [{}, {jevFinding:{observationId:current}}, {jevContextFindings:[{finding:{observationId:peer}}]},
    {jevFinding:{observationId:current},stanley_quarantine:{active:true}}, {jevFinding:{observationId:current},quarantine:{reason:'excluded'}},
    {jevFinding:{observationId:excluded}}]) await db.query('insert into triggers(company_id,metadata) values($1,$2)',[id(1),metadata]);
  await db.query('insert into triggers(company_id,metadata) values($1,$2)',[id(4),{jevFinding:{observationId:current}}]);
  await db.query(`insert into intelligence_source_state(company_id,source_key,coverage_status,last_success_at) values
    ($1,'website','partial',now()),($1,'ats:discovery','empty',now()),($2,'ats:discovery','empty',now())`,[id(1),id(2)]);
  await db.query(`insert into intelligence_ats_boards(company_id,source_key,last_complete_at) values($1,'ats:lever:real',now())`,[id(1)]);
  await db.query(`insert into intelligence_jobs(operation_key,observation_id,kind,status,due_at) values('due',$1,'interpret','queued',now()-interval '2 minutes')`,[current]);
  const removedSource=await source(4,[],{interpreted:false});
  await db.query(`insert into intelligence_jobs(operation_key,observation_id,kind,status,due_at) values('removed',$1,'interpret','queued',now()-interval '3 minutes')`,[removedSource]);
  let health=await scalar('select intelligence_health()');
  assert.equal(health.scope,'eligible_tam');assert.equal(health.coverage.tamAccounts,3);assert.equal(health.queue.due,1);
  assert.equal(health.yield.allTriggersLast24h,3);assert.equal(health.yield.jevTriggersLast24h,2);
  assert.equal(health.coverage.accountsFirstCapturedLastHour,2);assert.equal(health.coverage.accountsFirstCapturedLast24h,2);
  assert.equal(health.coverage.sourceChangedLastHour,1);assert.equal(health.coverage.atsSuccess48h,1);
  assert.equal(health.freshness.latestCohort.pending,2);assert.equal(health.freshness.latestCohort.medianSeconds,20);
  assert.equal(health.freshness.latestCohort.captured,6);assert.equal(health.coverage.accountsInterpreted,3);
  assert.equal(await scalar("select has_function_privilege('anon','intelligence_health()','EXECUTE')"),false);
  console.log('PASS TAM queue/account scope, both quarantines, primary/context Jev cards, real ATS completions and historical first-capture breadth');
  await db.exec(await readFile(new URL('../../supabase/migrations/0092_intelligence_contract_health_counts.sql',import.meta.url),'utf8'));
  const retainedBefore=await scalar('select count(*)::int from triggers');
  // Only a boolean true or a string merge target is an explicit exclusion.
  // A malformed/null marker must not silently remove an otherwise visible card.
  for(const metadata of [
    {jevFinding:{observationId:peer},contractTimingInactive:true},
    {jevFinding:{observationId:peer},contractEventMergedInto:id(1)},
    {jevContextFindings:[{}],contractTimingInactive:true,contractEventMergedInto:id(1)},
  ])await db.query('insert into triggers(company_id,metadata) values($1,$2)',[id(2),metadata]);
  for(const metadata of [
    {contractTimingInactive:false},
    {contractTimingInactive:null,contractEventMergedInto:null},
    {jevFinding:{observationId:current},contractTimingInactive:'true'},
    {jevContextFindings:[{}],contractEventMergedInto:false},
  ])await db.query('insert into triggers(company_id,metadata) values($1,$2)',[id(1),metadata]);
  health=await scalar('select intelligence_health()');
  assert.equal(health.yield.allTriggersLast24h,7);assert.equal(health.yield.jevTriggersLast24h,4);
  assert.equal(health.yield.allTriggeredAccountsLast24h,1);assert.equal(health.yield.distinctTriggeredAccountsLast24h,1);
  assert.equal(await scalar('select count(*)::int from triggers'),retainedBefore+7);
  assert.equal(await scalar("select has_function_privilege('anon','intelligence_health()','EXECUTE')"),false);
  console.log('PASS 0092 excludes explicit inactive/merged contract receipts from all-card and Jev-card/account counts while preserving receipts and other JSON marker types');
  // The newest cohort can be entirely pending; never backfill its median from older work.
  await db.exec("update intelligence_observations set observed_at=now()-interval '2 hours',interpreted_at=case when interpreted_at is null then null else now()-interval '2 hours'+interval '20 seconds' end");
  await source(2,[],{ago:1,interpreted:false});health=await scalar('select intelligence_health()');
  assert.equal(health.freshness.latestCohort.captured,1);assert.equal(health.freshness.latestCohort.pending,1);assert.equal(health.freshness.latestCohort.medianSeconds,null);
  assert.equal(health.freshness.medianCaptureToInterpretSeconds,20);
  console.log('PASS newest all-pending cohort has no fabricated latency despite older completed interpretations');
}catch(error){console.error(error.stack,error.detail??'',error.where??'');process.exitCode=1;}finally{await db.close();}
