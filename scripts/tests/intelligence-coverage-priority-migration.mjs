/** Actual local PostgreSQL execution; no network, provider calls, or production writes.
 * PGlite serializes connections: lease tests prove exclusion/readback, not a
 * substitute for PostgreSQL's FOR UPDATE SKIP LOCKED concurrency guarantees. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const ids = rows => rows.map(row => row.id);
let passed = 0;
async function test(name, run) { await reset(); await run(); passed++; console.log(`PASS ${name}`); }
async function reset() {
  await db.exec(`truncate intelligence_view_matches,intelligence_jobs,intelligence_feedback,intelligence_source_state,
    intelligence_observations,intelligence_views,intelligence_spend,trigger_candidates,companies;
    insert into intelligence_config(id,enabled) values(1,true) on conflict(id) do update
      set enabled=true,coverage_rotation_turns='{}',coverage_claim_turns='{}';`);
}
async function account(name, { evidence = false, interpreted = false, hours = 2, domain = "example.test", website = null,
  lists = ["netsuite_tam"], nsid = "1234", status = "new", base = true, claimable = true } = {}) {
  const id = randomUUID();
  await db.query(`insert into companies(id,name,status,lists,domain,website_raw,netsuite_internal_id,
    last_checked_at,site_checked_at,ats_checked_at,is_base,claimable)
    values($1,$2,$3,$4,$5,$6,$7,now()-make_interval(hours=>$8),now()-make_interval(hours=>$8),
    now()-make_interval(hours=>$8),$9,$10)`, [id,name,status,lists,domain,website,nsid,hours,base,claimable]);
  if (evidence || interpreted) await observation(id, { interpreted });
  return id;
}
async function observation(company, { interpreted = false, current = true, excluded = false } = {}) {
  const id = randomUUID();
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,
    evidence_text,content_hash,is_current,attributes,feedback_excluded)
    values($1::uuid,$2,$1::text,'website','https://example.test/','Source','Complete public evidence',$1::text,$3,$4,$5)`,
  [id,company,current,interpreted ? { native: "retained" } : null,excluded]);
  return id;
}
async function state(company, key, { next = null, complete = false, revisit = {}, successful = true, error = null } = {}) {
  await db.query(`insert into intelligence_source_state(company_id,source_key,complete,cursor,last_success_at,last_error,next_attempt_at)
    values($1,$2,$3,$4,case when $5 then now() else null end,$6,$7)`, [company,key,complete,{revisit},successful,error,next]);
}
const reserve = async (source, n, scope = source === "site" ? "claimable" : null) =>
  (await db.query("select * from reserve_company_rotation($1,$2,date_trunc('hour',now()),$3)",[source,n,scope])).rows;
async function job(company, { priority = 10, minutes = 2, result = null, status = "queued", attempts = 0,
  lease = null, until = null, current = true } = {}) {
  const id = randomUUID(), obs = await observation(company,{current});
  await db.query(`insert into intelligence_jobs(id,operation_key,observation_id,kind,priority,due_at,result,status,
    attempts,lease_token,lease_until) values($1::uuid,$1::text,$2,'interpret',$3,now()-make_interval(mins=>$4),$5,$6,$7,$8,$9)`,
  [id,obs,priority,minutes,result,status,attempts,lease,until]);
  return id;
}
const claim = async n => (await db.query("select * from intelligence_claim($1)",[n])).rows;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,subindustry text,state text,is_base boolean,claimable boolean);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],
      verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
  for (const file of ["0059_intelligence_evidence_and_work.sql","0071_collection_repair.sql","0075_fresh_intelligence_priority.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false");
  await db.exec(await readFile(new URL("../../supabase/migrations/0108_intelligence_coverage_priority.sql",import.meta.url),"utf8"));

  for (const source of ["site","ats","trigger"]) {
    await test(`${source}: reserves half oldest monitoring and half uncovered; returns stable prior-time order`, async () => {
      const known = [];
      for (let i = 0; i < 5; i++) known.push(await account(`covered-${i}`,{evidence:true,hours:20-i}));
      const missing = [];
      for (let i = 0; i < 5; i++) missing.push(await account(`missing-${i}`,{hours:5-i}));
      const first = await reserve(source,4);
      assert.deepEqual(ids(first),[...known.slice(0,2),...missing.slice(0,2)]);
      const second = await reserve(source,4);
      assert.deepEqual(ids(second),[...known.slice(2,4),...missing.slice(2,4)]);
      assert.ok(second.every(row=>!first.some(prior=>prior.id===row.id)));
    });
    await test(`${source}: first-pass and monitoring capacity fall back in both directions`, async () => {
      const known = [];
      for (let i=0;i<5;i++) known.push(await account(`known-${i}`,{evidence:true,hours:20-i}));
      assert.deepEqual(ids(await reserve(source,4)),known.slice(0,4));
      await reset();
      const missing=[];
      for(let i=0;i<5;i++) missing.push(await account(`missing-${i}`,{hours:20-i}));
      assert.deepEqual(ids(await reserve(source,4)),missing.slice(0,4));
    });
    await test(`${source}: repeated one-row claims alternate oldest and first-pass`, async () => {
      const oldest=await account("known-oldest",{evidence:true,hours:20});
      await account("known-second",{evidence:true,hours:19});
      const missing=await account("missing",{hours:2});
      assert.deepEqual(ids(await reserve(source,1)),[oldest]);
      assert.deepEqual(ids(await reserve(source,1)),[missing]);
    });
  }
  await test("website and ATS retain retry backoff, adaptive interval and cross-hour lease protection",async()=>{
    for(const source of ["site","ats"]){
      const key=source==="site"?"website":"ats:discovery";
      const deferred=await account(`${source}-backoff`,{hours:24});
      await state(deferred,key,{next:new Date(Date.now()+3600000).toISOString()});
      const quiet=await account(`${source}-quiet`,{hours:24});
      await state(quiet,key,{complete:true,revisit:{version:1,intervalHours:24}});
      const active=await account(`${source}-active`,{hours:24});
      await db.query(`update companies set ${source==="site"?"site_checked_at":"ats_checked_at"}=now()-interval '2 minutes' where id=$1`,[active]);
      const allowed=await account(`${source}-due`,{hours:2});
      await state(allowed,key,{complete:false,error:"Optional depth pending"});
      const selected=ids(await reserve(source,50));
      assert.ok(selected.includes(allowed));
      assert.ok([deferred,quiet,active].every(id=>!selected.includes(id)));
      await reset();
    }
  });
  await test("domainless accounts remain in news; website aliases and exact-ID/site eligibility remain intact",async()=>{
    const domainless=await account("no-domain",{domain:null,hours:20});
    const alias=await account("source-website",{domain:null,website:"https://example.test/",hours:19});
    const duplicate=await account("duplicate",{lists:["netsuite_tam","tam_duplicate"],hours:18});
    const invalid=await account("invalid-id",{nsid:"abc",hours:17});
    const removed=await account("removed",{status:"removed_from_tam",hours:30});
    const news=ids(await reserve("trigger",50));
    assert.ok(news.includes(domainless)); assert.ok(!news.includes(removed));
    assert.deepEqual(ids(await reserve("site",50)),[alias]);
    const ats=ids(await reserve("ats",50));
    assert.ok(ats.includes(alias)); assert.ok(!ats.includes(domainless));
    // Preserve the pre-existing ATS eligibility exactly; this is not membership cleanup.
    assert.ok(ats.includes(duplicate)&&ats.includes(invalid));
  });
  await test("nonclaimable tail remains ordinary oldest-first, without first-pass takeover",async()=>{
    const known=await account("tail-old",{evidence:true,hours:20,claimable:false,lists:[]});
    const second=await account("tail-second",{evidence:true,hours:19,claimable:false,lists:[]});
    await account("tail-missing",{hours:2,claimable:false,lists:[]});
    assert.deepEqual(ids(await reserve("site",2,"tail")),[known,second]);
  });
  await test("feedback-rejected evidence does not count as initial source or interpretation coverage",async()=>{
    const known=await account("known-oldest",{interpreted:true,hours:20});
    await account("known-second",{interpreted:true,hours:19});
    const rejected=await account("wrong-company-only",{hours:2});
    await observation(rejected,{interpreted:true,excluded:true});
    for (const source of ["site","ats","trigger"])
      assert.deepEqual(ids(await reserve(source,2)),[known,rejected]);
    const oldest=await job(known,{minutes:30,result:{routingBackfill:"business-services-v1"}});
    const firstValid=await job(rejected,{minutes:2,priority:10});
    const fresh=await job(known,{minutes:1,priority:30});
    assert.deepEqual(new Set(ids(await claim(3))),new Set([oldest,firstValid,fresh]));
  });
  await test("disabled/missing configuration retains normal source rotation and never interprets",async()=>{
    for (const missing of [false,true]) {
      const known=await account("known",{evidence:true,hours:20});
      await account("missing-evidence",{hours:2});
      await job(known);
      if(missing) await db.exec("delete from intelligence_config");
      else await db.exec("update intelligence_config set enabled=false");
      assert.deepEqual(ids(await reserve("site",1)),[known]);
      assert.deepEqual(await claim(3),[]);
      await reset();
    }
  });
  const replay={routingBackfill:"business-services-v1",parts:[{nativeAnswers:{companyRelevance:0.9}}]};
  await test("three-job claims preserve oldest debt, first account interpretation and fresh signals",async()=>{
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const oldest=await job(known,{minutes:30,priority:30,result:replay});
    const uncovered=await job(missing,{minutes:2,priority:10});
    const fresh=await job(known,{minutes:1,priority:30});
    const next=await job(known,{minutes:2,priority:20});
    const first=await claim(3);
    assert.deepEqual(new Set(ids(first)),new Set([oldest,uncovered,fresh]));
    assert.deepEqual(first.find(row=>row.id===oldest).result,replay);
    assert.ok(first.every(row=>row.attempts===1&&row.status==="running"&&row.lease_token));
    assert.deepEqual(ids(await claim(3)),[next]);
    assert.deepEqual(await claim(3),[]);
  });
  await test("dedicated coverage slot prefers a different account from oldest coverage work",async()=>{
    const first=await account("first"),second=await account("second"),known=await account("known",{interpreted:true});
    const oldest=await job(first,{minutes:30});
    await job(first,{priority:20,minutes:5});
    const different=await job(second,{priority:10,minutes:2});
    const fresh=await job(known,{priority:30,minutes:1});
    assert.deepEqual(new Set(ids(await claim(3))),new Set([oldest,different,fresh]));
  });
  await test("single claims rotate oldest, uncovered and fresh; unrelated batch sizes cannot skew the cycle",async()=>{
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const oldest=await job(known,{minutes:30,result:replay});
    const otherOld=await job(known,{minutes:29,result:replay});
    const uncovered=await job(missing,{minutes:2});
    const fresh=await job(known,{minutes:1,priority:30});
    assert.deepEqual(ids(await claim(1)),[oldest]);
    // A separate two-item counter, even after an earlier phase, cannot consume
    // the next one-item first-pass turn.
    await db.exec(`update intelligence_config set coverage_claim_turns=jsonb_set(coverage_claim_turns,'{2}','7')`);
    assert.deepEqual(ids(await claim(1)),[uncovered]);
    assert.deepEqual(ids(await claim(1)),[fresh]);
    assert.deepEqual(ids(await claim(1)),[otherOld]);
  });
  await test("two-job claims retain oldest and alternate the second uncovered/fresh slot",async()=>{
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const oldest=await job(known,{minutes:30,result:replay}),nextOld=await job(known,{minutes:29,result:replay});
    const uncovered=await job(missing,{minutes:2}),fresh=await job(known,{minutes:1,priority:30});
    assert.deepEqual(new Set(ids(await claim(2))),new Set([oldest,uncovered]));
    assert.deepEqual(new Set(ids(await claim(2))),new Set([nextOld,fresh]));
  });
  await test("empty coverage lane lends its slot; expired leases recover without changing saved native answers",async()=>{
    const known=await account("known",{interpreted:true});
    const a=await job(known,{minutes:30,result:replay}),b=await job(known),c=await job(known);
    const first=await claim(3);
    assert.deepEqual(new Set(ids(first)),new Set([a,b,c]));
    const original=first.find(row=>row.id===a);
    await db.query("update intelligence_jobs set lease_until=now()-interval '1 second' where id=$1",[a]);
    const [retry]=await claim(3);
    assert.equal(retry.id,a); assert.equal(retry.attempts,2); assert.notEqual(retry.lease_token,original.lease_token);
    assert.deepEqual(retry.result,replay);
    assert.equal(await scalar("select intelligence_finish($1,$2,'queued',$3)",[a,original.lease_token,replay]),false);
  });
  await test("future work and live leases stay excluded; exhausted attempts fail; null/zero limits are rejected",async()=>{
    const known=await account("known",{interpreted:true});
    const future=await job(known,{minutes:-30}),exhausted=await job(known,{attempts:5});
    const live=await job(known,{status:"running",lease:randomUUID(),until:new Date(Date.now()+600000).toISOString()});
    assert.deepEqual(await claim(3),[]);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[future]),"queued");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[live]),"running");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[exhausted]),"failed");
    for(const limit of [null,0,-1]) {
      await assert.rejects(()=>claim(limit),/claim limit must be positive/);
      await assert.rejects(()=>reserve("site",limit),/reservation limit must be between/);
    }
  });
  await test("RPC privileges and partial indexes stay server-only and bounded to current evidence",async()=>{
    for(const fn of ["intelligence_claim(integer)","reserve_company_rotation(text,integer,timestamptz,text)"]) {
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')",[fn]),false);
      assert.equal(await scalar("select has_function_privilege('authenticated',$1,'EXECUTE')",[fn]),false);
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",[fn]),true);
    }
    const indexes=await db.query("select indexname,indexdef from pg_indexes where indexname in ('intelligence_current_account_evidence','intelligence_current_account_interpreted')");
    assert.equal(indexes.rows.length,2);
    assert.ok(indexes.rows.every(row=>row.indexdef.includes("WHERE is_current")||row.indexdef.includes("WHERE (is_current")));
  });
  console.log(`${passed} coverage-priority PostgreSQL tests passed`);
} catch (error) {
  console.error(error.message, error.detail ?? "", error.internalQuery ?? "", error.query ?? "");
  process.exitCode = 1;
} finally { await db.close(); }
