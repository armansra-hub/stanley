/** Validate table-local maintenance settings without touching any live database. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../../work/intelligence-sql-test/package.json',import.meta.url));
const{PGlite}=require('@electric-sql/pglite');const db=await PGlite.create('memory://');
try{
 await db.exec(`create table intelligence_observations(id int primary key,attributes jsonb,evidence_text text,cached_operating_topics text[]);
 insert into intelligence_observations values(1,'{"nativeAnswer":{"probability":0.82}}','Retained source evidence',array['inventory']);
 create table unrelated_source(id int);`);
 const before=(await db.query('select * from intelligence_observations')).rows;
 await db.exec(await readFile(new URL('../../supabase/migrations/0115_intelligence_evidence_autovacuum.sql',import.meta.url),'utf8'));
 const options=(await db.query("select reloptions from pg_class where oid='intelligence_observations'::regclass")).rows[0].reloptions;
 assert.deepEqual([...options].sort(),[
  'autovacuum_vacuum_scale_factor=0.02','autovacuum_vacuum_threshold=1000',
  'autovacuum_vacuum_insert_scale_factor=0.02','autovacuum_vacuum_insert_threshold=1000',
  'autovacuum_analyze_scale_factor=0.02','autovacuum_analyze_threshold=1000',
 ].sort());
 assert.deepEqual((await db.query('select * from intelligence_observations')).rows,before,'native answers and evidence remain unchanged');
 assert.equal((await db.query("select reloptions from pg_class where oid='unrelated_source'::regclass")).rows[0].reloptions,null,'maintenance changes stay table-local');
 console.log('PASS 0115: supported PostgreSQL settings, unchanged native evidence, unrelated tables untouched');
}catch(error){console.error(error.message);process.exitCode=1;}finally{await db.close();}
