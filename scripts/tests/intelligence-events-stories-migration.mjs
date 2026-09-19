/** Synthetic local PostgreSQL semantics; no provider or production calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const company = randomUUID(), other = randomUUID();
const attrs = { companyRelationship: "direct", companyRelevance: .95, concreteEvent: .94, signalType: "ma", evidenceExcerpt: "Synthetic acquisition." };
async function observation({ account = company, title = "Synthetic acquires Boston Precision Manufacturing business", url = `https://example.test/${randomUUID()}`, date = "2026-09-18", attributes = attrs } = {}) {
  const id = randomUUID();
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,event_date,attributes)
    values($1,$2,$3,'news',$3,$4,'Synthetic public source.', $7,$5,$6)`, [id, account, url, title, date, attributes, id]);
  return id;
}
const attach = id => scalar("select intelligence_event_attach($1)", [id]);
const enqueue = (hash, force = false) => scalar("select intelligence_story_enqueue($1,$2,$3)", [company, hash, force]);
const claim = () => db.query("select * from intelligence_story_claim(1)").then(result => result.rows[0]);
const finish = (job, status, args = {}) => scalar(`select intelligence_story_finish($1,$2,$3,$4,$5,60,$6,$7,$8,$9,$10)`,
  [company, job.lease_token, job.desired_hash, status, args.error ?? null, args.story ?? null, args.ids ?? [], {}, args.model ?? null, args.version ?? null]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const filename of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0063_intelligence_event_stories.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  await db.exec("update intelligence_config set enabled=true");
  for (const id of [company, other]) await db.query("insert into companies(id,status,name) values($1,'new','Synthetic')", [id]);
  const first = await observation(), second = await observation({ title: "Synthetic announces Boston Precision Manufacturing business acquisition" });
  let event;
  await test("same headline across URLs has one event and repeated delivery has one membership", async () => {
    event = await attach(first);
    const duplicate = await observation();
    assert.equal((await attach(duplicate)).id, event.id);
    assert.equal((await attach(duplicate)).revision, 2);
    assert.equal(await scalar("select count(*) from intelligence_event_observations where event_id=$1", [event.id]), 2);
  });
  await test("different named acquisitions and widely separated dates remain distinct", async () => {
    const named = await observation({ title: "Synthetic acquires Seattle Industrial Distribution business" });
    assert.notEqual((await attach(named)).id, event.id);
    const old = await observation({ date: "2024-01-01" });
    assert.notEqual((await attach(old)).id, event.id);
    const unknownDate = await observation({ date: null });
    assert.notEqual((await attach(unknownDate)).id, event.id);
  });
  await test("generic or related-company observations cannot become direct event facts", async () => {
    assert.equal(await attach(await observation({ attributes: { ...attrs, signalType: "none" } })), null);
    assert.equal(await attach(await observation({ attributes: { ...attrs, companyRelationship: "related" } })), null);
    assert.notEqual((await attach(await observation({ account: other }))).id, event.id);
  });
  const trigger = randomUUID(), wrongTrigger = randomUUID();
  await test("progressive source links enrich the exact original trigger without altering Jev answers", async () => {
    await db.query("insert into triggers(id,company_id,metadata) values($1,$2,'{}'),($3,$4,'{}')", [trigger, company, wrongTrigger, other]);
    assert.equal(await scalar("select intelligence_event_bind_trigger($1,$2)", [event.id, wrongTrigger]), false);
    assert.equal(await scalar("select intelligence_event_bind_trigger($1,$2)", [event.id, trigger]), true);
    const another = await observation(); await attach(another);
    assert.equal((await scalar("select metadata->'intelligenceEvent'->'sources' from triggers where id=$1", [trigger])).length, 3);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [first]), attrs);
    await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [another]);
    const source = (await scalar("select metadata->'intelligenceEvent'->'sources' from triggers where id=$1", [trigger])).find(item => item.observationId === another);
    assert.equal(source.excluded, true);
    assert.equal(await scalar("select evidence_count from intelligence_events where id=$1", [event.id]), 2);
  });
  await test("event-key uniqueness stops simultaneous syndicated publications and missing events backfill", async () => {
    const key = randomUUID();
    await db.query("insert into triggers(company_id,metadata) values($1,$2)", [company, { jevFinding: { eventId: key } }]);
    await assert.rejects(db.query("insert into triggers(company_id,metadata) values($1,$2)", [company, { jevFinding: { eventId: key } }]));
    const missed = await observation({ title: "Synthetic wins distinct laboratory expansion contract" });
    assert.ok(await scalar("select intelligence_event_backfill(50)") >= 1);
    assert.equal(await scalar("select count(*) from intelligence_event_observations where observation_id=$1", [missed]), 1);
    assert.equal(await scalar("select intelligence_event_backfill(50)"), 0);
  });
  await test("saved interpretation transaction leaves a durable story wakeup even if HTTP worker vanishes", async () => {
    await db.query("update intelligence_observations set attributes=$2 where id=$1", [first, attrs]);
    const wakeup = (await db.query("select * from intelligence_story_jobs where company_id=$1", [company])).rows[0];
    assert.equal(wakeup.desired_hash, "0".repeat(64)); assert.equal(wakeup.status, "queued");
  });
  await test("story queue coalesces unchanged evidence and fences obsolete workers", async () => {
    assert.equal(await enqueue("a".repeat(64)), true);
    const old = await claim(); assert.equal(old.status, "running");
    assert.equal(await enqueue("a".repeat(64)), false);
    assert.equal(await claim(), undefined);
    assert.equal(await enqueue("b".repeat(64)), true);
    assert.equal(await finish(old, "failed", { error: "old" }), false);
    const current = await claim(); assert.equal(current.desired_hash, "b".repeat(64));
    assert.equal(await finish(current, "queued", { error: "budget_deferred" }), true);
    assert.equal(await claim(), undefined);
  });
  await test("expired leases resume saved generation checkpoints without accepting old owner", async () => {
    await db.exec("update intelligence_story_jobs set due_at=now()");
    const old = await claim();
    await db.query("update intelligence_story_jobs set checkpoint=$1,lease_until=now()-interval '1 second'", [{ synthetic: "paid_result" }]);
    const current = await claim(); assert.notEqual(current.lease_token, old.lease_token);
    assert.deepEqual(current.checkpoint, { synthetic: "paid_result" });
    assert.equal(await finish(old, "failed"), false);
    assert.equal(await finish(current, "failed", { error: "synthetic" }), true);
    assert.equal(await enqueue("b".repeat(64), true), true);
  });
  const story = { overview: [{ text: "Synthetic public account research", citations: [first] }], developments: [], hypotheses: [], contradictions: [], unknowns: [] };
  await test("completed stories retain versions and enforce exact-account source membership", async () => {
    const job = await claim();
    const otherSource = await observation({ account: other });
    await assert.rejects(finish(job, "complete", { story, ids: [otherSource], model: "writer", version: "v1" }));
    assert.equal(await finish(job, "complete", { story, ids: [first], model: "writer", version: "v1" }), true);
    assert.equal(await enqueue("c".repeat(64)), true);
    assert.equal(await finish(await claim(), "complete", { story, ids: [first, second], model: "writer", version: "v1" }), true);
    assert.equal(await scalar("select count(*) from intelligence_account_stories where company_id=$1", [company]), 2);
    await db.query("update intelligence_observations set attributes=$2 where id=$1", [first, attrs]);
    assert.equal(await enqueue("c".repeat(64)), false);
    assert.equal(await scalar("select status from intelligence_story_jobs where company_id=$1", [company]), "complete");
    assert.equal(await claim(), undefined);
  });
  await test("new tables and mutation functions are service-only and runtime switch stops claiming", async () => {
    for (const table of ["intelligence_events", "intelligence_event_observations", "intelligence_story_jobs", "intelligence_account_stories"])
      assert.equal(await scalar("select relrowsecurity from pg_class where relname=$1", [table]), true);
    for (const signature of ["intelligence_event_attach(uuid,jsonb)", "intelligence_event_bind_trigger(uuid,uuid)", "intelligence_story_enqueue(uuid,text,boolean)", "intelligence_story_claim(integer)"])
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')", [signature]), false);
    await enqueue("d".repeat(64)); await db.exec("update intelligence_config set enabled=false");
    assert.equal(await claim(), undefined);
  });
  console.log(`${passed} PostgreSQL event/story checks passed.`);
} catch (error) { console.error(error.message, error.detail ?? "", error.where ?? ""); process.exitCode = 1; }
finally { await db.close(); }
