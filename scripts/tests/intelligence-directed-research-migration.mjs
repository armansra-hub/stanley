import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const company = randomUUID(), observation = randomUUID();
const attrs = { companyRelationship: "direct", companyRelevance: .9, concreteEvent: .9, requiresResearch: .8, operationalComplexity: .6, signalType: "press" };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const claim = () => db.query("select * from intelligence_directed_claim(1)").then(result => result.rows[0]);
const finish = (job, result = {}, retry = 600) => scalar("select intelligence_directed_finish($1,$2,$3,'queued',$4,$5,null)", [company, job.lease_token, job.desired_hash, retry, result]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const filename of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0067_intelligence_directed_research_queue.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  await db.query("insert into companies(id,status,name) values($1,'new','Synthetic')", [company]);
  await db.exec("update intelligence_config set enabled=true");
  await test("interpreted promising evidence creates an automatic account wakeup", async () => {
    await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
      values($1,$2,'source','website','https://example.test/news','Expansion','Synthetic source for a new facility.','hash-a',$3)`, [observation, company, attrs]);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "queued");
  });
  await test("unchanged evidence and URL state preserve active ownership and defer repeated work", async () => {
    const job = await claim();
    assert.equal(await claim(), undefined);
    await db.query("update intelligence_observations set attributes=$2 where id=$1", [observation, attrs]);
    assert.equal(await scalar("select lease_token from intelligence_directed_research_jobs where company_id=$1", [company]), job.lease_token);
    assert.equal(await finish(job, { ranking: { scores: [{ score: .81, rawAnswer: { type: "noul", noul: .81 } }] } }), true);
    assert.equal(await claim(), undefined);
  });
  await test("new verified links requeue the same account without creating a second URL coordinator", async () => {
    await db.query("insert into intelligence_source_state(company_id,source_key,cursor) values($1,'website',$2)", [company, { verifiedUrls: ["https://example.test/about"] }]);
    const job = await claim(); assert.ok(job);
    const urls = ["https://example.test/about"];
    const manual = await scalar("select intelligence_research_claim($1,$2)", [company, urls]);
    assert.equal(manual.length, 1);
    assert.deepEqual(await scalar("select intelligence_research_claim($1,$2)", [company, urls]), []);
    assert.equal(await scalar("select intelligence_research_finish($1,$2,$3,'unchanged')", [company, urls[0], manual[0].lease_token]), true);
    assert.deepEqual(await scalar("select intelligence_research_claim($1,$2)", [company, urls]), []);
    assert.ok(Number(await scalar("select extract(epoch from next_attempt_at-now()) from intelligence_research_attempts where company_id=$1", [company])) > 6*86400);
    assert.equal(await finish(job), true);
  });
  await test("meaningful changed evidence fences a previously claimed account job", async () => {
    await db.exec("update intelligence_directed_research_jobs set due_at=now()");
    const old = await claim();
    await db.query("update intelligence_observations set content_hash='hash-b',attributes=$2 where id=$1", [observation, attrs]);
    assert.equal(await finish(old), false);
    const current = await claim(); assert.notEqual(current.desired_hash, old.desired_hash);
    await db.exec("update intelligence_directed_research_jobs set lease_until=now()-interval '1 second'");
    const resumed = await claim(); assert.notEqual(resumed.lease_token, current.lease_token);
    assert.equal(await finish(current), false); assert.equal(await finish(resumed), true);
  });
  await test("feedback stops obsolete research and Undo restores eligible missing-topic work", async () => {
    await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [observation]);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "superseded");
    await db.query("update intelligence_observations set feedback_excluded=false where id=$1", [observation]);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "queued");
  });
  await test("fully supported topics stop automatic gap research without changing Jev judgments", async () => {
    const topics = ["multi_entity", "project_billing", "recurring_revenue", "inventory", "multi_location", "systems_project", "acquisition_integration", "government_work"];
    const complete = { ...attrs, topicEvidence: topics.map(topic => ({ topic, probability: .9, start: 0, end: 20 })) };
    await db.query("update intelligence_observations set attributes=$2 where id=$1", [observation, complete]);
    assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "superseded");
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [observation]), complete);
    assert.equal(await claim(), undefined);
  });
  await test("service-only permissions and global runtime switch apply to automatic claims", async () => {
    assert.equal(await scalar("select relrowsecurity from pg_class where relname='intelligence_directed_research_jobs'"), true);
    for (const signature of ["intelligence_directed_refresh(uuid)", "intelligence_directed_claim(integer)", "intelligence_directed_finish(uuid,uuid,text,text,integer,jsonb,text)"])
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')", [signature]), false);
    await db.query("update intelligence_observations set attributes=$2 where id=$1", [observation, attrs]);
    await db.exec("update intelligence_config set enabled=false"); assert.equal(await claim(), undefined);
  });
  console.log(`${passed} PostgreSQL directed-research checks passed.`);
} catch (error) { console.error(error.message, error.detail ?? "", error.where ?? ""); process.exitCode = 1; }
finally { await db.close(); }
