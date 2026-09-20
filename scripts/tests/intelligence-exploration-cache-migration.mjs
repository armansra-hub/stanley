/** Local-only projection equivalence and production-sized query test. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const req=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));
const {PGlite}=req('@electric-sql/pglite');const db=await PGlite.create('memory://');
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clean=value=>{const next=structuredClone(value);delete next.coverage.asOf;return next;};
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
 for(const file of ['0059_intelligence_evidence_and_work.sql','0061_intelligence_operating_topic_search.sql','0062_intelligence_feedback_and_research.sql','0089_intelligence_visibility.sql'])
  await db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 for(let n=1;n<=5;n++)await db.query("insert into companies values($1,$2,$3,'test.test','Services',$4,$5)",[id(n),n===4?'removed_from_tam':'new',`Company${n}`,String(n),n===5?['netsuite_tam','tam_duplicate']:['netsuite_tam']]);
 const attrs={companyRelationship:'direct',companyRelevance:.3,topicEvidence:[{topic:'inventory',probability:.5,companyRelationship:'direct',companyRelevance:.5,start:0,end:9}],
  packetFindings:[{start:0,end:9,criteria:{project_delivery:.7,project_financials:.49},attributes:{companyRelationship:'direct',companyRelevance:.65}}]};
 for(let n=1;n<=5;n++)await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,observed_at)
  values($1,$2,$3,'website',$3,'Native source','Service😀',$4,$5,'2026-09-20')`,[id(100+n),id(n),'https://test.test/'+n,'hash'+n,n===3?null:attrs]);
 const modes=[[],['project_delivery'],['project_delivery','inventory']];
 const expected=[];
 for(const topics of modes)for(const mode of ['any','all'])expected.push(clean(await scalar('select intelligence_topic_explore($1,null,1,$2)',[topics,mode])));
 const original=await scalar('select attributes from intelligence_observations where id=$1',[id(101)]);
 await db.exec(await readFile(new URL('../../supabase/migrations/0096_intelligence_exploration_cache.sql',import.meta.url),'utf8'));
 assert.equal(await scalar('select count(*)::integer from intelligence_observations where cached_exploratory_topics is null'),5,'schema installation never interprets old rows');
 let index=0;
 for(const topics of modes)for(const mode of ['any','all'])assert.deepEqual(clean(await scalar('select intelligence_topic_explore($1,null,1,$2)',[topics,mode])),expected[index++],'cached RPC equals the original view');
 assert.deepEqual(await scalar('select intelligence_backfill_exploration_cache(2)'),{updated:2,remaining:3,complete:false},'backfill is bounded');
 assert.deepEqual(await scalar('select intelligence_backfill_exploration_cache(2)'),{updated:2,remaining:1,complete:false},'backfill resumes without reprocessing');
 assert.deepEqual(await scalar('select intelligence_backfill_exploration_cache(2)'),{updated:1,remaining:0,complete:true});
 assert.deepEqual(await scalar('select intelligence_backfill_exploration_cache(2)'),{updated:0,remaining:0,complete:true},'completed backfill is a no-op');
 index=0;
 for(const topics of modes)for(const mode of ['any','all'])assert.deepEqual(clean(await scalar('select intelligence_topic_explore($1,null,1,$2)',[topics,mode])),expected[index++],'completed cache has identical results');
 assert.deepEqual(await scalar('select attributes from intelligence_observations where id=$1',[id(101)]),original,'native JSON stays unchanged');
 assert.deepEqual(await scalar('select cached_exploratory_topics from intelligence_observations where id=$1',[id(101)]),['inventory','project_delivery']);
 assert.deepEqual(await scalar('select cached_operating_topics from intelligence_observations where id=$1',[id(101)]),[],'supported cache is unchanged');
 const first=await scalar("select intelligence_topic_explore(array['project_delivery'],null,1,'all')");
 assert.equal(first.hasMore,true);assert.equal((await scalar("select intelligence_topic_explore(array['project_delivery'],$1,1,'all')",[first.nextCursor])).accounts[0].companyId,id(2));
 const changed=structuredClone(attrs);changed.packetFindings[0].attributes.companyRelationship='related';
 await db.query('update intelligence_observations set attributes=$2 where id=$1',[id(101),changed]);
 assert.deepEqual(await scalar('select cached_exploratory_topics from intelligence_observations where id=$1',[id(101)]),['inventory'],'write trigger follows native updates');
 await db.query("update intelligence_observations set evidence_text='x' where id=$1",[id(101)]);
 assert.deepEqual(await scalar('select cached_exploratory_topics from intelligence_observations where id=$1',[id(101)]),[],'changed source spans regenerate projection');
 await db.query('update intelligence_observations set feedback_excluded=true where id=$1',[id(102)]);
 assert.equal((await scalar("select intelligence_topic_explore(array[]::text[])" )).topicCounts.project_delivery,0,'explicit exclusion applies immediately');
 for(const bad of [
  {...attrs,packetFindings:[{start:0,end:99,criteria:{project_delivery:.7},attributes:{companyRelationship:'direct',companyRelevance:.6}}],topicEvidence:[]},
  {...attrs,topicEvidence:[{topic:'inventory',probability:'0.7',start:0,end:9}],packetFindings:[]},
  {...attrs,topicEvidence:[{topic:'inventory',probability:.8,start:.5,end:9}],packetFindings:[]},
 ])assert.deepEqual(await scalar('select intelligence_exploratory_topics($1,$2)',[bad,'Service😀']),[]);
 assert.equal(await scalar("select has_function_privilege('anon','intelligence_exploratory_topics(jsonb,text)','EXECUTE')"),false);
 assert.equal(await scalar("select has_function_privilege('anon','intelligence_backfill_exploration_cache(integer)','EXECUTE')"),false);
 await assert.rejects(db.query('select intelligence_backfill_exploration_cache(501)'),/Invalid exploration cache batch size/);
 // Equivalent source count to the production report, with29k interpreted
 // observations and multi-kilobyte bodies. No provider calls or real records.
 const scaleStart=performance.now();
 // Simulate pre-existing rows without doing their interpretation in one large
 // insertion transaction. Production installs the same nullable column first.
 await db.exec('alter table intelligence_observations disable trigger intelligence_refresh_exploratory_topics');
 await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
  select md5('scale-'||n)::uuid,$1,'scale-'||n,'website','https://test.test/scale/'||n,'Scale source',repeat('Service operations and billing. ',100),'scale-'||n,case when n<=29000 then $2::jsonb else null end
 from generate_series(1,54000) n`,[id(1),attrs]);
 await db.exec('alter table intelligence_observations enable trigger intelligence_refresh_exploratory_topics');
 const loadMs=performance.now()-scaleStart;
 const batchTimes=[];let backfilled=0;
 while(true){const start=performance.now();const result=await scalar('select intelligence_backfill_exploration_cache(500)');batchTimes.push(performance.now()-start);backfilled+=result.updated;if(result.complete)break;assert.ok(result.updated>0);}
 assert.equal(backfilled,54000);assert.equal(batchTimes.length,108);assert.ok(Math.max(...batchTimes)<20000,'each bounded backfill transaction fits the endpoint budget');
 // Make native JSON expansion impossible after ingestion. Successful queries
 // now prove they read the stored projection rather than rescanning answers.
 await db.exec(`create or replace function public.intelligence_native_topic_references(p_attributes jsonb) returns setof jsonb language plpgsql immutable as $$ begin raise exception 'request-time native expansion'; end $$;`);
 const countsStart=performance.now();const counts=await scalar('select intelligence_topic_explore(array[]::text[])');const countMs=performance.now()-countsStart;
 assert.equal(counts.topicCounts.project_delivery,1);assert.equal(counts.coverage.currentObservations,54002);assert.equal(counts.coverage.interpretedObservations,29001);
 const searchStart=performance.now();const search=await scalar("select intelligence_topic_explore(array['project_delivery','inventory'],null,8,'all')");const searchMs=performance.now()-searchStart;
 assert.equal(search.accounts.length,1);assert.equal(search.accounts[0].observations.length,1);assert.deepEqual(search.accounts[0].observations[0].attributes,attrs);
 assert.ok(countMs<20000&&searchMs<20000,'production-sized cached reads must fit the existing20-second endpoint budget');
 console.log(JSON.stringify({passed:true,rows:54000,interpreted:29000,loadMs:Math.round(loadMs),backfillBatches:batchTimes.length,maxBackfillBatchMs:Math.round(Math.max(...batchTimes)),backfillMs:Math.round(batchTimes.reduce((a,b)=>a+b,0)),countMs:Math.round(countMs),searchMs:Math.round(searchMs),checks:['original view parity','no deployment backfill','bounded resumable backfill','native answers unchanged','UTF16 spans','50percent boundaries','updates','source replacement','feedback exclusion','keyset','service grants','no request-time native expansion','54000-row counts and search']}));
} finally {await db.close();}
