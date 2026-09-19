/** Synthetic local PostgreSQL semantics; no provider or production calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const company = randomUUID(), source = randomUUID();
const hash = char => char.repeat(64);
const enqueue = (value, force = false) => scalar("select intelligence_story_enqueue($1,$2,$3)", [company, value, force]);
const claim = () => db.query("select * from intelligence_story_claim(1)").then(result => result.rows[0]);
const current = () => db.query("select * from intelligence_story_jobs where company_id=$1", [company]).then(result => result.rows[0]);
const finish = (job, status) => scalar("select intelligence_story_finish($1,$2,$3,$4,null,60,$5,$6,'{}',$7,$8)",
  [company, job.lease_token, job.desired_hash, status, status === "complete" ? { overview: [] } : null,
    status === "complete" ? [source] : [], status === "complete" ? "synthetic-writer" : null, status === "complete" ? "test-v1" : null]);
const dirty = () => db.query("update intelligence_observations set attributes=attributes where id=$1", [source]);
const due = () => db.query("update intelligence_story_jobs set due_at=now() where company_id=$1", [company]);
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const filename of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0063_intelligence_event_stories.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  await db.exec("update intelligence_config set enabled=true");
  await db.query("insert into companies(id,status,name) values($1,'new','Synthetic')", [company]);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
    values($1,$2,'test','news','https://example.test/news','Synthetic event','Synthetic public source.','test',$3)`,
  [source, company, { companyRelationship: "direct", companyRelevance: .95, concreteEvent: .9, signalType: "press" }]);
  await enqueue(hash("a"), true); await finish(await claim(), "failed");
  assert.equal((await current()).force_requested, true, "0063 reproduces the terminal sticky flag");
  await db.exec(await readFile(new URL("../../supabase/migrations/0070_intelligence_story_force_lifecycle.sql", import.meta.url), "utf8"));
  await test("migration clears old terminal flags and retains service-role-only execution", async () => {
    assert.equal((await current()).force_requested, false);
    assert.equal(await scalar("select has_function_privilege('anon','intelligence_story_enqueue(uuid,text,boolean)','EXECUTE')"), false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_story_enqueue(uuid,text,boolean)','EXECUTE')"), true);
  });
  await test("manual completion does not permanently force subsequent automatic work", async () => {
    await enqueue(hash("b"), true); assert.equal(await finish(await claim(), "complete"), true);
    assert.equal((await current()).force_requested, false);
    await dirty(); assert.equal((await current()).desired_hash, hash("0"));
    assert.equal((await current()).force_requested, false);
    await enqueue(hash("c")); assert.equal((await current()).force_requested, false);
  });
  await test("same-hash concurrent manual upgrade fences the old automatic worker", async () => {
    const automatic = await claim(); assert.equal(automatic.force_requested, false);
    assert.equal(await enqueue(hash("c"), true), true);
    assert.equal(await finish(automatic, "superseded"), false);
    const manual = await claim(); assert.equal(manual.force_requested, true);
    assert.notEqual(manual.lease_token, automatic.lease_token);
    assert.equal(await enqueue(hash("c"), true), false, "duplicate manual click retains the live forced lease");
    assert.equal((await current()).lease_token, manual.lease_token);
    assert.equal(await finish(manual, "queued"), true);
    assert.equal((await current()).force_requested, true, "budget/provider retries retain manual intent");
    assert.equal(await claim(), undefined, "retry backoff remains intact");
  });
  await test("dirty supersession transfers a pending forced request and rejects its old lease", async () => {
    await due(); const manual = await claim();
    await dirty(); assert.equal((await current()).force_requested, true);
    const wakeup = await claim(); assert.equal(wakeup.desired_hash, hash("0"));
    await enqueue(hash("d"), wakeup.force_requested);
    assert.equal(await finish(wakeup, "superseded"), false);
    assert.equal(await finish(manual, "complete"), false);
    const replacement = await claim(); assert.equal(replacement.force_requested, true);
    assert.equal(await finish(replacement, "complete"), true);
    assert.equal((await current()).force_requested, false);
  });
  await test("a concurrent different-evidence manual request survives the old worker's finish", async () => {
    await enqueue(hash("e")); const automatic = await claim();
    await enqueue(hash("f"), true);
    assert.equal(await finish(automatic, "failed"), false);
    assert.equal((await current()).force_requested, true);
    assert.equal((await current()).desired_hash, hash("f"));
    assert.equal(await finish(await claim(), "failed"), true);
    assert.equal((await current()).force_requested, false);
  });
  await test("terminal supersession consumes force but a fresh manual request can retry", async () => {
    await enqueue(hash("f"), true); assert.equal(await finish(await claim(), "superseded"), true);
    assert.equal((await current()).force_requested, false);
    assert.equal(await enqueue(hash("f"), true), true);
    assert.equal((await current()).force_requested, true);
  });
  await test("cached-story reuse satisfies the pending manual request without keeping force set", async () => {
    assert.equal(await enqueue(hash("b"), true), false);
    const row = await current(); assert.equal(row.status, "complete"); assert.equal(row.force_requested, false);
    await dirty(); assert.equal((await current()).force_requested, false);
  });
  console.log(`${passed} story force lifecycle checks passed`);
} finally { await db.close(); }
