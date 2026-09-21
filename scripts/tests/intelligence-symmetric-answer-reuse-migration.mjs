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
const complete = async (key, attr = attributes(), changes = {}) => {
  const result = await observe(key, changes);
  await db.query("update intelligence_observations set attributes=$1,interpretation_version='evidence-v2' where id=$2", [attr,result.id]);
  await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [result.id]);
  return result;
};
const narrowed = { ...metadata, researchTopics: ["recurring_revenue"], researchCriteria: criteria, discovery: { collector: "directed_research" } };
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,subindustry text);
    create table intelligence_directed_research_jobs(company_id uuid primary key,context_revision bigint not null default 0);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),verdict text,promoted_trigger_id uuid);`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0081_intelligence_document_discoveries.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false; update intelligence_config set enabled=true");
  await db.query("insert into companies(id,status) values($1,'new')", [company]);
  await db.exec(await readFile(new URL("../../supabase/migrations/0105_intelligence_reuse_answered_topics.sql", import.meta.url), "utf8"));

  await db.query("update companies set subindustry='Management Consulting' where id=$1", [company]);
  await db.exec(await readFile(new URL("../../supabase/migrations/0109_intelligence_symmetric_answer_reuse.sql", import.meta.url), "utf8"));
  const ordinary = { ...metadata, researchCriteria: criteria, researchCriteriaBasis: "worker-operating-criteria-v1",
    researchCriteriaSubindustry: "Management Consulting", researchCriteriaModel: "jev-1.13.0" };
  const native = () => { const attr = attributes(); for (const packet of attr.packetFindings) packet.model = "jev-1.13.0"; return attr; };
  await test("ordinary capture reuses a completed directed pass without another job or changed native answers", async () => {
    const first = await complete("deep-first", native(), { metadata: narrowed });
    const second = await observe("deep-first", { metadata: ordinary });
    assert.equal(second.id, first.id); assert.equal(second.queued, false);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where observation_id=$1", [first.id]), 1);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [first.id]), native());
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries where observation_id=$1", [first.id]), 2);
    const third = await observe("deep-first", { metadata: ordinary });
    assert.equal(third.id, first.id); assert.equal(third.queued, false);
  });
  await test("ordinary reuse never omits questions or substitutes an older model", async () => {
    for (const [key, changes, attr] of [
      ["ordinary-new-question", { ...ordinary, researchCriteria: [...criteria, "inventory"] }, native()],
      ["ordinary-stale-company", { ...ordinary, researchCriteriaSubindustry: "Media & Publishing" }, native()],
      ["ordinary-model-change", { ...ordinary, researchCriteriaModel: "jev-1.14.0" }, native()],
      ["ordinary-invalid-model", { ...ordinary, researchCriteriaModel: "current" }, native()],
      ["ordinary-missing-model", ordinary, attributes()],
      ["ordinary-malformed-packets", ordinary, { ...native(), packetFindings: {} }],
    ]) {
      const first = await complete(key, attr, { metadata: narrowed });
      const next = await observe(key, { metadata: changes });
      assert.notEqual(next.id, first.id, key); assert.equal(next.queued, true, key);
    }
  });
  await test("explicit absent subindustry is reusable but an omitted value is not", async () => {
    await db.query("update companies set subindustry=null where id=$1", [company]);
    const first = await complete("no-subindustry", native(), { metadata: narrowed });
    assert.equal((await observe("no-subindustry", { metadata: { ...ordinary, researchCriteriaSubindustry: null } })).id, first.id);
    const missing = await complete("unknown-subindustry", native(), { metadata: narrowed });
    const requested = { ...ordinary }; delete requested.researchCriteriaSubindustry;
    assert.notEqual((await observe("unknown-subindustry", { metadata: requested })).id, missing.id);
    await db.query("update companies set subindustry='Management Consulting' where id=$1", [company]);
  });
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
  await test("ordinary-to-ordinary model changes create one new request identity and reuse historical compatible models", async () => {
    const original = await complete("ordinary-model-version", native(), { metadata: ordinary });
    const nextMetadata = { ...ordinary, researchCriteriaModel: "jev-1.14.0" };
    const next = await observe("ordinary-model-version", { metadata: nextMetadata });
    assert.notEqual(next.id, original.id); assert.equal(next.queued, true);
    const pending = await observe("ordinary-model-version", { metadata: nextMetadata });
    assert.equal(pending.id, next.id); assert.equal(pending.queued, false);
    const updated = native(); for (const packet of updated.packetFindings) packet.model = "jev-1.14.0";
    await db.query("update intelligence_observations set attributes=$1 where id=$2", [updated,next.id]);
    await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [next.id]);
    assert.equal((await observe("ordinary-model-version", { metadata: ordinary })).id, original.id);
    assert.equal((await observe("ordinary-model-version", { metadata: nextMetadata })).id, next.id);
    assert.equal(await scalar("select count(*)::int from intelligence_observations where company_id=$1 and source_key='ordinary-model-version'", [company]), 2);
  });
  await test("ordinary-to-ordinary new criteria get a distinct request while criterion order cannot duplicate it", async () => {
    const original = await complete("ordinary-question-version", native(), { metadata: ordinary });
    const nextMetadata = { ...ordinary, researchCriteria: [...criteria, "inventory"] };
    const next = await observe("ordinary-question-version", { metadata: nextMetadata });
    assert.notEqual(next.id, original.id); assert.equal(next.queued, true);
    const reordered = { ...nextMetadata, researchCriteria: [...nextMetadata.researchCriteria].reverse() };
    assert.equal((await observe("ordinary-question-version", { metadata: reordered })).id, next.id);
    const updated = native(); for (const packet of updated.packetFindings) packet.criteria.inventory = 0;
    await db.query("update intelligence_observations set attributes=$1 where id=$2", [updated,next.id]);
    await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [next.id]);
    assert.equal((await observe("ordinary-question-version", { metadata: reordered })).id, next.id);
    assert.equal(await scalar("select count(*)::int from intelligence_observations where company_id=$1 and source_key='ordinary-question-version'", [company]), 2);
  });
  await test("compatible completed legacy and unknown pending legacy contracts preserve their existing jobs", async () => {
    const done = await complete("ordinary-legacy-compatible", native());
    assert.equal((await observe("ordinary-legacy-compatible", { metadata: ordinary })).id, done.id);
    const pending = await observe("ordinary-legacy-pending");
    assert.equal((await observe("ordinary-legacy-pending", { metadata: ordinary })).id, pending.id);
    const knownPending = await observe("ordinary-known-pending", { metadata: ordinary });
    const changed = await observe("ordinary-known-pending", { metadata: { ...ordinary, researchCriteriaModel: "jev-1.14.0" } });
    assert.notEqual(changed.id, knownPending.id);
    assert.equal(await scalar("select status from intelligence_jobs where observation_id=$1", [knownPending.id]), "queued");
  });
  await test("unchanged exact legacy v1/v2 captures never pay for a rubric upgrade caused only by new bookkeeping", async () => {
    for (const version of ["stanley-business-services-v1", "stanley-business-services-v2", "stanley-evidence-v2"]) {
      const key = `legacy-${version}`;
      const old = { model: "jev-1.12.0", questionVersion: version, rawAnswers: { retained: true } };
      const first = await complete(key, old);
      const second = await observe(key, { metadata: ordinary });
      assert.equal(second.id, first.id, version); assert.equal(second.queued, false, version);
      assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [first.id]), old);
      assert.equal(await scalar("select count(*)::int from intelligence_jobs where observation_id=$1", [first.id]), 1);
      // Exact reuse is grandfathered, not a claim that the old rubric answered
      // a different research stream's requested questions.
      const directed = await observe(key, { metadata: { ...ordinary, researchTopics: ["recurring_revenue"] } });
      assert.notEqual(directed.id, first.id, version); assert.equal(directed.queued, true, version);
    }
  });
  await test("zero context epoch preserves legacy answers and does not trust supplied capture epochs", async () => {
    const first = await complete("legacy-epoch", native(), { metadata: narrowed });
    const next = await observe("legacy-epoch", { metadata: { ...ordinary, accountContextRevision: 999 } });
    assert.equal(next.id, first.id); assert.equal(next.queued, false);
    assert.equal(await scalar("select metadata ? 'accountContextRevision' from intelligence_observations where id=$1", [first.id]), false);
  });
  await test("a changed company epoch wakes exact evidence once, then reuses only within that epoch", async () => {
    const first = await complete("changed-epoch", native(), { metadata: narrowed });
    await db.query("insert into intelligence_directed_research_jobs(company_id,context_revision) values($1,1)", [company]);
    const fresh = await observe("changed-epoch", { metadata: narrowed });
    assert.notEqual(fresh.id, first.id); assert.equal(fresh.queued, true);
    assert.equal(await scalar("select metadata->'accountContextRevision' from intelligence_observations where id=$1", [fresh.id]), 1);
    await db.query("update intelligence_observations set attributes=$1,interpretation_version='evidence-v2' where id=$2", [native(),fresh.id]);
    await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [fresh.id]);
    const same = await observe("changed-epoch", { metadata: ordinary });
    assert.equal(same.id, fresh.id); assert.equal(same.queued, false);
    await db.query("update intelligence_directed_research_jobs set context_revision=2 where company_id=$1", [company]);
    const changedAgain = await observe("changed-epoch", { metadata: { ...ordinary, accountContextRevision: 1 } });
    assert.notEqual(changedAgain.id, fresh.id); assert.equal(changedAgain.queued, true);
    assert.equal(await scalar("select metadata->'accountContextRevision' from intelligence_observations where id=$1", [changedAgain.id]), 2);
  });
  console.log(`${checks} symmetric-answer SQL regression checks passed`);
} finally { await db.close(); }
