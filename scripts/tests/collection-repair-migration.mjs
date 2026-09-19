import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
let passed = 0;
async function account(name, { evidence = false, checked = 2, lists = ["netsuite_tam"], nsid = "1234" } = {}) {
  const id = randomUUID();
  await db.query(`insert into companies(id,name,status,lists,domain,netsuite_internal_id,site_checked_at,ats_checked_at)
    values($1,$2,'new',$3,'example.test',$4,clock_timestamp()-make_interval(hours=>$5),clock_timestamp()-make_interval(hours=>$5))`, [id,name,lists,nsid,checked]);
  if (evidence) await db.query("insert into intelligence_observations values($1,true)",[id]);
  return id;
}
async function state(id,key,status,next = null) {
  await db.query(`insert into intelligence_source_state(company_id,source_key,complete,cursor,coverage_status,last_success_at,last_error,next_attempt_at)
    values($1,$2,false,'{}',$3,now(),case when $3='partial' then 'Optional page blocked' else null end,$4)`,[id,key,status,next]);
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,
      subindustry text,state text,is_base boolean,claimable boolean);
    create table intelligence_config(id int primary key,enabled boolean,monthly_limit_usd numeric); insert into intelligence_config values(1,true,20);
    create table intelligence_source_state(company_id uuid,source_key text,complete boolean,cursor jsonb,last_success_at timestamptz,last_error text,primary key(company_id,source_key));
    create table intelligence_observations(company_id uuid,is_current boolean);
    create table intelligence_spend(charged_usd numeric,reserved_usd numeric,state text,month date);
    create table intelligence_jobs(status text);
    create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
  const legacy = await account("legacy-partial");
  await db.query(`insert into intelligence_source_state values($1,'website',false,'{"verifiedUrls":["https://example.test/"]}',now(),'optional page failed')`,[legacy]);
  const migration=await readFile(new URL("../../supabase/migrations/0071_collection_repair.sql",import.meta.url),"utf8");
  await db.exec(migration);
  assert.equal((await db.query("select coverage_status from intelligence_source_state")).rows[0].coverage_status,"partial"); passed++;
  await db.exec("delete from intelligence_source_state; delete from companies");
  const known = await account("covered-oldest",{evidence:true,checked:12});
  const fresh = await account("uncovered",{checked:2});
  const failed = await account("deferred",{checked:24});
  await state(failed,"website","unavailable",new Date(Date.now()+3600000).toISOString());
  await account("duplicate",{checked:24,lists:["netsuite_tam","tam_duplicate"]});
  await account("invalid-id",{checked:24,nsid:"abc"});
  assert.equal((await db.query("select id from reserve_company_rotation('site',1,date_trunc('hour',now()),'claimable')")).rows[0].id,fresh); passed++;
  assert.equal((await db.query("select id from reserve_company_rotation('site',1,date_trunc('hour',now()),'claimable')")).rows[0].id,known); passed++;
  assert.deepEqual((await db.query("select id from reserve_company_rotation('site',10,date_trunc('hour',now()),'claimable')")).rows,[]); passed++;
  await state(fresh,"website","partial");
  await state(known,"news:google","empty");
  const excluded = await account("outside-tam",{lists:[]});
  await state(excluded,"website","unavailable");
  const status=(await db.query("select intelligence_status() as value")).rows[0].value.sourceCoverage;
  assert.deepEqual(status,{scope:"eligible_tam",complete:0,partial:1,failed:1,empty:1,unsupported:0,unknown:0,withWarnings:1,accountsWithSuccess48h:3}); passed++;
  await state(fresh,"ats:discovery","empty",new Date(Date.now()+24*3600000).toISOString());
  const ats=(await db.query("select id from reserve_company_rotation('ats',20,date_trunc('hour',now()),null)")).rows;
  assert.ok(!ats.some(row=>row.id===fresh)); passed++;
  assert.equal((await db.query("select has_function_privilege('anon','reserve_company_rotation(text,integer,timestamptz,text)','EXECUTE') as allowed")).rows[0].allowed,false); passed++;
  console.log(`${passed} collection repair migration tests passed`);
} finally { await db.close(); }
