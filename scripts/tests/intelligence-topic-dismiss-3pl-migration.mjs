/** Synthetic database integration: no provider, production, or network calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const db=await PGlite.create('memory://');
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const file=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const functions=['intelligence_topic_search','intelligence_topic_explore'];
const call=(name,topics=['project_delivery'],showHidden=false,after=null,limit=8,mode='all')=>
 scalar(`select ${name}($1,$2,$3,$4,$5)`,[topics,after,limit,mode,showHidden]);
const withoutReadAdditions=value=>{
 const copy=structuredClone(value);delete copy.coverage.asOf;delete copy.showHidden;
 delete copy.topicCounts.non_asset_based_3pl;
 for(const account of copy.accounts)delete account.status;
 return copy;
};
const raw=()=>scalar('select jsonb_agg(to_jsonb(o) order by id) from intelligence_observations o');
const jobs=()=>scalar('select jsonb_agg(to_jsonb(j) order by id) from intelligence_jobs j');
const sourceText='We deliver projects and coordinate freight with third-party carriers.';
const attrs=(topic,probability=.95,relationship='direct')=>({companyRelationship:relationship,companyRelevance:.95,
 topicEvidence:[{topic,probability,start:0,end:sourceText.length}]});
const addSource=(n,company,attributes)=>db.query(`insert into intelligence_observations
 (id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
 values($1,$2,$1::uuid::text,'website','https://synthetic.test/'||$1::uuid::text,'Services',$3,$1::uuid::text,$4)`,
 [id(n),id(company),sourceText,attributes]);
let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
 for(const name of ['0059_intelligence_evidence_and_work.sql','0061_intelligence_operating_topic_search.sql',
 '0062_intelligence_feedback_and_research.sql','0089_intelligence_visibility.sql','0096_intelligence_exploration_cache.sql'])await db.exec(await file(name));
 await db.exec((await file('0072_business_services_intelligence.sql')).match(/create or replace function public.intelligence_supported_topics[\s\S]*?\$\$;/)[0]);
 await db.exec('drop function public.intelligence_topic_search(text[],uuid,integer)');
 await db.exec((await file('0073_intelligence_metrics_repair.sql')).match(/create or replace function public.intelligence_topic_search[\s\S]*?end \$\$;/)[0]);
 await db.exec((await file('0114_intelligence_topic_covering_reads.sql')).replace('create index concurrently','create index'));
 const statuses=['new','dismissed','reviewed','exported','exported_20260924',null,'removed_from_tam','new','new','new'];
 for(let n=1;n<=10;n++){
  await db.query('insert into companies values($1,$2,$3,$4,$5,$6,$7)',[id(n),statuses[n-1],`Account ${n}`,
   'synthetic.test','Services',n===9?'bad-id':String(n),n===8?['netsuite_tam','tam_duplicate']:n===10?[]:['netsuite_tam']]);
  await addSource(100+n,n,attrs('project_delivery'));
 }
 // Preserve the legacy NULL-cache path along with the fast current cache path.
 await db.query('update intelligence_observations set cached_exploratory_topics=null where id=$1',[id(101)]);
 const before={};
 for(const name of functions)before[name]=await scalar(`select ${name}(array['project_delivery'],null,8,'all')`);
 const rawBefore=await raw(),jobsBefore=await jobs();
 const migration=await file('0116_intelligence_topic_dismiss_and_3pl.sql');
 await db.exec(migration);
 await test('migration preserves paid evidence and jobs; Show hidden preserves previous search results',async()=>{
  assert.deepEqual(await raw(),rawBefore);assert.deepEqual(await jobs(),jobsBefore);
  for(const name of functions)assert.deepEqual(withoutReadAdditions(await call(name,['project_delivery'],true)),withoutReadAdditions(before[name]));
 });
 await test('default hides reviewed, dismissed and exported leads consistently in counts and pages',async()=>{
  for(const name of functions){
   const result=await call(name);
   assert.deepEqual(result.accounts.map(a=>a.companyId),[id(1),id(6)]);
   assert.deepEqual(result.accounts.map(a=>a.status),['new',null]);
   assert.equal(result.topicCounts.project_delivery,2);assert.equal(result.coverage.matchingAccounts,2);
   assert.equal(result.coverage.tamAccounts,2);assert.equal(result.showHidden,false);
   const first=await call(name,['project_delivery'],false,null,1);
   assert.equal(first.hasMore,true);assert.equal(first.nextCursor,id(1));
   const second=await call(name,['project_delivery'],false,first.nextCursor,1);
   assert.equal(second.accounts[0].companyId,id(6));assert.equal(second.hasMore,false);
   assert.equal((await scalar(`select ${name}(array['project_delivery'])`)).accounts.length,2,'old omitted-argument callers use default visibility');
   const hidden=await call(name,['project_delivery'],true);
   assert.equal(hidden.accounts.length,6);assert.equal(hidden.topicCounts.project_delivery,6);
   assert.equal(hidden.accounts.find(a=>a.companyId===id(2)).status,'dismissed');
   assert.ok(hidden.accounts.every(a=>![id(7),id(8),id(9),id(10)].includes(a.companyId)),'Show hidden never restores removed or noncanonical accounts');
  }
 });
 await test('dismiss and restore follow company status immediately without altering evidence or jobs',async()=>{
  await db.query("update companies set status='dismissed' where id=$1",[id(1)]);
  for(const name of functions)assert.equal((await call(name)).topicCounts.project_delivery,1);
  assert.deepEqual(await raw(),rawBefore);assert.deepEqual(await jobs(),jobsBefore);
  await db.query("update companies set status='new' where id=$1",[id(1)]);
  for(const name of functions)assert.equal((await call(name)).topicCounts.project_delivery,2);
 });
 await test('new 3PL category starts at zero without inventing matches from old text',async()=>{
  for(const name of functions){
   const result=await call(name,['non_asset_based_3pl']);
   assert.equal(result.topicCounts.non_asset_based_3pl,0);assert.equal(result.accounts.length,0);
   assert.equal(result.coverage.matchingAccounts,0);
  }
 });
 await test('future native 3PL answers populate caches and preserve existing attribution thresholds',async()=>{
  await addSource(201,1,attrs('non_asset_based_3pl'));
  await addSource(206,6,attrs('non_asset_based_3pl',.65));
  assert.deepEqual(await scalar('select cached_operating_topics from intelligence_observations where id=$1',[id(201)]),['non_asset_based_3pl']);
  assert.deepEqual(await scalar('select cached_exploratory_topics from intelligence_observations where id=$1',[id(201)]),['non_asset_based_3pl']);
  assert.equal((await call(functions[0],['non_asset_based_3pl'])).accounts.length,1);
  assert.equal((await call(functions[1],['non_asset_based_3pl'])).accounts.length,2);
  for(const name of functions){
   const expected=name===functions[0]?1:2;
   assert.equal((await call(name,['non_asset_based_3pl','project_delivery'])).accounts.length,expected,'All combines different sources for the same account');
   assert.equal((await call(name,['non_asset_based_3pl','project_delivery'],false,null,8,'any')).accounts.length,2);
  }
  await db.query('update intelligence_observations set attributes=$2 where id=$1',[id(201),attrs('non_asset_based_3pl',.95,'related')]);
  for(const name of functions)assert.ok((await call(name,['non_asset_based_3pl'])).accounts.every(a=>a.companyId!==id(1)),'related company evidence is not a direct match');
 });
 await test('new RPC signatures retain service-only access, bounded queries, and compact cached reads',async()=>{
  for(const name of functions){
   const signature=`${name}(text[],uuid,integer,text,boolean)`;
   assert.equal(await scalar('select to_regprocedure($1)',[`${name}(text[],uuid,integer,text)`]),null,'no ambiguous old overload');
   assert.equal(await scalar('select has_function_privilege($1,$2,$3)',['anon',signature,'EXECUTE']),false);
   assert.equal(await scalar('select has_function_privilege($1,$2,$3)',['authenticated',signature,'EXECUTE']),false);
   assert.equal(await scalar('select has_function_privilege($1,$2,$3)',['service_role',signature,'EXECUTE']),true);
   const settings=await scalar('select proconfig from pg_proc where oid=$1::regprocedure',[signature]);
   assert.ok(settings.includes('jit=off'));
   await assert.rejects(call(name,['made_up']),/Invalid operating topic query/);
   await assert.rejects(call(name,['non_asset_based_3pl'],null),/Invalid operating topic query/);
   await assert.rejects(call(name,['non_asset_based_3pl'],false,null,13),/Invalid operating topic query/);
   await assert.rejects(call(name,['non_asset_based_3pl'],false,null,8,'bad'),/Invalid operating topic query/);
  }
  assert.match(migration,/o\.cached_operating_topics as topics/);
  assert.match(migration,/o\.cached_exploratory_topics as topics/);
  assert.match(migration,/source_ids as materialized/);
  assert.equal(await scalar("select count(*) from pg_indexes where indexname='intelligence_current_topic_read'"),1);
 });
 console.log(`${passed} PostgreSQL integration tests passed`);
}catch(error){console.error(error.stack,error.detail??'',error.where??'');process.exitCode=1;}finally{await db.close();}
