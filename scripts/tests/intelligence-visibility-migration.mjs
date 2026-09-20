import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const req=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));const {PGlite}=req('@electric-sql/pglite');const db=await PGlite.create('memory://');
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];const c=randomUUID(),o=randomUUID();
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
 create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
 create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
 for(const f of ['0059_intelligence_evidence_and_work.sql','0061_intelligence_operating_topic_search.sql','0062_intelligence_feedback_and_research.sql','0089_intelligence_visibility.sql'])await db.exec(await readFile(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await db.query("insert into companies values($1,'new','Synthetic','test.test','Consulting','1',array['netsuite_tam'])",[c]);
 const attrs={companyRelationship:'direct',companyRelevance:.3,packetFindings:[{start:0,end:9,questionVersion:'stanley-business-services-v3',criteria:{project_delivery:.7},attributes:{companyRelationship:'direct',companyRelevance:.65,signalType:'none'}}]};
 await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes) values($1,$2,'source','website','https://test.test','Service','Service😀','hash',$3)`,[o,c,attrs]);
 assert.deepEqual(await scalar('select cached_operating_topics from intelligence_observations where id=$1',[o]),[]);
 let result=await scalar("select intelligence_topic_explore(array['project_delivery'],null,8,'any')");assert.equal(result.accounts.length,1);assert.equal(result.topicCounts.project_delivery,1);assert.equal(result.visibility,'explore');
 assert.deepEqual(await scalar('select attributes from intelligence_observations where id=$1',[o]),attrs);
 console.log('PASS broader exploration reads native packet probabilities with own attribution and UTF-16 bounds without changing supported cache or answers');
 const sample=await scalar('select intelligence_visibility_sample(null,200)');assert.equal(sample.observations[0].packets[0].criteria.project_delivery,.7);assert.equal(sample.observations[0].packets[0].attributes.companyRelevance,.65);
 assert.equal(JSON.stringify(sample).includes('evidence_text'),false);console.log('PASS bounded diagnostics return actual packet scores, not source text or private identity context');
 attrs.packetFindings[0].attributes.companyRelationship='related';await db.query('update intelligence_observations set attributes=$2 where id=$1',[o,attrs]);
 assert.equal((await scalar("select intelligence_topic_explore(array['project_delivery'])")).accounts.length,0);
 await db.query('update intelligence_observations set feedback_excluded=true where id=$1',[o]);assert.equal((await scalar('select intelligence_visibility_sample()')).observations.length,0);
 console.log('PASS exploration retains direct attribution and explicit exclusions');
 assert.equal(await scalar("select has_function_privilege('anon','intelligence_visibility_sample(uuid,integer)','EXECUTE')"),false);console.log('PASS diagnostic storage reads remain service-only');
}catch(e){console.error(e.message,e.detail??'',e.where??'');process.exitCode=1;}finally{await db.close();}
