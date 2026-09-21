import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const account = randomUUID();
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const claim = async () => (await db.query("select * from intelligence_directed_claim(1)")).rows[0];
const finish = (job, status = "complete", result = { outcome: "caught_up", sweep: { knownSources: 0, unreadSources: 0, dueSources: 0, leasedSources: 0, retrySources: 0 } }) =>
  scalar("select intelligence_directed_finish($1,$2,$3,$4,86400,$5,null)", [job.company_id,job.lease_token,job.desired_hash,status,result]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[],
      website_raw text,ns_industry text,city text,state text);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql",
    "0067_intelligence_directed_research_queue.sql", "0074_directed_research_discovery.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  await db.exec("alter table intelligence_research_sources add column metadata jsonb not null default '{}'; update intelligence_config set enabled=true");
  await db.query("insert into companies(id,status,name,netsuite_internal_id,lists) values($1,'new','No website account','123',array['netsuite_tam'])", [account]);
  await db.exec(await readFile(new URL("../../supabase/migrations/0107_intelligence_research_caught_up.sql", import.meta.url), "utf8"));
  await test("uncovered and domainless current accounts enter the existing discovery queue without model jobs", async () => {
    assert.equal(await scalar("select count(*)::int from intelligence_directed_research_jobs"), 1);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs"), 0);
    assert.equal(await scalar("select wake_reason from intelligence_directed_research_jobs"), "first_pass");
  });
  await test("caught-up work sleeps but keeps a bounded scheduled discovery wake", async () => {
    const job = await claim(); assert.ok(job); assert.equal(await finish(job), true);
    assert.equal(await claim(), undefined);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs"), "complete");
    assert.ok(await scalar("select caught_up_at is not null from intelligence_directed_research_jobs"));
    await db.exec("update intelligence_directed_research_jobs set due_at=now()-interval '1 second'");
    const next = await claim(); assert.equal(next.wake_reason, "scheduled_discovery");
    assert.equal(await finish(next), true);
  });
  await test("pending/verified URL order and routine capture clocks do not wake sleeping research", async () => {
    await db.query("insert into intelligence_source_state(company_id,source_key,cursor) values($1,'website',$2)", [account,
      { knownUrls: ["https://example.com/b", "https://example.com/a"], pendingUrls: ["https://example.com/a"], baselineCapturedAt: "2026-09-20" }]);
    const job = await claim(); assert.equal(await finish(job), true);
    const before = await scalar("select desired_hash from intelligence_directed_research_jobs");
    await db.query("update intelligence_source_state set cursor=$2 where company_id=$1", [account,
      { verifiedUrls: ["https://example.com/a", "https://example.com/b"], knownUrls: ["https://example.com/a"], baselineCapturedAt: "2026-09-21" }]);
    assert.equal(await scalar("select desired_hash from intelligence_directed_research_jobs"), before);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs"), "complete");
  });
  await test("new source during a healthy lease survives completion without canceling the reader", async () => {
    await db.exec("update intelligence_directed_research_jobs set due_at=now()");
    const job = await claim();
    await db.query("insert into intelligence_research_sources(company_id,source_url,title,discovered_from) values($1,'https://example.com/new','New source','https://example.com/')", [account]);
    assert.equal(await scalar("select lease_token from intelligence_directed_research_jobs"), job.lease_token);
    assert.notEqual(await scalar("select desired_hash from intelligence_directed_research_jobs"), job.desired_hash);
    assert.equal(await finish(job), false);
    const next = await claim(); assert.ok(next); assert.notEqual(next.lease_token, job.lease_token);
    assert.equal(await finish(job), false); assert.equal(await finish(next), true);
  });
  await test("rediscovery timestamp alone is free; a new headline or identity wakes research", async () => {
    await db.query("update intelligence_research_sources set metadata=$2 where company_id=$1", [account, { discoveredAt: "2026-09-21" }]);
    assert.equal(await claim(), undefined);
    await db.query("update intelligence_research_sources set title='Announces acquisition' where company_id=$1", [account]);
    const changed = await claim(); assert.ok(changed); assert.equal(await finish(changed), true);
    await db.query("update companies set city='New City' where id=$1", [account]);
    const identity = await claim(); assert.ok(identity); assert.equal(await finish(identity), true);
    await db.query("update companies set city='New City' where id=$1", [account]); assert.equal(await claim(), undefined);
  });
  await test("completed receipts require caught_up and old or expired leases cannot finalize", async () => {
    await db.exec("update intelligence_directed_research_jobs set due_at=now()"); const job = await claim();
    await assert.rejects(finish(job, "complete", { outcome: "refreshed" }), /missing_caught_up_receipt/);
    await db.exec("update intelligence_directed_research_jobs set lease_until=now()-interval '1 second'");
    assert.equal(await finish(job), false); const resumed = await claim(); assert.ok(resumed);
    assert.equal(await finish(resumed), true);
  });
  await test("a discovered-source change during its URL lease survives the old completion", async () => {
    const url="https://example.com/new";
    const source=async()=> (await scalar("select intelligence_research_claim($1,$2)",[account,[url]]))[0];
    const done=(lease)=>scalar("select intelligence_research_finish($1,$2,$3,'unchanged')",[account,url,lease]);
    const first=await source(); assert.ok(first);
    const before=await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]);
    await db.query("update intelligence_research_sources set metadata=$3 where company_id=$1 and source_url=$2",[account,url,{researchOrigin:"external_search",query:"Company acquisition",discoveredAt:"2026-09-21"}]);
    const changed=(await db.query("select * from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url])).rows[0];
    assert.equal(changed.lease_token,first.lease_token); assert.equal(changed.claimed_generation,before); assert.equal(changed.refresh_generation,before+1);
    assert.equal(await source(),undefined);
    assert.equal(await done(first.lease_token),true);
    assert.equal(await scalar("select next_attempt_at<=now() from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),true);
    const second=await source(); assert.ok(second); assert.notEqual(second.lease_token,first.lease_token);
    assert.equal(await done(first.lease_token),false); assert.equal(await done(second.lease_token),true);
    assert.equal(await scalar("select next_attempt_at>now()+interval '6 days' from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),true);
    assert.equal(await source(),undefined);
    await db.query("update intelligence_research_sources set metadata=jsonb_set(metadata,'{discoveredAt}','\"2026-09-22\"') where company_id=$1 and source_url=$2",[account,url]);
    assert.equal(await source(),undefined);
    assert.equal(await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),before+1);
  });
  await test("real account context changes advance one revision and preserve live URL readers; no-op writes do neither", async () => {
    const url="https://example.com/new";
    const revision=()=>scalar("select context_revision::int from intelligence_directed_research_jobs where company_id=$1",[account]);
    const before=await revision();
    await db.query("update companies set domain='example.com' where id=$1",[account]);
    assert.equal(await revision(),before+1);
    const reader=(await scalar("select intelligence_research_claim($1,$2)",[account,[url]]))[0]; assert.ok(reader);
    const generation=await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]);
    await db.query("update companies set city='Second City' where id=$1",[account]);
    assert.equal(await revision(),before+2);
    assert.equal(await scalar("select lease_token from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),reader.lease_token);
    assert.equal(await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),generation+1);
    assert.equal(await scalar("select intelligence_research_finish($1,$2,$3,'unchanged')",[account,url,reader.lease_token]),true);
    assert.equal(await scalar("select next_attempt_at<=now() from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),true);
    const hash=await scalar("select desired_hash from intelligence_directed_research_jobs where company_id=$1",[account]);
    await db.query("update companies set city='Second City',domain='example.com',lists=array['netsuite_tam'] where id=$1",[account]);
    assert.equal(await revision(),before+2);
    assert.equal(await scalar("select desired_hash from intelligence_directed_research_jobs where company_id=$1",[account]),hash);
    assert.equal(await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url=$2",[account,url]),generation+1);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs"),0);
  });
  await test("finding the same source through another search preserves provenance without waking research", async () => {
    const before=(await db.query("select desired_hash,status,due_at from intelligence_directed_research_jobs where company_id=$1",[account])).rows[0];
    const generation=await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url='https://example.com/new'",[account]);
    await db.query("update intelligence_research_sources set metadata=metadata||$2::jsonb where company_id=$1",[account,
      {query:'Different search terms',queryHash:'different-hash',researchPurpose:'identity_company_family',discoveredAt:'2026-09-23'}]);
    assert.deepEqual((await db.query("select desired_hash,status,due_at from intelligence_directed_research_jobs where company_id=$1",[account])).rows[0],before);
    assert.equal(await scalar("select refresh_generation from intelligence_research_attempts where company_id=$1 and source_url='https://example.com/new'",[account]),generation);
    assert.equal(await scalar("select metadata->>'queryHash' from intelligence_research_sources where company_id=$1 and source_url='https://example.com/new'",[account]),'different-hash');
  });
  await test("new eligible inserts and membership changes enroll without altering excluded account holds", async () => {
    const fresh=randomUUID(),later=randomUUID();
    await db.query("insert into companies(id,status,name,netsuite_internal_id,lists) values($1,'new','Fresh domainless','124',array['netsuite_tam'])",[fresh]);
    assert.equal(await scalar("select context_revision::int from intelligence_directed_research_jobs where company_id=$1",[fresh]),0);
    await db.query("insert into companies(id,status,name,lists) values($1,'new','Outside TAM','{}')",[later]);
    await db.query("update companies set lists=array['netsuite_tam'] where id=$1",[later]);
    assert.equal(await scalar("select count(*)::int from intelligence_directed_research_jobs where company_id=$1",[later]),0);
    await db.query("update companies set netsuite_internal_id='125' where id=$1",[later]);
    assert.equal(await scalar("select context_revision::int from intelligence_directed_research_jobs where company_id=$1",[later]),0);
    await db.query("update intelligence_directed_research_jobs set status='complete',due_at=now()+interval '7 days' where company_id=$1",[later]);
    await db.query("update companies set status='removed_from_tam',city='Excluded City' where id=$1",[later]);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1",[later]),"complete");
    assert.equal(await scalar("select context_revision::int from intelligence_directed_research_jobs where company_id=$1",[later]),0);
    await db.query("update companies set status='new' where id=$1",[later]);
    assert.equal(await scalar("select status='queued' and due_at<=now() from intelligence_directed_research_jobs where company_id=$1",[later]),true);
    await db.query("update companies set lists=array['netsuite_tam','tam_duplicate'] where id=$1",[fresh]);
    await db.query("update intelligence_directed_research_jobs set status='complete',due_at=now()+interval '7 days' where company_id=$1",[fresh]);
    await db.query("update companies set name='Excluded duplicate name' where id=$1",[fresh]);
    assert.equal(await scalar("select context_revision::int from intelligence_directed_research_jobs where company_id=$1",[fresh]),0);
    await db.query("update companies set lists=array['netsuite_tam'] where id=$1",[fresh]);
    assert.equal(await scalar("select status='queued' and due_at<=now() from intelligence_directed_research_jobs where company_id=$1",[fresh]),true);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs"),0);
  });
  await test("runtime disable and service-only grants remain intact", async () => {
    for (const fn of ["intelligence_directed_refresh(uuid)", "intelligence_directed_claim(integer)", "intelligence_directed_finish(uuid,uuid,text,text,integer,jsonb,text)",
      "intelligence_research_claim(uuid,text[])","intelligence_research_finish(uuid,text,uuid,text)"])
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')", [fn]), false);
    await db.exec("update intelligence_directed_research_jobs set due_at=now(); update intelligence_config set enabled=false");
    assert.equal(await claim(), undefined);
  });
  console.log(`${passed} caught-up PostgreSQL scenarios passed.`);
} catch (error) { console.error(error.message, error.detail ?? "", error.where ?? ""); process.exitCode = 1; }
finally { await db.close(); }
