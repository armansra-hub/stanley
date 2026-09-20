/** Real observation RPC in ephemeral PostgreSQL; no provider or hosted DB calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const company = randomUUID(), other = randomUUID();
const original = { companyName: "Example Services", companyDomain: "example.com", sourceDates: [{ kind: "published", value: "2026-09-17", source: "article:published_time" }] };
const observe = (overrides = {}) => {
  const value = { company, key: "source-1", kind: "website", url: "https://example.com/news/update", title: "New service", text: "Original public evidence.",
    hash: "body-v1", date: "2026-09-17", observed: "2026-09-19T12:00:00Z", metadata: original, ...overrides };
  return scalar("select intelligence_observe($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [value.company,value.key,value.kind,value.url,value.title,value.text,value.hash,value.date,value.observed,value.metadata,[],"evidence-v2"]);
};
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null,netsuite_internal_id text,lists text[]);
    create table lead_documents(id uuid primary key,company_id uuid,netsuite_internal_id text,doc_type text,body text,captured_at timestamptz);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),verdict text,promoted_trigger_id uuid);`);
  await db.exec(await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8"));
  await db.exec("update intelligence_config set enabled=true");
  await db.query("insert into companies(id,status) values($1,'new'),($2,'new')", [company, other]);
  const existing = await observe();
  await db.query("update intelligence_observations set attributes=$1,interpretation_version='evidence-v2' where id=$2", [{ native: "untouched" }, existing.id]);
  await db.query("update intelligence_jobs set status='complete' where observation_id=$1", [existing.id]);
  await db.exec(await readFile(new URL("../../supabase/migrations/0081_intelligence_document_discoveries.sql", import.meta.url), "utf8"));
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false");
  await db.exec(await readFile(new URL("../../supabase/migrations/0080_company_identity_context.sql", import.meta.url), "utf8"));

  await test("equivalent existing document retains its native answer without another interpretation", async () => {
    const result = await observe({ metadata: { ...original, discovery: { collector: "website", url: "https://feed.example/redirect", title: "Original discovery label", eventDate: "2026-09-18" }, sharedSourceId: "feed-1" } });
    assert.equal(result.id, existing.id);
    assert.equal(result.queued, false);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs"), 1);
    assert.deepEqual(await scalar("select attributes from intelligence_observations where id=$1", [existing.id]), { native: "untouched" });
    assert.deepEqual(await scalar("select metadata from intelligence_observations where id=$1", [existing.id]), original);
  });
  await test("distinct discovery metadata is retained once, independent of polling time", async () => {
    await observe({ observed: "2026-09-20T12:00:00Z" });
    await observe({ observed: "2026-09-21T12:00:00Z" });
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries where observation_id=$1", [existing.id]), 2);
    assert.equal(await scalar("select metadata->'discovery'->>'url' from intelligence_observation_discoveries where metadata->>'sharedSourceId'='feed-1'"), "https://feed.example/redirect");
    assert.equal(await scalar("select metadata->'discovery'->>'title' from intelligence_observation_discoveries where metadata->>'sharedSourceId'='feed-1'"), "Original discovery label");
  });
  await test("changed version queues work, preserving the prior document and its provenance", async () => {
    const changed = await observe({ title: "Acquisition announced", hash: "body-v2" });
    assert.notEqual(changed.id, existing.id);
    assert.equal(changed.queued, true);
    assert.equal(await scalar("select is_current from intelligence_observations where id=$1", [existing.id]), false);
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries where observation_id=$1", [existing.id]), 2);
  });
  await test("identical content remains separate across company IDs and document URLs", async () => {
    const distinctCompany = await observe({ company: other });
    const distinctDocument = await observe({ key: "source-2", url: "https://example.com/different-document" });
    assert.notEqual(distinctCompany.id, existing.id);
    assert.notEqual(distinctDocument.id, existing.id);
    assert.notEqual(distinctCompany.id, distinctDocument.id);
  });
  await test("targeted research questions receive their own answers without dropping prior topics", async () => {
    const first = await observe({ key: "topics", metadata: { ...original, researchTopics: ["project_delivery"] } });
    const second = await observe({ key: "topics", metadata: { ...original, researchTopics: ["recurring_revenue"] } });
    assert.notEqual(first.id, second.id); assert.equal(second.queued, true);
    assert.equal(await scalar("select count(*)::int from intelligence_observations where source_key='topics' and is_current"), 2);
    assert.equal((await observe({ key: "topics", metadata: { ...original, researchTopics: ["recurring_revenue"], discovery: { collector: "other_transport" } } })).id, second.id);
    await observe({ key: "topics", text: "The publisher changed the underlying document.", hash: "new-body", metadata: { ...original, researchTopics: ["recurring_revenue"] } });
    assert.equal(await scalar("select count(*)::int from intelligence_observations where source_key='topics' and is_current"), 1);
  });
  await test("equivalent feed redirect aliases share one answer and keep both discoveries", async () => {
    const first = await observe({ key: "feed-alias", kind: "news", metadata: { ...original, evidenceKind: "article_body", eventDateBasis: "feed_publication",
      sharedSourceId: "first-feed", discovery: { collector: "shared_feed", url: "https://first-feed.example/redirect" } } });
    const second = await observe({ key: "feed-alias", kind: "news", metadata: { ...original, evidenceKind: "article_body", eventDateBasis: "feed_publication",
      sharedSourceId: "second-feed", discovery: { collector: "shared_feed", url: "https://second-feed.example/redirect" } } });
    assert.equal(second.id, first.id); assert.equal(second.queued, false);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where observation_id=$1", [first.id]), 1);
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries where observation_id=$1", [first.id]), 2);
  });
  await test("new page modification dates invalidate reuse without a changed headline or body", async () => {
    const first = await observe({ key: "dates" });
    const updated = await observe({ key: "dates", metadata: { ...original, sourceDates: [...original.sourceDates, { kind: "modified", value: "2026-09-19", source: "article:modified_time" }] } });
    assert.notEqual(first.id, updated.id); assert.equal(updated.queued, true);
    assert.equal(await scalar("select is_current from intelligence_observations where id=$1", [first.id]), false);
  });
  await test("news reuse cannot strand a later website identity capture", async () => {
    const news = await observe({ key: "identity", kind: "news", metadata: { ...original, publisherIdentity: { names: ["Example Services"] } } });
    const identity = { names: ["Example Services"], addresses: [{ addressLine1: "100 Main Street", city: "Seattle" }], sourceUrl: "https://example.com/news/update" };
    const site = await observe({ key: "identity", metadata: { ...original, companyIdentity: identity } });
    assert.notEqual(news.id, site.id); assert.equal(site.queued, true);
    const context = await scalar("select company_identity_source_context($1)", [company]);
    assert.ok(context.websites.some(source => source.id === site.id && source.identity.addresses[0].addressLine1 === "100 Main Street"));
    assert.equal(await scalar("select is_current from intelligence_observations where id=$1", [news.id]), true);
    const updated = await observe({ key: "identity", metadata: { ...original, companyIdentity: { ...identity, addresses: [{ addressLine1: "200 Main Street" }] } } });
    assert.notEqual(site.id, updated.id);
    assert.equal(await scalar("select is_current from intelligence_observations where id=$1", [site.id]), false);
  });
  await test("global disabled intake creates neither a receipt nor a job", async () => {
    const before = await scalar("select count(*)::int from intelligence_observation_discoveries");
    await db.exec("update intelligence_config set enabled=false");
    assert.deepEqual(await observe({ hash: "disabled" }), { disabled: true });
    assert.equal(await scalar("select count(*)::int from intelligence_observation_discoveries"), before);
    await db.exec("update intelligence_config set enabled=true");
  });
  await test("provenance and the mutation RPC remain service-only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from intelligence_observation_discoveries"), /permission denied/);
      await assert.rejects(observe(), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.ok((await observe({ company: other })).id);
    await db.exec("reset role");
  });
  console.log(`${checks} document reuse SQL regression checks passed`);
} finally { await db.close(); }
