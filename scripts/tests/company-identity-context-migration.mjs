/** Compile and exercise the real read-only identity RPC in ephemeral PostgreSQL. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const company = randomUUID(), other = randomUUID(), removed = randomUUID(), duplicate = randomUUID(), empty = randomUUID();
const identity = { names: ["Example Services"], addresses: [{ addressLine1: "100 Main Street" }], sourceUrl: "https://example.com/about" };
async function document({ companyId = company, nsid = "12345", capturedAt = "2026-09-18T10:00:00Z", type = "record_text", body = "Account header", id = randomUUID() } = {}) {
  await db.query("insert into lead_documents values($1,$2,$3,$4,$5,$6)", [id, nsid, companyId, type, body, capturedAt]);
  return id;
}
async function observation({ companyId = company, observedAt = "2026-09-18T10:00:00Z", kind = "website", current = true, excluded = false, metadata = { companyIdentity: identity }, id = randomUUID() } = {}) {
  await db.query("insert into intelligence_observations values($1,$2,$3,$4,$5,$6,$7,$8)", [id, companyId, "https://example.com/about", observedAt, current, excluded, kind, metadata]);
  return id;
}
const context = id => scalar("select company_identity_source_context($1)", [id]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table companies(id uuid primary key,netsuite_internal_id text,status text,lists text[]);
    create table lead_documents(id uuid primary key,netsuite_internal_id text,company_id uuid,doc_type text,body text,captured_at timestamptz);
    create table intelligence_observations(id uuid primary key,company_id uuid,source_url text,observed_at timestamptz,is_current boolean,feedback_excluded boolean,source_kind text,metadata jsonb);`);
  await db.exec(await readFile(new URL("../../supabase/migrations/0076_company_identity_context.sql", import.meta.url), "utf8"));
  await db.query(`insert into companies values($1,'12345','new','{netsuite_tam}'),($2,'67890','new','{}'),
    ($3,'12345','removed_from_tam','{netsuite_tam}'),($4,'12345','new','{netsuite_tam,tam_duplicate}'),($5,'99999','new',null)`, [company, other, removed, duplicate, empty]);

  await test("exact NetSuite ID and company association both constrain the newest record header", async () => {
    const valid = await document();
    await document({ companyId: other, capturedAt: "2026-09-19T12:00:00Z", body: "Wrong company with same NetSuite ID" });
    await document({ nsid: "123450", capturedAt: "2026-09-19T13:00:00Z", body: "Prefix is not an exact Internal ID" });
    await document({ type: "note", capturedAt: "2026-09-19T14:00:00Z", body: "Private activity note" });
    assert.equal((await context(company)).record.id, valid);
  });
  await test("an unresolved company association may use the exact Internal ID and only 6000 header characters", async () => {
    const body = "Account business header ".repeat(350);
    const id = await document({ companyId: null, capturedAt: "2026-09-19T15:00:00Z", body });
    const value = (await context(company)).record;
    assert.equal(value.id, id);
    assert.equal(value.header.length, 6000);
    assert.equal(value.header, body.slice(0, 6000));
    assert.equal(new Date(value.capturedAt).toISOString(), "2026-09-19T15:00:00.000Z");
  });
  await test("undated records do not override a dated latest capture and equal dates use a stable ID tie-break", async () => {
    await document({ capturedAt: null, body: "Old undated capture" });
    const highId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await document({ id: "00000000-0000-4000-8000-000000000001", capturedAt: "2026-09-19T16:00:00Z", body: "Equal time, lower ID" });
    await document({ id: highId, capturedAt: "2026-09-19T16:00:00Z", body: "Equal time, higher ID" });
    assert.equal((await context(company)).record.id, highId);
  });
  await test("only eight newest current public website identity objects are returned", async () => {
    const eligible = [];
    for (let index = 0; index < 10; index++) eligible.push(await observation({ observedAt: `2026-09-19T${String(index).padStart(2, "0")}:00:00Z` }));
    for (const invalid of [
      { companyId: other }, { current: false }, { excluded: true }, { kind: "news" },
      { metadata: { publisherIdentity: identity } }, { metadata: { companyIdentity: [] } },
      { metadata: { companyIdentity: "unstructured" } }, { metadata: { companyIdentity: null } },
    ]) await observation({ ...invalid, observedAt: "2026-09-19T20:00:00Z" });
    const websites = (await context(company)).websites;
    assert.equal(websites.length, 8);
    assert.deepEqual(websites.map(row => row.id), eligible.slice(2).reverse());
    assert.ok(websites.every(row => Object.keys(row).sort().join(",") === "capturedAt,id,identity,url"));
    assert.deepEqual(websites[0].identity, identity);
  });
  await test("removed and duplicate companies receive no identity context; empty accounts get explicit empty fields", async () => {
    assert.equal(await context(removed), null);
    assert.equal(await context(duplicate), null);
    assert.equal(await context(randomUUID()), null);
    assert.deepEqual(await context(empty), { record: null, websites: [] });
  });
  await test("execution is restricted to service_role and the function is stable with a fixed search path", async () => {
    for (const role of ["anon", "authenticated"]) assert.equal(await scalar("select has_function_privilege($1,'company_identity_source_context(uuid)','EXECUTE')", [role]), false);
    assert.equal(await scalar("select has_function_privilege('service_role','company_identity_source_context(uuid)','EXECUTE')"), true);
    const config = (await db.query("select provolatile,prosecdef,proconfig from pg_proc where oid='company_identity_source_context(uuid)'::regprocedure")).rows[0];
    assert.equal(config.provolatile, "s");
    assert.equal(config.prosecdef, true);
    assert.ok(config.proconfig.includes("search_path=public, pg_temp"));
    await db.exec("set role anon");
    await assert.rejects(context(company), /permission denied for function company_identity_source_context/);
    await db.exec("reset role; set role service_role");
    assert.equal((await context(company)).websites.length, 8);
    await db.exec("reset role");
  });
  console.log(`${passed} company identity migration tests passed`);
} finally { await db.close(); }
