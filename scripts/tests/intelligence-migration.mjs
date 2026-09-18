/** Ephemeral PostgreSQL regression checks; never connects to Supabase.
 * Optional test dependency: install @electric-sql/pglite@0.5.8 in
 * work/intelligence-sql-test, then run node scripts/tests/intelligence-migration.mjs.
 * PGlite serializes connections, so these checks do not prove concurrent locking.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const account = "10000000-0000-4000-8000-000000000001";
const tests = [];
const test = (name, run) => tests.push({ name, run });
const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const scalar = async (sql, params = []) => Object.values(await row(sql, params))[0];

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.companies(id uuid primary key, status text not null);
  create table public.trigger_candidates(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), verdict text, promoted_trigger_id uuid);
  insert into companies values ('${account}', 'new');
`);
await db.exec(await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8"));

async function reset() {
  await db.exec(`
    truncate intelligence_view_matches, intelligence_jobs, intelligence_feedback, intelligence_source_state,
      intelligence_observations, intelligence_views, intelligence_spend, trigger_candidates;
    update intelligence_config set enabled=true, monthly_limit_usd=20, jev_limit_usd=10, generation_limit_usd=5;
  `);
}
async function observe(hash = "a", source = "https://example.test/news") {
  return scalar(`select intelligence_observe($1,$2,'news',$2,'Example expansion','A new facility was announced.',$3,
    '2026-09-17T00:00:00Z',now(),'{}','[]','v1')`, [account, source, hash]);
}
const claim = () => row("select * from intelligence_claim(1)");
const finish = (job, status = "complete", extra = {}) => scalar(
  "select intelligence_finish($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  [job.id, job.lease_token, status, {}, extra.attributes ?? { signalType: "press" }, "v1", extra.probability ?? null, extra.error ?? null, 30],
);
async function view() {
  return (await row("insert into intelligence_views(name,question) values ('Expansion','Does this source establish expansion?') returning id")).id;
}

test("disabled capture, atomic deduplication and current source versions", async () => {
  await db.exec("update intelligence_config set enabled=false");
  assert.deepEqual(await observe(), { disabled: true });
  assert.equal(await scalar("select count(*)::int from intelligence_jobs"), 0);
  await db.exec("update intelligence_config set enabled=true");
  const first = await observe();
  const replay = await observe();
  assert.equal(first.id, replay.id);
  assert.equal(first.queued, true);
  assert.equal(replay.queued, false);
  assert.equal(await scalar("select count(*)::int from intelligence_jobs"), 1);
  const next = await observe("b");
  assert.notEqual(next.id, first.id);
  assert.deepEqual((await db.query("select id from intelligence_observations where is_current")).rows, [{ id: next.id }]);
  await db.query("update intelligence_observations set attributes=$2 where id=$1", [first.id, { retained: true }]);
  await observe("a");
  assert.deepEqual(await row("select is_current,attributes from intelligence_observations where id=$1", [first.id]), { is_current: true, attributes: { retained: true } });
  assert.equal(await scalar("select count(*)::int from intelligence_observations where is_current"), 1);
});

test("claim leases fence late completions and repeated finish calls", async () => {
  const observation = await observe();
  const original = await claim();
  assert.equal(await claim(), undefined);
  await db.query("update intelligence_jobs set lease_until=now()-interval '1 second' where id=$1", [original.id]);
  const replacement = await claim();
  assert.equal(replacement.id, original.id);
  assert.notEqual(replacement.lease_token, original.lease_token);
  assert.equal(await finish(original), false);
  assert.equal(await finish(replacement), true);
  assert.equal(await finish(replacement), false);
  assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [observation.id]), { signalType: "press" });
});

test("old source completion cannot overwrite the current content version", async () => {
  await observe("old");
  const job = await claim();
  const current = await observe("new");
  await finish(job);
  assert.equal(await scalar("select attributes from intelligence_observations where id=$1 and is_current", [current.id]), null);
});

test("returning source content resumes superseded work without repeating completed work", async () => {
  const savedView = await view();
  const original = await observe("a");
  await db.query("update intelligence_jobs set status='superseded',attempts=5,finished_at=now() where observation_id=$1", [original.id]);
  await observe("b");
  const replay = await observe("a");
  assert.equal(replay.id, original.id);
  assert.equal(replay.queued, true);
  assert.equal(await scalar("select count(*)::int from intelligence_jobs where observation_id=$1 and status='queued' and attempts=0", [original.id]), 2);
  await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [original.id]);
  const completedReplay = await observe("a");
  assert.equal(completedReplay.queued, false);
  assert.equal(await scalar("select status from intelligence_jobs where observation_id=$1 and view_id=$2", [original.id, savedView]), "complete");
});

test("normal progress continuations do not exhaust provider retry attempts", async () => {
  await observe();
  for (let i = 0; i < 7; i++) {
    const job = await claim();
    assert.ok(job, `continuation ${i + 1} should remain claimable`);
    assert.equal(await finish(job, "queued", { error: "continuation" }), true);
    await db.exec("update intelligence_jobs set due_at=now()-interval '1 second'");
  }
  assert.equal((await claim()).attempts, 1);
});

test("category and total caps include unsettled reservations and permit released headroom", async () => {
  await db.exec("update intelligence_config set monthly_limit_usd=1.5,jev_limit_usd=1,generation_limit_usd=1");
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  assert.equal(await scalar("select intelligence_reserve($1,'jev',1)", [a]), true);
  assert.equal(await scalar("select intelligence_reserve($1,'jev',0.01)", [randomUUID()]), false);
  assert.equal(await scalar("select intelligence_reserve($1,'generation',0.5)", [b]), true);
  assert.equal(await scalar("select intelligence_reserve($1,'generation',0.01)", [randomUUID()]), false);
  assert.equal(await scalar("select intelligence_settle($1,0.4,1000)", [a]), true);
  assert.equal(await scalar("select intelligence_reserve($1,'jev',0.5)", [c]), true);
  assert.equal(await scalar("select intelligence_reserve($1,'jev',0.1)", [a]), false);
  assert.equal(await scalar("select intelligence_settle($1,null,null)", [b]), true);
  assert.equal(await scalar("select intelligence_settle($1,0,null)", [b]), false);
  const status = await scalar("select intelligence_status()");
  assert.deepEqual(status.spend, { usedUsd: 0.9, reservedUsd: 0.5, limitUsd: 1.5 });
});

test("UTC budget month excludes prior-month charges and cannot redispatch an old key", async () => {
  const prior = randomUUID();
  await db.query("insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,state) values ($1,(date_trunc('month',now() at time zone 'UTC')-interval '1 month')::date,'jev',20,20,'settled')", [prior]);
  await db.exec("update intelligence_config set monthly_limit_usd=1,jev_limit_usd=1");
  assert.equal(await scalar("select intelligence_reserve($1,'jev',1)", [randomUUID()]), true);
  assert.equal(await scalar("select intelligence_reserve($1,'jev',0.01)", [prior]), false);
  assert.deepEqual((await scalar("select intelligence_status()")).spend, { usedUsd: 0, reservedUsd: 1, limitUsd: 1 });
});

test("view backfill pages resume without duplication and new observations enqueue directly", async () => {
  await observe("a", "https://example.test/a");
  await observe("b", "https://example.test/b");
  await observe("c", "https://example.test/c");
  const id = await view();
  assert.equal(await scalar("select intelligence_backfill_view($1,2)", [id]), 2);
  assert.equal(await scalar("select backfill_complete from intelligence_views where id=$1", [id]), false);
  assert.equal(await scalar("select intelligence_backfill_view($1,2)", [id]), 1);
  assert.equal(await scalar("select intelligence_backfill_view($1,2)", [id]), 0);
  await observe("d", "https://example.test/d");
  assert.equal(await scalar("select count(*)::int from intelligence_jobs where kind='view' and view_id=$1", [id]), 4);
});

test("reactivated views backfill missed observations and revive interrupted view work", async () => {
  await observe("a", "https://example.test/a");
  const id = await view();
  await scalar("select intelligence_backfill_view($1,100)", [id]);
  await db.query("update intelligence_views set active=false where id=$1", [id]);
  await db.query("update intelligence_jobs set status='superseded',finished_at=now(),attempts=5 where view_id=$1", [id]);
  const missed = await observe("b", "https://example.test/b");
  await db.query("update intelligence_views set active=true where id=$1", [id]);
  assert.equal(await scalar("select backfill_complete from intelligence_views where id=$1", [id]), false);
  await scalar("select intelligence_backfill_view($1,100)", [id]);
  assert.equal(await scalar("select count(*)::int from intelligence_jobs where view_id=$1 and status='queued'", [id]), 2);
  assert.equal(await scalar("select count(*)::int from intelligence_jobs where view_id=$1 and observation_id=$2", [id, missed.id]), 1);
});

test("candidate reviewer claims do not duplicate an unexpired lease", async () => {
  await db.exec("insert into trigger_candidates default values");
  const first = await row("select * from intelligence_claim_candidates(1)");
  assert.equal(await row("select * from intelligence_claim_candidates(1)"), undefined);
  await db.query("update trigger_candidates set review_lease_until=now()-interval '1 second' where id=$1", [first.id]);
  const second = await row("select * from intelligence_claim_candidates(1)");
  assert.notEqual(second.review_lease_token, first.review_lease_token);
  assert.equal(second.review_attempts, 2);
  await db.query("update trigger_candidates set verdict='keep',review_lease_until=now()-interval '1 second' where id=$1", [first.id]);
  const recovery = await row("select * from intelligence_claim_candidates(1)");
  assert.equal(recovery.id, first.id);
  assert.equal(recovery.verdict, "keep");
  await db.query("update trigger_candidates set promoted_trigger_id=$2,review_lease_until=null where id=$1", [first.id, randomUUID()]);
  assert.equal(await row("select * from intelligence_claim_candidates(1)"), undefined);
});

test("only service_role has intelligence table access and RPC execution", async () => {
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' and tablename like 'intelligence_%' order by tablename")).rows;
  for (const { tablename } of tables) {
    assert.equal(await scalar("select has_table_privilege('anon',$1,'SELECT')", [tablename]), false);
    assert.equal(await scalar("select has_table_privilege('authenticated',$1,'INSERT')", [tablename]), false);
    assert.equal(await scalar("select has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE')", [tablename]), true);
    assert.equal(await scalar("select relrowsecurity from pg_class where oid=$1::regclass", [tablename]), true);
  }
  const functions = (await db.query("select oid::text from pg_proc where pronamespace='public'::regnamespace and proname like 'intelligence_%'")).rows;
  for (const { oid } of functions) {
    assert.equal(await scalar("select has_function_privilege('anon',$1::oid,'EXECUTE')", [oid]), false);
    assert.equal(await scalar("select has_function_privilege('authenticated',$1::oid,'EXECUTE')", [oid]), false);
    assert.equal(await scalar("select has_function_privilege('service_role',$1::oid,'EXECUTE')", [oid]), true);
  }
});

let failed = 0;
for (const { name, run } of tests) {
  try { await reset(); await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack ?? error}`); }
}
await db.close();
console.log(`${tests.length - failed}/${tests.length} migration checks passed (ephemeral PostgreSQL).`);
process.exitCode = failed ? 1 : 0;
