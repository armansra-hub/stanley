/** Actual local PostgreSQL execution; no network, model calls, or production writes.
 * PGlite serializes submitted queries. Concurrent Promise submissions test shared
 * persisted capacity/exclusion; SQL lock-order assertions verify the PostgreSQL
 * locking mechanism, not a substitute for a multi-connection production load test. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const ids = rows => rows.map(row => row.id);
const claim = async n => (await db.query("select * from intelligence_claim($1)", [n])).rows;
const directed = async n => (await db.query("select * from intelligence_directed_claim($1)", [n])).rows;
const countLive = table => scalar(`select count(*)::int from ${table} where status='running' and lease_until>now()`);
const done = job => scalar("select intelligence_finish($1,$2,'complete',$3,$4,'existing-test-version',0.8)",
  [job.id, job.lease_token, job.result ?? { native: "kept" }, { native: "unchanged native answers" }]);
const doneDirected = job => scalar("select intelligence_directed_finish($1,$2,$3,'complete',86400,$4,null)",
  [job.company_id, job.lease_token, job.desired_hash, { outcome: "caught_up" }]);
const replay = { routingBackfill: "business-services-v1", native: "original paid response" };
let passed = 0;
async function test(name, run, resetFirst = true) {
  if (resetFirst) await reset();
  await run(); passed++; console.log(`PASS ${name}`);
}
async function reset() {
  await db.exec(`truncate intelligence_research_attempts,intelligence_research_sources,intelligence_directed_research_jobs,
    intelligence_view_matches,intelligence_jobs,intelligence_feedback,intelligence_source_state,intelligence_observations,
    intelligence_views,intelligence_spend,trigger_candidates,triggers,companies;
    update intelligence_config set enabled=true,coverage_rotation_turns='{}',coverage_claim_turns='{}',directed_claim_turn=0;`);
}
async function observation(company, { interpreted = false, current = true, excluded = false } = {}) {
  const id = randomUUID();
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,
    evidence_text,content_hash,is_current,attributes,feedback_excluded)
    values($1::uuid,$2,$1::text,'website','https://example.test/','Full source','Preserved complete source text',$1::text,$3,$4,$5)`,
  [id,company,current,interpreted ? { native: "preserved" } : null,excluded]);
  return id;
}
async function account(name, { interpreted = false, lists = ["netsuite_tam"], nsid = "1234", status = "new", minutes = 2 } = {}) {
  const id = randomUUID();
  await db.query("insert into companies(id,name,status,lists,netsuite_internal_id) values($1,$2,$3,$4,$5)", [id,name,status,lists,nsid]);
  if (interpreted) await observation(id, { interpreted });
  await db.query("update intelligence_directed_research_jobs set due_at=now()-make_interval(mins=>$2) where company_id=$1", [id,minutes]);
  return id;
}
async function job(company, { priority = 10, minutes = 2, result = null, status = "queued", attempts = 0,
  lease = null, until = null, kind = "interpret" } = {}) {
  const id = randomUUID(), obs = await observation(company);
  let view = null;
  if (kind === "view") {
    view = randomUUID();
    await db.query("insert into intelligence_views(id,name,question) values($1::uuid,$1::text,$1::text)", [view]);
  }
  await db.query(`insert into intelligence_jobs(id,operation_key,observation_id,kind,priority,due_at,result,status,
    attempts,lease_token,lease_until,view_id) values($1::uuid,$1::text,$2,$3,$4,now()-make_interval(mins=>$5),$6,$7,$8,$9,$10,$11)`,
  [id,obs,kind,priority,minutes,result,status,attempts,lease,until,view]);
  return id;
}
async function manyJobs(count, options = {}) {
  const company = await account("Shared account", { interpreted: true });
  const created = [];
  for (let n = 0; n < count; n++) created.push(await job(company, options));
  return created;
}
async function manyAccounts(count) {
  const created = [];
  for (let n = 0; n < count; n++) created.push(await account(`Account ${n}`));
  return created;
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,subindustry text,state text,
      city text,ns_industry text,is_base boolean,claimable boolean);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);
    create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],
      verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
  for (const file of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql",
    "0067_intelligence_directed_research_queue.sql", "0071_collection_repair.sql", "0074_directed_research_discovery.sql", "0075_fresh_intelligence_priority.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
  await db.exec("alter table intelligence_research_sources add column metadata jsonb not null default '{}'");
  for (const file of ["0107_intelligence_research_caught_up.sql", "0108_intelligence_coverage_priority.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
  await reset();
  const beforeCompany = await account("Healthy before deploy");
  await job(beforeCompany, { status: "running", lease: randomUUID(), until: new Date(Date.now()+180000).toISOString(), result: replay });
  await directed(1);
  const beforeJobs = (await db.query("select * from intelligence_jobs order by id")).rows;
  const beforeDirected = (await db.query("select * from intelligence_directed_research_jobs order by company_id")).rows;
  const beforeConfig = (await db.query("select * from intelligence_config")).rows;
  await db.exec(await readFile(new URL("../../supabase/migrations/0112_intelligence_worker_capacity.sql", import.meta.url), "utf8"));

  await test("migration retains every active lease, response, counter and budget setting", async () => {
    assert.deepEqual((await db.query("select * from intelligence_jobs order by id")).rows, beforeJobs);
    assert.deepEqual((await db.query("select * from intelligence_directed_research_jobs order by company_id")).rows, beforeDirected);
    assert.deepEqual((await db.query("select * from intelligence_config")).rows, beforeConfig);
  }, false);
  await test("overlapping submissions share twelve live slots with at most six per claim", async () => {
    await manyJobs(30);
    const batches = await Promise.all([claim(99), claim(6), claim(6), claim(1)]);
    assert.deepEqual(batches.map(rows => rows.length), [6,6,0,0]);
    assert.equal(new Set(batches.flatMap(ids)).size, 12);
    assert.equal(await countLive("intelligence_jobs"), 12);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where status='queued'"), 18);
    assert.deepEqual(await scalar("select coverage_claim_turns from intelligence_config"), {});
  });
  await test("completion immediately frees only the available slots without replaying other leases", async () => {
    await manyJobs(20);
    const a = await claim(6), b = await claim(6);
    for (const row of a.slice(0,2)) assert.equal(await done(row), true);
    const next = await claim(6);
    assert.equal(next.length, 2); assert.equal(await countLive("intelligence_jobs"), 12);
    assert.ok(next.every(row => ![...a,...b].some(old => old.id === row.id)));
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where status='complete'"), 2);
  });
  await test("expired leases reclaim with new fences and preserve native answers", async () => {
    await manyJobs(12, { result: replay });
    const a = await claim(6); await claim(6);
    await db.query("update intelligence_jobs set lease_until=now()-interval '1 second' where id=$1", [a[0].id]);
    const [resumed] = await claim(6);
    assert.equal(resumed.id,a[0].id); assert.equal(resumed.attempts,2);
    assert.notEqual(resumed.lease_token,a[0].lease_token); assert.deepEqual(resumed.result,replay);
    assert.equal(await done(a[0]),false); assert.equal(await done(resumed),true);
  });
  await test("already over-cap healthy workers are untouched until they finish naturally", async () => {
    await manyJobs(15, { status: "running", lease: randomUUID(), until: new Date(Date.now()+600000).toISOString() });
    await manyJobs(2);
    const before = (await db.query("select * from intelligence_jobs where status='running' order by id")).rows;
    assert.deepEqual(await claim(6), []);
    assert.deepEqual((await db.query("select * from intelligence_jobs where status='running' order by id")).rows,before);
  });
  await test("view questions and interpretations consume the same global cloud pool", async () => {
    await manyJobs(10, { kind:"view",status:"running",lease:randomUUID(),until:new Date(Date.now()+600000).toISOString() });
    await manyJobs(6);
    assert.equal((await claim(6)).length,2); assert.equal(await countLive("intelligence_jobs"),12);
  });
  await test("six-job claims preserve oldest, two first readings and three fresh signals", async () => {
    const known = await account("known", { interpreted:true }), u1 = await account("uncovered A"), u2 = await account("uncovered B");
    const oldest = await job(known,{minutes:30,result:replay});
    await job(known,{minutes:29,result:replay});
    const first = await job(u1,{minutes:2}), second = await job(u2,{minutes:1});
    const fresh=[]; for(let n=0;n<3;n++) fresh.push(await job(known,{priority:30,minutes:1}));
    assert.deepEqual(new Set(ids(await claim(6))), new Set([oldest,first,second,...fresh]));
  });
  await test("ordinary three-job fairness remains oldest, uncovered, fresh", async () => {
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const oldest=await job(known,{minutes:30,result:replay}),first=await job(missing),fresh=await job(known,{priority:30,minutes:1});
    assert.deepEqual(new Set(ids(await claim(3))),new Set([oldest,first,fresh]));
  });
  await test("single-slot claims retain independent oldest/uncovered/fresh rotation", async () => {
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const old=await job(known,{minutes:30,result:replay}),nextOld=await job(known,{minutes:29,result:replay});
    const first=await job(missing),fresh=await job(known,{priority:30,minutes:1});
    assert.deepEqual(ids(await claim(1)),[old]);
    assert.deepEqual(ids(await claim(1)),[first]);
    assert.deepEqual(ids(await claim(1)),[fresh]);
    assert.deepEqual(ids(await claim(1)),[nextOld]);
  });
  await test("paired claims alternate first-reading and fresh slots beside oldest work", async () => {
    const known=await account("known",{interpreted:true}),missing=await account("missing");
    const old=await job(known,{minutes:30,result:replay}),nextOld=await job(known,{minutes:29,result:replay});
    const first=await job(missing),fresh=await job(known,{priority:30,minutes:1});
    assert.deepEqual(new Set(ids(await claim(2))),new Set([old,first]));
    assert.deepEqual(new Set(ids(await claim(2))),new Set([nextOld,fresh]));
  });
  await test("backoff and attempt limits remain intact and do not kill healthy last attempts", async () => {
    const c=await account("known");
    const future=await job(c,{minutes:-30}), exhausted=await job(c,{attempts:5});
    const healthy=await job(c,{attempts:5,status:"running",lease:randomUUID(),until:new Date(Date.now()+600000).toISOString()});
    assert.deepEqual(await claim(6),[]);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[future]),"queued");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[exhausted]),"failed");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[healthy]),"running");
  });
  await test("directed research permits two healthy accounts across overlapping invocations", async () => {
    await manyAccounts(8);
    const batches=await Promise.all([directed(1),directed(6),directed(2)]);
    assert.deepEqual(batches.map(rows=>rows.length),[1,1,0]);
    assert.equal(new Set(batches.flatMap(rows=>rows.map(row=>row.company_id))).size,2);
    assert.equal(await countLive("intelligence_directed_research_jobs"),2);
    assert.equal(await scalar("select directed_claim_turn::int from intelligence_config"),2);
  });
  await test("directed completion and expired recovery free exactly their own account slots", async () => {
    await manyAccounts(4);
    const [a,b]=await directed(6);
    assert.equal(await doneDirected(a),true);
    const [c]=await directed(2); assert.ok(c); assert.notEqual(c.company_id,a.company_id); assert.notEqual(c.company_id,b.company_id);
    await db.query("update intelligence_directed_research_jobs set lease_until=now()-interval '1 second',due_at=now()-interval '1 day' where company_id=$1",[b.company_id]);
    const [resumed]=await directed(2); assert.equal(resumed.company_id,b.company_id); assert.notEqual(resumed.lease_token,b.lease_token);
    assert.equal(await doneDirected(b),false); assert.equal(await doneDirected(resumed),true);
    assert.equal(await countLive("intelligence_directed_research_jobs"),1);
  });
  await test("directed priority rotation preserves first pass, oldest, oldest", async () => {
    const old=await account("older interpreted",{interpreted:true,minutes:30});
    const nextOld=await account("next interpreted",{interpreted:true,minutes:29});
    const uncovered=await account("uncovered",{minutes:1});
    for(const expected of [uncovered,old,nextOld]) {
      const [chosen]=await directed(1); assert.equal(chosen.company_id,expected); assert.equal(await doneDirected(chosen),true);
    }
  });
  await test("scheduled discovery resumes eligible completed accounts and retains exclusions", async () => {
    const good=await account("due complete");
    const removed=await account("removed"),duplicate=await account("duplicate"),outside=await account("outside"),badId=await account("bad ID");
    await db.query("update intelligence_directed_research_jobs set status='complete',result=$2 where company_id=$1",[good,{outcome:"caught_up"}]);
    await db.query("update companies set status='removed_from_tam' where id=$1",[removed]);
    await db.query("update companies set lists=array['netsuite_tam','tam_duplicate'] where id=$1",[duplicate]);
    await db.query("update companies set lists='{}' where id=$1",[outside]);
    await db.query("update companies set netsuite_internal_id='not-exact' where id=$1",[badId]);
    const [selected]=await directed(2); assert.equal(selected.company_id,good); assert.equal(selected.wake_reason,"scheduled_discovery");
    assert.deepEqual(await directed(2),[]);
  });
  await test("interpretation and account-research capacity remain independent", async () => {
    await manyJobs(15); await manyAccounts(4);
    await claim(6); await claim(6); assert.equal((await directed(2)).length,2);
    assert.deepEqual(await claim(6),[]); assert.deepEqual(await directed(2),[]);
    assert.equal(await countLive("intelligence_jobs"),12); assert.equal(await countLive("intelligence_directed_research_jobs"),2);
  });
  await test("disabled engines do no work and invalid limits cannot create accidental claims", async () => {
    await manyJobs(2); await manyAccounts(2);
    await db.exec("update intelligence_config set enabled=false");
    assert.deepEqual(await claim(6),[]); assert.deepEqual(await directed(2),[]);
    for(const n of [null,0,-1]) {
      await assert.rejects(()=>claim(n),/claim limit must be positive/);
      await assert.rejects(()=>directed(n),/claim limit must be positive/);
    }
  });
  await test("both RPCs retain service-only privileges and identical atomic lock order", async () => {
    for(const fn of ["intelligence_claim(integer)","intelligence_directed_claim(integer)"]) {
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')",[fn]),false);
      assert.equal(await scalar("select has_function_privilege('authenticated',$1,'EXECUTE')",[fn]),false);
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",[fn]),true);
      const def=await scalar("select pg_get_functiondef($1::regprocedure)",[fn]);
      const config=def.indexOf("select enabled into engine_enabled from intelligence_config where id=1 for update");
      const capacity=def.indexOf("perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0))");
      const snapshot=def.indexOf("select greatest(0,");
      assert.ok(config>=0&&capacity>config&&snapshot>capacity);
      assert.ok(def.includes("for update")&&def.includes("skip locked"));
    }
    assert.equal(await scalar("select count(*)::int from pg_indexes where indexname in ('intelligence_jobs_running_capacity','intelligence_directed_running_capacity')"),2);
  });
  console.log(`${passed} worker-capacity PostgreSQL tests passed`);
} catch (error) {
  console.error(error.message,error.detail??"",error.internalQuery??"",error.query??""); process.exitCode=1;
} finally { await db.close(); }
