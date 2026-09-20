/** Exact paid-answer reuse in local ephemeral PostgreSQL; no hosted/provider calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const company = randomUUID();
const text = "Original public evidence with unchanged source facts.";
const core = ["project_delivery", "multi_entity", "multi_location"];
const criteria = [...core, "recurring_revenue"];
const metadata = { companyName: "Example Services", companyDomain: "example.com", retainedCharacters: text.length,
  eventDateBasis: "page_publication", sourceDates: [{ kind: "published", value: "2026-09-17", source: "article:published_time" }] };
const attributes = () => ({ analyzedCharacters: text.length, retainedCharacters: text.length, packetFindings: [
  { start: 0, end: 20, questionVersion: "stanley-business-services-v3", criteria: Object.fromEntries(criteria.map(topic => [topic, 0])) },
  { start: 20, end: text.length, questionVersion: "stanley-business-services-v3", criteria: Object.fromEntries(criteria.map(topic => [topic, .8])) },
] });
const observe = (key, changes = {}) => {
  const value = { key, text, hash: `body-${key}`, metadata, ...changes };
  return scalar("select intelligence_observe($1,$2,'website',$3,'Original heading',$4,$5,'2026-09-17','2026-09-20',$6,'[]','evidence-v2')",
    [company,value.key,`https://example.com/${value.key}`,value.text,value.hash,value.metadata]);
};
const complete = async (key, attr = attributes()) => {
  const result = await observe(key);
  await db.query("update intelligence_observations set attributes=$1,interpretation_version='evidence-v2' where id=$2", [attr,result.id]);
  await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [result.id]);
  return result;
};
const narrowed = { ...metadata, researchTopics: ["recurring_revenue"], researchCriteria: criteria, discovery: { collector: "directed_research" } };
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),verdict text,promoted_trigger_id uuid);`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0081_intelligence_document_discoveries.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false; update intelligence_config set enabled=true");
  await db.query("insert into companies(id,status) values($1,'new')", [company]);
  await db.exec(await readFile(new URL("../../supabase/migrations/0105_intelligence_reuse_answered_topics.sql", import.meta.url), "utf8"));

  await test("narrowed research reuses all existing native packet answers, including negative answers", async () => {
    const first = await complete("reused");
    const second = await observe("reused", { metadata: narrowed });
    assert.equal(second.id, first.id); assert.equal(second.queued, false);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where observation_id=$1", [first.id]), 1);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [first.id]), attributes());
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries where observation_id=$1", [first.id]), 2);
    const compact = attributes();
    for (const packet of compact.packetFindings) packet.questionVersion = "stanley-business-services-v4";
    const v4 = await complete("compact-contract", compact);
    assert.equal((await observe("compact-contract", { metadata: narrowed })).id, v4.id);
  });
  await test("an unanswered new criterion still queues full research and preserves prior topics", async () => {
    const first = await complete("new-question");
    const second = await observe("new-question", { metadata: { ...narrowed, researchCriteria: [...criteria, "inventory"] } });
    assert.notEqual(second.id, first.id); assert.equal(second.queued, true);
    assert.equal(await scalar("select is_current from intelligence_observations where id=$1", [first.id]), true);
  });
  await test("one missing packet answer or a coverage gap prevents reuse", async () => {
    for (const [key, mutate] of [
      ["missing", value => { delete value.packetFindings[1].criteria.recurring_revenue; }],
      ["gap", value => { value.packetFindings[1].start++; }],
      ["overlap", value => { value.packetFindings[1].start--; }],
      ["short", value => { value.packetFindings[1].end--; }],
      ["old-contract", value => { value.packetFindings[1].questionVersion = "stanley-business-services-v2"; }],
    ]) {
      const attr = attributes(); mutate(attr);
      const first = await complete(key, attr);
      const second = await observe(key, { metadata: narrowed });
      assert.notEqual(second.id, first.id, key); assert.equal(second.queued, true, key);
    }
  });
  await test("changed dates, identity or evidence are never hidden by available topic answers", async () => {
    for (const [key, changes] of [
      ["date", { metadata: { ...narrowed, sourceDates: [...metadata.sourceDates, { kind: "modified", value: "2026-09-20", source: "dateModified" }] } }],
      ["identity", { metadata: { ...narrowed, companyIdentity: { names: ["Different legal entity"] } } }],
      ["body", { text: "The company announced a new acquisition.", hash: "new-body", metadata: narrowed }],
    ]) {
      const first = await complete(key);
      const second = await observe(key, changes);
      assert.notEqual(second.id, first.id, key); assert.equal(second.queued, true, key);
    }
  });
  await test("unfinished, excluded or superseded interpretations do not satisfy a new question pass", async () => {
    for (const [key, update] of [
      ["unfinished", "update intelligence_jobs set status='queued' where observation_id=$1"],
      ["excluded", "update intelligence_observations set feedback_excluded=true where id=$1"],
      ["old-source", "update intelligence_observations set is_current=false where id=$1"],
    ]) {
      const first = await complete(key); await db.query(update, [first.id]);
      const second = await observe(key, { metadata: narrowed });
      assert.notEqual(second.id, first.id, key); assert.equal(second.queued, true, key);
    }
  });
  await test("missing proof fields fail closed and helper remains service-only", async () => {
    for (const requested of [[], ["recurring_revenue"], [...core, "unknown"]]) {
      assert.equal(await scalar("select intelligence_packet_criteria_cover($1,$2,$3)", [attributes(),requested,text.length]), false);
    }
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select intelligence_packet_criteria_cover('{}','[]','0')"), /permission denied/);
      await db.exec("reset role");
    }
  });
  console.log(`${checks} answered-topic SQL regression checks passed`);
} finally { await db.close(); }
