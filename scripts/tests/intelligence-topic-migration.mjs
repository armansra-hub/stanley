/** Local-only PostgreSQL checks for cross-source operating matches.
 * Uses the optional PGlite runtime installed in work/intelligence-sql-test.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
process.on("uncaughtException", error => { console.error(`FAIL ${error.message}`); process.exitCode = 1; });
const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create table companies(id uuid primary key,status text not null,name text not null,domain text,subindustry text,netsuite_internal_id text,lists text[]);
  create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
`);
await db.exec(await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8"));
await db.exec(await readFile(new URL("../../supabase/migrations/0061_intelligence_operating_topic_search.sql", import.meta.url), "utf8"));
await db.exec("update intelligence_config set enabled=true");
for (let n = 1; n <= 8; n++) await db.query("insert into companies values($1,$2,$3,'example.test','Engineering',$4,$5)",
  [id(n), n === 4 ? "removed_from_tam" : "new", `Synthetic company ${n}`, String(n), n === 3 ? [] : n === 5 ? ["netsuite_tam", "tam_duplicate"] : ["netsuite_tam"]]);

function attrs(topics, text) {
  return { companyRelationship: "direct", companyRelevance: .95, topicEvidence: topics.map(topic => ({ topic, probability: .9, start: 0, end: text.length })) };
}
async function observation(company, topics, options = {}) {
  const text = options.text ?? "Project delivery and inventory operations are described here.";
  const observationId = randomUUID();
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,is_current,observed_at)
    values($1::uuid,$2,$3,'website',$3,'Synthetic source',$4,$1::uuid::text,$5,$6,$7)`,
  [observationId, id(company), `https://example.test/${observationId}`, text,
    options.attributes === null ? null : options.attributes ?? attrs(topics, text), options.current ?? true, options.observedAt ?? "2026-09-17T12:00:00Z"]);
  return observationId;
}

const projectSource = await observation(1, ["project_billing"]);
const inventorySource = await observation(1, ["inventory"]);
await observation(2, ["project_billing"]);
for (const n of [3, 4, 5]) await observation(n, ["project_billing", "inventory"]);
await observation(6, [], { attributes: null });
const unicode = "😀 Project delivery and inventory.";
await observation(7, ["project_billing", "inventory"], { text: unicode });
await observation(8, ["project_billing", "inventory"], { current: false });
const query = (topics = ["project_billing", "inventory"], after = null, limit = 8) => scalar("select intelligence_topic_search($1,$2,$3)", [topics, after, limit]);

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await test("compound AND joins separate sources for the exact current TAM account", async () => {
    const result = await query();
    assert.deepEqual(result.accounts.map(account => account.companyId), [id(1), id(7)]);
    assert.deepEqual(result.accounts[0].observations.map(row => row.id).sort(), [projectSource, inventorySource].sort());
    assert.equal(result.coverage.tamAccounts, 5);
    assert.equal(result.coverage.matchingAccounts, 2);
    assert.equal(result.coverage.interpretedObservations + 1, result.coverage.currentObservations);
    assert.equal(result.coverage.cacheOnly, true);
  });
  await test("keyset pages cover all matches without duplicates or inferred completeness", async () => {
    const first = await query(undefined, null, 1);
    assert.equal(first.hasMore, true); assert.equal(first.nextCursor, id(1));
    const next = await query(undefined, first.nextCursor, 1);
    assert.equal(next.accounts[0].companyId, id(7)); assert.equal(next.hasMore, false); assert.equal(next.nextCursor, null);
  });
  await test("stored UTF-16 offsets support supplementary Unicode evidence", async () => {
    const topics = await scalar("select intelligence_supported_topics($1,$2)", [attrs(["inventory"], unicode), unicode]);
    assert.deepEqual(topics, ["inventory"]);
  });
  await test("unsupported identity, invalid probabilities and invalid exact spans cannot become indexed traits", async () => {
    const text = "Inventory.";
    const base = attrs(["inventory"], text);
    for (const attributes of [
      { ...base, companyRelationship: "related" }, { ...base, companyRelevance: "0.99" },
      { ...base, topicEvidence: [{ topic: "inventory", probability: 2, start: 0, end: text.length }] },
      { ...base, topicEvidence: [{ topic: "inventory", probability: .9, start: 0, end: text.length + 1 }] },
      { ...base, topicEvidence: [{ topic: "inventory", probability: .9, start: -1, end: 3 }] },
      { ...base, topicEvidence: [{ topic: "inventory", probability: .9, start: 0.5, end: 3 }] },
      { ...base, topicEvidence: "malformed" },
    ]) assert.deepEqual(await scalar("select intelligence_supported_topics($1,$2)", [attributes, text]), []);
  });
  await test("selection is bounded to one recent supporting source per topic", async () => {
    const latest = await observation(1, ["inventory"], { observedAt: "2026-09-18T12:00:00Z" });
    const result = await query();
    assert.deepEqual(result.accounts[0].observations.map(row => row.id).sort(), [projectSource, latest].sort());
    assert.equal(result.accounts[0].coverage.observations, 3);
  });
  await test("filter bounds and service-only grants apply", async () => {
    await assert.rejects(query(["not_a_topic"])); await assert.rejects(query([], null, 8)); await assert.rejects(query(["inventory"], null, 13));
    assert.equal(await scalar("select has_function_privilege('anon','intelligence_topic_search(text[],uuid,integer)','EXECUTE')"), false);
    assert.equal(await scalar("select has_function_privilege('authenticated','intelligence_topic_search(text[],uuid,integer)','EXECUTE')"), false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_topic_search(text[],uuid,integer)','EXECUTE')"), true);
    await db.exec("update intelligence_config set enabled=false");
    assert.equal((await query()).enabled, false);
  });
  console.log(`${passed}/6 operating-topic PostgreSQL checks passed.`);
} finally { await db.close(); }
