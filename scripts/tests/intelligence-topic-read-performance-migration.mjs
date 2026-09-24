/** Isolated synthetic SQL parity and multi-account scaling; no provider/live access. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const require=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');const db=await PGlite.create('memory://');
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const file=async(name)=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clean=value=>{const result=structuredClone(value);delete result.coverage.asOf;return result;};
const receipt={parityChecks:0,scale:[]};
const call=(name,topics=[],mode='all',after=null,limit=8)=>scalar(`select ${name}($1,$2,$3,$4)`,[topics,after,limit,mode]);
const functions=['intelligence_topic_search','intelligence_topic_explore'];
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
 for(const name of ['0059_intelligence_evidence_and_work.sql','0061_intelligence_operating_topic_search.sql','0062_intelligence_feedback_and_research.sql','0089_intelligence_visibility.sql','0096_intelligence_exploration_cache.sql'])await db.exec(await file(name));
 await db.exec((await file('0072_business_services_intelligence.sql')).match(/create or replace function public.intelligence_supported_topics[\s\S]*?\$\$;/)[0]);
 const oldSupported=(await file('0073_intelligence_metrics_repair.sql')).match(/create or replace function public.intelligence_topic_search[\s\S]*?end \$\$;/)[0];
 await db.exec('drop function public.intelligence_topic_search(text[],uuid,integer)');await db.exec(oldSupported);
 await db.exec(`create index intelligence_current_account_evidence on intelligence_observations(company_id) where is_current and not feedback_excluded;
 create index intelligence_current_account_interpreted on intelligence_observations(company_id) where is_current and not feedback_excluded and attributes is not null;`);
 for(let n=1;n<=14;n++)await db.query(`insert into companies values($1,$2,$3,'synthetic.test','Services',$4,$5)`,[id(n),n===11?'removed_from_tam':'new',`Account${n}`,n===14?'bad-id':String(n),n===12?['netsuite_tam','tam_duplicate']:n===13?[]:['netsuite_tam']]);
 const sourceIds=[];
 for(let n=1;n<=14;n++)for(let k=0;k<4;k++){
  const text='Public service operations😀';
  const attrs=k===3?null:{companyRelationship:n===10?'related':'direct',companyRelevance:.95,
   topicEvidence:[{topic:['project_billing','project_delivery','inventory'][k],probability:n===9?.65:.95,start:0,end:text.length}],
   packetFindings:k===2?[{start:0,end:text.length,criteria:{close_reporting:.7},attributes:{companyRelationship:'direct',companyRelevance:.8}}]:[]};
  const oid=id(100+n*4+k);sourceIds.push(oid);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,observed_at,is_current,feedback_excluded)
   values($1,$2,$1::uuid::text,'website','https://synthetic.test/'||$1::uuid::text,'Saved source',$3,$1::uuid::text,$4,'2026-09-20'::timestamptz+make_interval(secs=>$5),$6,$7)`,
   [oid,id(n),text,attrs,k,n!==8||k!==0,n===7&&k===1]);
 }
 // One legacy cache row proves fallback does not silently lose exploration evidence.
 await db.query('update intelligence_observations set cached_exploratory_topics=null where id=$1',[sourceIds[2]]);
 const rawBefore=await scalar('select jsonb_agg(to_jsonb(o) order by id) from intelligence_observations o');
 const inputs=[];
 for(const name of functions)for(const topics of [[],['project_billing'],['project_billing','project_delivery'],['inventory','close_reporting'],['inventory','inventory']])for(const mode of ['all','any'])for(const after of [null,id(2)]){
  inputs.push({name,topics,mode,after,limit:2,expected:clean(await call(name,topics,mode,after,2))});
 }
 await db.exec(await file('0113_intelligence_topic_read_performance.sql'));
 // PGlite's fixture runner batches statements in one transaction. The
 // production migration builds the identical index concurrently as a standalone statement.
 const covering=await file('0114_intelligence_topic_covering_reads.sql');
 assert.ok(covering.indexOf('create index concurrently')<covering.indexOf('begin;'));
 await db.exec(covering.replace('create index concurrently','create index'));
 for(const v of inputs){assert.deepEqual(clean(await call(v.name,v.topics,v.mode,v.after,v.limit)),v.expected,JSON.stringify(v));receipt.parityChecks++;}
 assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(o) order by id) from intelligence_observations o'),rawBefore,'read repair leaves native rows untouched');
 for(const name of functions){
  const settings=await scalar('select proconfig from pg_proc where oid=$1::regprocedure',[`${name}(text[],uuid,integer,text)`]);
  assert.ok(settings.includes('jit=off'),'JIT stays off only for these interactive read functions');
  assert.ok(settings.some(value=>value.startsWith('search_path=')&&value.includes('public')&&value.includes('pg_temp')));
  assert.equal(await scalar(`select has_function_privilege('anon','${name}(text[],uuid,integer,text)','EXECUTE')`),false);
  assert.equal(await scalar(`select has_function_privilege('service_role','${name}(text[],uuid,integer,text)','EXECUTE')`),true);
  await assert.rejects(call(name,['not_real']),/Invalid operating topic query/);
  await assert.rejects(call(name,['inventory'],'bad'),/Invalid operating topic query/);
  await assert.rejects(call(name,['inventory'],'all',null,13),/Invalid operating topic query/);
 }
 console.log(`PASS ${receipt.parityChecks} exact before/after response comparisons and native-row preservation`);
 // Populate existing cached state directly: this measures read performance, not
 // the already-tested native cache population helpers. Real helper semantics and
 // nullable legacy fallback were exercised above.
 await db.exec('alter table intelligence_observations alter column cached_operating_topics drop expression;alter table intelligence_observations disable trigger intelligence_refresh_exploratory_topics;alter table intelligence_observations alter column evidence_text set storage plain');
 // Fixture-only PLAIN storage above avoids unrealistically compressing a
 // repeated synthetic body to a few bytes. It does not change production storage.
 // Populate 7,500 eligible accounts across 100,000 observations with sizable native payloads.
 await db.query(`insert into companies select md5('scale-company-'||n)::uuid,'new','Scale '||n,'scale.test','Services',(100000+n)::text,array['netsuite_tam'] from generate_series(1,7500) n`);
 const attrs={companyRelationship:'direct',companyRelevance:.95,topicEvidence:['inventory','project_billing','project_delivery'].map(topic=>({topic,probability:.95,start:0,end:20}))};
 await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,observed_at,cached_operating_topics,cached_exploratory_topics)
 select md5('scale-source-'||n)::uuid,md5('scale-company-'||((n-1)%7500+1))::uuid,'scale-source-'||n,'website','https://scale.test/'||n,'Scale source',repeat('Public operating information. ',100),'scale-hash-'||n,case when n%5=0 then null else $1::jsonb end,'2026-09-22'::timestamptz+make_interval(secs=>n),case when n%5=0 then '{}'::text[] else array['inventory','project_billing','project_delivery'] end,case when n%5=0 then '{}'::text[] else array['inventory','project_billing','project_delivery'] end
 from generate_series(1,100000) n`,[attrs]);
 console.log('PASS synthetic cached-state fixture loaded');
 await db.exec('vacuum analyze companies');
 await db.exec('vacuum analyze intelligence_observations');
 await db.exec("set statement_timeout='12s'");
 for(const version of ['after']){
  for(const name of functions)for(const topics of [[],['inventory','project_billing']]){
   const start=performance.now();let result;try{const data=await call(name,topics);result={accounts:data.accounts.length,count:data.topicCounts.inventory,sourceCount:data.coverage.currentObservations};}
   catch(error){result={error:error.code??error.message};}
   receipt.scale.push({version,function:name,topics,elapsedMs:Math.round(performance.now()-start),...result});
   console.log(JSON.stringify(receipt.scale.at(-1)));
  }
 }
 for(const measurement of receipt.scale.filter(value=>value.version==='after')){assert.equal(measurement.error,undefined,'optimized read must finish');assert.ok(measurement.elapsedMs<12000,'optimized read fits the existing 15-second request budget');assert.equal(measurement.sourceCount,100038);}
 // The wide fixture simulates the production heap without forcing planner
 // settings. Exact counts and topics must use compact index-only paths after
 // ordinary vacuum updates the visibility map.
 const repair=await file('0114_intelligence_topic_covering_reads.sql');
 const bodies=[...repair.matchAll(/ return \(\n([\s\S]*?)\n \);\nend \$\$;/g)].map(match=>match[1]);
 assert.equal(bodies.length,2);
 receipt.plans=[];
 const nodes=(value,out=[])=>{if(value&&typeof value==='object'){if(value['Node Type'])out.push(value);for(const child of Object.values(value))nodes(child,out);}return out;};
 for(let index=0;index<bodies.length;index++){
  const query=bodies[index].replace(/\bv_topics\b/g,'array[]::text[]').replace(/\bp_mode\b/g,"'any'::text").replace(/\bp_after\b/g,'null::uuid').replace(/\bp_limit\b/g,'8');
  const plan=nodes((await db.query('explain (analyze,buffers,format json) '+query)).rows);
  assert.ok(plan.some(node=>node['Node Type']==='Index Only Scan'&&node['Index Name']==='intelligence_current_topic_read'&&node['Actual Loops']>0),'compact evidence uses the covering index');
  assert.equal(plan.some(node=>node['Node Type']==='Seq Scan'&&node['Relation Name']==='intelligence_observations'&&node['Actual Loops']>0),false,'counts never scan the wide evidence heap');
  receipt.plans.push({function:functions[index],indexOnly:plan.filter(node=>node['Node Type']==='Index Only Scan').map(node=>node['Index Name'])});
 }
 receipt.passed=true;console.log(JSON.stringify(receipt));
}catch(error){console.error(error.stack,error.detail??'',error.where??'');process.exitCode=1;}finally{await db.close();}
