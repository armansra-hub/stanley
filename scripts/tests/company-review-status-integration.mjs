/** Offline PostgreSQL checks against the actual catalog trigger and 0126.
 * No provider/production IO; PGlite does not prove concurrent lock timing. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
let passed = 0;
const check = async (name, run) => { await db.exec("begin"); try { await run(); passed++; console.log(`PASS ${name}`); } finally { await db.exec("rollback"); } };
const fails = async (sql, args, expression) => {
  await db.exec("savepoint rejected_write");
  await assert.rejects(db.query(sql, args), expression);
  await db.exec("rollback to rejected_write");
};
const original = await readFile(new URL("../../supabase/migrations/0119_intelligence_catalog_coverage.sql", import.meta.url), "utf8");
const extractFunction = name => original.slice(original.indexOf(`create function public.${name}(`), original.indexOf("\n$$;", original.indexOf(`create function public.${name}(`)) + 4);
const researchSnapshot = () => scalar(`select jsonb_build_object(
 'jobs',(select jsonb_agg(to_jsonb(j) order by company_id) from intelligence_directed_research_jobs j),
 'accounts',(select jsonb_agg(to_jsonb(a) order by company_id) from intelligence_catalog_accounts a),
 'facets',(select jsonb_agg(to_jsonb(f) order by company_id) from intelligence_catalog_facets f))`);
const companySnapshot = () => rows("select * from companies order by id");
const a = randomUUID(), b = randomUUID(), source = randomUUID();
try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table companies(id uuid primary key,name text,domain text,subindustry text,ns_industry text,city text,state text,
   status text,lists text[],netsuite_internal_id text,last_updated_at timestamptz,exported_at timestamptz,trigger_reviewed_through timestamptz);
 create table app_events(id uuid primary key default gen_random_uuid(),ts timestamptz default now(),module text,kind text,summary text,entity_type text,meta jsonb);
 create table intelligence_observations(id uuid primary key,company_id uuid,content_hash text,source_url text,title text,event_date date,
   source_kind text,evidence_text text,is_current boolean,feedback_excluded boolean,metadata jsonb);
 create table intelligence_catalog_accounts(company_id uuid primary key,evidence_key text,status text,result_updated_at timestamptz);
 create table intelligence_catalog_facets(company_id uuid primary key,status text,native_result jsonb);
 create table intelligence_directed_research_jobs(company_id uuid primary key,catalog_requested_version text,status text,lease_until timestamptz,
   due_at timestamptz,wake_reason text,finished_at timestamptz,last_error text,catalog_checkpoint jsonb);
 create table evidence_calls(called uuid);`);
 await db.exec(extractFunction("intelligence_catalog_evidence"));
 const invalidateStart = original.indexOf("create function public.intelligence_catalog_invalidate()");
 const invalidateEnd = original.indexOf("\ndo $$ declare fn record", invalidateStart);
 await db.exec(original.slice(invalidateStart, invalidateEnd));
 // Instrument the real source-inventory function, preserving its return value.
 await db.exec(`alter function intelligence_catalog_evidence(uuid) rename to intelligence_catalog_evidence_actual;
 create function intelligence_catalog_evidence(p_company uuid) returns jsonb language plpgsql as $$
 begin insert into evidence_calls values(p_company); return intelligence_catalog_evidence_actual(p_company); end $$;`);
 for (const [id, name] of [[a, "Synthetic A"], [b, "Synthetic B"]]) {
   await db.query("insert into companies(id,name,domain,status,lists,netsuite_internal_id,exported_at) values($1,$2,'synthetic.test','new',array['netsuite_tam'],'1234',now()-interval '1 day')", [id, name]);
 }
 await db.query(`insert into intelligence_observations values($1,$2,'hash','https://synthetic.test/services','Services',null,'website',
   'Exact saved evidence',true,false,'{}')`, [source, a]);
 for (const id of [a, b]) {
   await db.query(`insert into intelligence_directed_research_jobs values($1,'catalog-v1','complete',null,'infinity',null,now(),null,'{"saved":"checkpoint"}')`, [id]);
   await db.query("insert into intelligence_catalog_accounts values($1,null,'pending',now())", [id]);
   await db.query(`insert into intelligence_catalog_facets values($1,'answered','{"answer":"native"}')`, [id]);
 }
 await check("original dismiss re-hashes evidence and queues incomplete coverage", async () => {
   await db.query("update companies set status='dismissed' where id=$1", [a]);
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 1);
   assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [a]), "queued");
 });
 const before = await researchSnapshot();
 await db.exec(await readFile(new URL("../../supabase/migrations/0126_company_review_status_fast_path.sql", import.meta.url), "utf8"));
 assert.deepEqual(await researchSnapshot(), before); console.log("PASS migration leaves research, results and queues untouched"); passed++;
 await check("all visibility statuses skip evidence and preserve saved research and leases", async () => {
   const saved = await researchSnapshot();
   for (const status of ["dismissed", "reviewed", "exported_csv", "exported_sql", "new"]) await db.query("update companies set status=$2 where id=$1", [a, status]);
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 0);
   assert.deepEqual(await researchSnapshot(), saved);
 });
 await check("bulk dismiss stores exact IDs, status, review boundaries and a complete event together", async () => {
   const saved = await researchSnapshot();
   const result = await scalar("select companies_set_review_status($1,'dismissed')", [[b, a]]);
   assert.deepEqual(result, { ok: true, count: 2, ids: [b, a], status: "dismissed" });
   const changed = await companySnapshot();
   assert.ok(changed.every(row => row.status === "dismissed" && row.trigger_reviewed_through && row.exported_at));
   assert.ok(changed.every(row => row.trigger_reviewed_through.getTime() === row.last_updated_at.getTime()));
   assert.equal((await scalar("select ts from app_events")).getTime(), changed[0].trigger_reviewed_through.getTime());
   assert.deepEqual(await scalar("select meta from app_events"), { count: 2, status: "dismissed", ids: [b, a] });
   assert.deepEqual(await researchSnapshot(), saved);
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 0);
   await scalar("select companies_set_review_status($1,'new')", [[b, a]]);
   assert.ok((await companySnapshot()).every(row => row.status === "new" && row.trigger_reviewed_through === null && row.exported_at === null));
 });
 await check("missing companies cannot produce a partial dismissal or receipt", async () => {
   const saved = await companySnapshot();
   await fails("select companies_set_review_status($1,'dismissed')", [[a, randomUUID()]], /review_company_not_found/);
   assert.deepEqual(await companySnapshot(), saved);
   assert.equal(await scalar("select count(*)::int from app_events"), 0);
 });
 await check("a receipt failure rolls back the company decision", async () => {
   await db.exec(`alter table app_events add constraint reject_fixture check(kind<>'lead.status_changed')`);
   const saved = await companySnapshot();
   await fails("select companies_set_review_status($1,'dismissed')", [[a]], /reject_fixture/);
   assert.deepEqual(await companySnapshot(), saved);
 });
 await check("unknown statuses, null and duplicate IDs fail without writes", async () => {
   for (const [ids, status] of [[[a], "removed_from_tam"], [[a, a], "dismissed"], [[], "dismissed"], [[null], "new"]])
     await fails("select companies_set_review_status($1,$2)", [ids, status], /invalid_review_decision/);
   assert.equal(await scalar("select count(*)::int from app_events"), 0);
 });
 await check("real identity and membership changes still invalidate the exact source coverage", async () => {
   await db.query("update companies set domain='updated.test' where id=$1", [a]);
   assert.equal(await scalar("select status from intelligence_catalog_accounts where company_id=$1", [a]), "stale");
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 1);
   await db.query("update companies set status='removed_from_tam' where id=$1", [b]);
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 2);
   await db.query("update companies set status='new' where id=$1", [b]);
   assert.equal(await scalar("select count(*)::int from evidence_calls"), 3);
 });
 await check("changed source evidence still invalidates while a healthy lease is preserved", async () => {
   await db.query("update intelligence_directed_research_jobs set status='running',lease_until=now()+interval '1 minute' where company_id=$1", [a]);
   await db.query("update intelligence_observations set content_hash='changed' where id=$1", [source]);
   assert.equal(await scalar("select status from intelligence_catalog_facets where company_id=$1", [a]), "stale");
   assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [a]), "running");
   assert.deepEqual(await scalar("select catalog_checkpoint from intelligence_directed_research_jobs where company_id=$1", [a]), { saved: "checkpoint" });
 });
 await check("service role alone can invoke the review RPC", async () => {
   assert.equal(await scalar("select has_function_privilege('service_role','companies_set_review_status(uuid[],text)','execute')"), true);
   for (const role of ["anon", "authenticated"]) assert.equal(await scalar("select has_function_privilege($1,'companies_set_review_status(uuid[],text)','execute')", [role]), false);
 });
 console.log(`${passed} review-status integration checks passed`);
} finally { await db.close(); }
