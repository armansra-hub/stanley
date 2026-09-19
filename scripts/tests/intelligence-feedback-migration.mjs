/** Synthetic local PostgreSQL semantics: no external account or source access. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const company = randomUUID(), other = randomUUID(), project = randomUUID(), inventory = randomUUID();
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const filename of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  await db.exec("update intelligence_config set enabled=true");
  for (const [id, nsid] of [[company, "1"], [other, "2"]]) await db.query("insert into companies values($1,'new','Synthetic','example.test',null,$2,array['netsuite_tam'])", [id, nsid]);
  const attrs = topic => ({ companyRelationship: "direct", companyRelevance: .93, topicEvidence: [{ topic, probability: .92, start: 0, end: 20 }] });
  for (const [id, topic] of [[project, "project_billing"], [inventory, "inventory"]]) await db.query(`
    insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,metadata)
    values($1,$2,$3,'website',$3,'Synthetic source','Public operating context.', $3,$4,'{"sharedSourceId":"synthetic-feed"}')`,
    [id, company, `https://example.test/${id}`, attrs(topic)]);
  const feedback = (id, reason) => db.query(`insert into intelligence_feedback(company_id,observation_id,reason,note)
    values($1,$2,$3,'Human correction') on conflict(company_id,observation_id) do update set reason=excluded.reason,updated_at=now()`, [company, id, reason]);
  const matches = () => scalar("select intelligence_topic_search(array['project_billing','inventory'])");

  await test("wrong company removes exactly the corrected cached topic source and its match counts", async () => {
    assert.equal((await matches()).accounts.length, 1);
    await feedback(inventory, "wrong_company");
    assert.equal((await matches()).accounts.length, 0);
    assert.equal((await matches()).coverage.currentObservations, 1);
    assert.equal(await scalar("select feedback_excluded from intelligence_observations where id=$1", [project]), false);
    assert.equal(await scalar("select feedback_excluded from intelligence_observations where id=$1", [inventory]), true);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [inventory]), attrs("inventory"));
  });
  await test("replacement decisions and deletion restore existing matches without another model call", async () => {
    await feedback(inventory, "useful");
    assert.equal((await matches()).accounts.length, 1);
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), 1.02);
    await feedback(inventory, "irrelevant");
    assert.equal((await matches()).accounts.length, 0);
    await db.query("delete from intelligence_feedback where observation_id=$1", [inventory]);
    assert.equal((await matches()).accounts.length, 1);
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), 1);
    await assert.rejects(db.query("insert into intelligence_feedback values($1,$2,'wrong_company','',now())", [other, inventory]));
  });
  await test("exact Jev triggers inherit exclusion before publication and Undo preserves independent quarantine", async () => {
    await feedback(inventory, "wrong_company");
    const trigger = randomUUID(), unrelated = randomUUID();
    await db.query("insert into triggers(id,company_id,metadata) values($1,$2,$3)", [trigger, company,
      { jevFinding: { observationId: inventory }, quarantine: { reason: "independent" } }]);
    await db.query("insert into triggers(id,company_id,metadata) values($1,$2,$3)", [unrelated, other,
      { intelligenceEvidence: { observationId: inventory } }]);
    assert.equal(await scalar("select metadata->'intelligenceFeedbackExcluded' from triggers where id=$1", [trigger]), true);
    assert.equal(await scalar("select metadata->'intelligenceFeedbackExcluded' from triggers where id=$1", [unrelated]), false);
    await db.query("delete from intelligence_feedback where observation_id=$1", [inventory]);
    assert.deepEqual(await scalar("select metadata from triggers where id=$1", [trigger]), {
      jevFinding: { observationId: inventory }, quarantine: { reason: "independent" }, intelligenceFeedbackExcluded: false,
    });
    await feedback(inventory, "irrelevant");
    assert.equal(await scalar("select metadata->'intelligenceFeedbackExcluded' from triggers where id=$1", [trigger]), true);
  });
  await test("feedback fences unfinished work and Undo resumes its checkpoint without invalidating completed cache", async () => {
    await db.query("delete from intelligence_feedback where observation_id=$1", [inventory]);
    const running = randomUUID(), complete = randomUUID();
    await db.query(`insert into intelligence_jobs(id,operation_key,observation_id,kind,status,lease_token,lease_until,result)
      values($1,'synthetic-running',$2,'interpret','running',gen_random_uuid(),now()+interval '1 minute','{"parts":[{"start":0,"end":20}]}')`, [running, inventory]);
    await db.query("insert into intelligence_jobs(id,operation_key,observation_id,kind,status) values($1,'synthetic-complete',$2,'interpret','complete')", [complete, inventory]);
    await feedback(inventory, "irrelevant");
    const canceled = (await db.query("select status,lease_token,result from intelligence_jobs where id=$1", [running])).rows[0];
    assert.equal(canceled.status, "superseded"); assert.equal(canceled.lease_token, null);
    assert.deepEqual(canceled.result, { parts: [{ start: 0, end: 20 }] });
    await db.query("delete from intelligence_feedback where observation_id=$1", [inventory]);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1", [running]), "queued");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1", [complete]), "complete");
  });
  await test("not-now shifts only bounded public priority; source attention includes explicit outcomes", async () => {
    await feedback(inventory, "not_now");
    assert.equal((await matches()).accounts.length, 1);
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), .98);
    const rows = (await db.query("select * from intelligence_source_feedback_weights()")).rows;
    assert.equal(rows[0].source_id, "synthetic-feed"); assert.equal(Number(rows[0].weight), .98);
    await feedback(project, "useful");
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), 1);
    await db.exec("update intelligence_feedback set updated_at=now()-interval '91 days'");
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), 1);
    assert.equal((await db.query("select * from intelligence_source_feedback_weights()")).rows.length, 0);
  });
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.test/verified-${index}`);
  const claim = () => scalar("select intelligence_research_claim($1,$2)", [company, urls]);
  const finish = (row, outcome, lease = row.lease_token) => scalar("select intelligence_research_finish($1,$2,$3,$4)", [company, row.source_url, lease, outcome]);
  await test("research claims are bounded, exclusive and advance to other verified URLs", async () => {
    const first = await claim(), second = await claim();
    assert.equal(first.length, 3); assert.equal(second.length, 2);
    assert.equal(new Set([...first, ...second].map(row => row.source_url)).size, 5);
    assert.deepEqual(await claim(), []);
    assert.equal(await finish(first[0], "unchanged"), true);
    assert.equal(await finish(first[1], "source_failed"), true);
    assert.equal(await finish(first[0], "queued"), false);
    const delay = async url => Number(await scalar("select extract(epoch from next_attempt_at-now()) from intelligence_research_attempts where source_url=$1", [url]));
    assert.ok(await delay(first[0].source_url) > 6 * 86400);
    assert.ok(await delay(first[1].source_url) > 23 * 3600);
    await db.query("update intelligence_research_attempts set lease_until=now()-interval '1 second' where source_url=$1", [first[2].source_url]);
    const resumed = await claim(); assert.equal(resumed.length, 1); assert.notEqual(resumed[0].lease_token, first[2].lease_token);
    assert.equal(await finish(first[2], "queued"), false); assert.equal(await finish(resumed[0], "queued"), true);
  });
  await test("research bounds and service-only access apply", async () => {
    await assert.rejects(scalar("select intelligence_research_claim($1,$2)", [company, ["javascript:alert(1)"]]));
    await assert.rejects(scalar("select intelligence_research_claim($1,$2)", [company, Array(101).fill(urls[0])]));
    for (const signature of ["intelligence_research_claim(uuid,text[])", "intelligence_research_finish(uuid,text,uuid,text)", "intelligence_public_feedback_weight(uuid)", "intelligence_source_feedback_weights()"])
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')", [signature]), false);
    assert.equal(await scalar("select relrowsecurity from pg_class where relname='intelligence_research_attempts'"), true);
    await db.exec("update intelligence_config set enabled=false");
    assert.deepEqual(await claim(), []);
    assert.equal(Number(await scalar("select intelligence_public_feedback_weight($1)", [company])), 1);
  });
  console.log(`${passed} PostgreSQL feedback/research checks passed.`);
} finally { await db.close(); }
