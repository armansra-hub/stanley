/** Local synthetic PostgreSQL semantics. No model, network or production calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
const company = randomUUID(), source = randomUUID(), trigger = randomUUID(), job = randomUUID();
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[],tam_score integer);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,source_url text,metadata jsonb);`);
  for (const filename of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0063_intelligence_event_stories.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  await db.query("insert into companies(id,status,name,tam_score) values($1,'new','Synthetic',17)", [company]);
  const attrs = { companyRelationship: "direct", companyRelevance: .76, topicEvidence: [{ topic: "recurring_revenue", probability: .82, start: 0, end: 8 }], rawAnswers: { companyRelevance: { type: "noul", noul: .76 } } };
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
    values($1,$2,'source','website','https://example.test/services','Services','Service😀','hash',$3)`, [source, company, attrs]);
  const parts = [{ start: 0, end: 9, evaluation: { questionVersion: "stanley-evidence-v2", attributes: { companyRelationship: "direct", companyRelevance: .81 }, criteria: { recurring_revenue: .82 }, metadata: { rawAnswers: { criterion_recurring_revenue: { type: "noul", noul: .82 } } } } }];
  await db.query("insert into intelligence_jobs(id,operation_key,observation_id,kind,status,result) values($1,'paid',$2,'interpret','complete',$3)", [job, source, { parts }]);
  assert.deepEqual(await scalar("select cached_operating_topics from intelligence_observations where id=$1", [source]), []);
  await db.exec(await readFile(new URL("../../supabase/migrations/0072_business_services_intelligence.sql", import.meta.url), "utf8"));
  await test("saved packet attribution restores low-winner topic cache and leaves native answers/grade unchanged", async () => {
    const row = (await db.query("select attributes,cached_operating_topics from intelligence_observations where id=$1", [source])).rows[0];
    assert.deepEqual(row.cached_operating_topics, ["recurring_revenue"]);
    assert.deepEqual(row.attributes.rawAnswers, attrs.rawAnswers);
    assert.equal(row.attributes.topicEvidence[0].companyRelevance, .81);
    assert.equal(await scalar("select tam_score from companies where id=$1", [company]), 17);
    assert.deepEqual(await scalar("select result->'parts' from intelligence_jobs where id=$1", [job]), parts);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1", [job]), "complete");
    assert.equal(await scalar("select intelligence_queue_saved_packet_replay()"), 1);
    assert.equal(await scalar("select intelligence_queue_saved_packet_replay()"), 0);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1", [job]), "queued");
  });
  await test("topic cache uses its own complete attribution and UTF-16 bounds", async () => {
    const a = { companyRelationship: "direct", companyRelevance: .99, topicEvidence: [{ topic: "project_delivery", probability: .9, companyRelationship: "related", companyRelevance: .99, start: 0, end: 9 }] };
    assert.deepEqual(await scalar("select intelligence_supported_topics($1,'Service😀')", [a]), []);
    a.topicEvidence[0].companyRelationship = "direct";
    assert.deepEqual(await scalar("select intelligence_supported_topics($1,'Service😀')", [a]), ["project_delivery"]);
    a.topicEvidence[0].end = 10;
    assert.deepEqual(await scalar("select intelligence_supported_topics($1,'Service😀')", [a]), []);
  });
  const original = { provenance: "legacy", jevFinding: { operationKey: "original" } };
  await db.query("insert into triggers(id,company_id,source_url,metadata) values($1,$2,'https://example.test/services',$3)", [trigger, company, original]);
  const evidence = { observationId: source, start: 0, end: 9, excerpt: "Service😀" };
  const finding = { operationKey: "a".repeat(64), observationId: source, rawAnswers: { companyRelevance: { type: "noul", noul: .81 } } };
  const attach = (value = finding, companyId = company) => scalar("select intelligence_attach_trigger_finding($1,$2,'https://example.test/services',$3,$4)", [trigger, companyId, value, evidence]);
  await test("source attachment is idempotent and preserves the original primary receipt", async () => {
    assert.equal(await attach(), true); assert.equal(await attach(), true);
    const metadata = await scalar("select metadata from triggers where id=$1", [trigger]);
    assert.equal(metadata.provenance, "legacy"); assert.deepEqual(metadata.jevFinding, original.jevFinding);
    assert.equal(metadata.jevContextFindings.length, 1); assert.deepEqual(metadata.jevContextFindings[0].finding, finding);
  });
  await test("wrong-account context and changed same-key receipts cannot overwrite stored data", async () => {
    await assert.rejects(attach(finding, randomUUID()), /finding_source_mismatch/);
    await assert.rejects(attach({ ...finding, rawAnswers: {} }), /receipt_mismatch/);
    assert.equal(await scalar("select jsonb_array_length(metadata->'jevContextFindings') from triggers where id=$1", [trigger]), 1);
  });
  await test("context history is bounded and append access is service-role-only", async () => {
    for (let n = 1; n < 20; n++) await attach({ ...finding, operationKey: n.toString(16).padStart(64, "0") });
    assert.equal(await scalar("select jsonb_array_length(metadata->'jevContextFindings') from triggers where id=$1", [trigger]), 16);
    assert.equal(await scalar("select has_function_privilege('anon','intelligence_attach_trigger_finding(uuid,uuid,text,jsonb,jsonb)','EXECUTE')"), false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_attach_trigger_finding(uuid,uuid,text,jsonb,jsonb)','EXECUTE')"), true);
  });
  console.log(`${passed} PostgreSQL tests passed`);
} finally { await db.close(); }
