// Offline PostgreSQL checks. Uses an existing PGlite installation, never a live DB.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(process.env.STANLEY_PGLITE_PACKAGE ?? new URL("../../stanley-jev-intelligence-20260918/work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const db = await PGlite.create("memory://", { extensions: { pgcrypto } });
const source = await readFile(new URL("../supabase/migrations/0137_codex_news_analysis.sql", import.meta.url), "utf8");
const scalar = async (sql, values = []) => (await db.query(sql, values)).rows[0]?.value;
const rpc = (action, payload) => scalar("select intelligence_codex_news($1,$2) value", [action, payload]);
const checks = [];
const test = async (name, action) => { await action(); checks.push(name); };
const text = "Acme opened an office. 😀 Exact original article.";
const company = randomUUID();
async function seed(options = {}) {
  const id = randomUUID(), observation = randomUUID();
  await db.query("insert into intelligence_observations(id,company_id,source_kind,source_url,title,evidence_text,content_hash,event_date,metadata) values($1,$2,$3,$4,'Office opening',$5,'sourcehash',now()-interval '1 day',$6)",
    [observation, company, options.kind ?? "news", `https://acme.com/news/${observation}`, text, { articleBodyAvailable: true, evidenceKind: "article_body", textTruncated: false, ...options.metadata }]);
  await db.query("insert into intelligence_jobs(id,operation_key,observation_id,kind,result,priority) values($1,$2,$3,'interpret',$4,$5)", [id, id, observation, { parts: [{ native: "unchanged" }], ...options.result }, options.priority ?? 0]);
  return { id, observation };
}
const claim = () => rpc("claim", { requestId: randomUUID(), taskId: "/root/reader" });
const bound = p => ({ jobId: p.jobId, lease: p.lease, snapshotHash: p.snapshotHash });
async function analyzed(p, disposition = "publish") {
  const analysis = { reader: { taskId: "/root/reader", model: "gpt-6-astra", snapshotHash: p.snapshotHash, fullTextRead: true, readStart: 0, readEnd: text.length }, disposition,
    rationale: "Fully read and checked dated official company office announcement.", attributes: { signalType: "press" } };
  return rpc("analyze", { ...bound(p), analysis, decisionHash: "d".repeat(64) });
}
function finishPayload(p) {
  return { ...bound(p), review: { reviewer: { taskId: "/root/reviewer", model: "gpt-6-astra", snapshotHash: p.snapshotHash, fullTextRead: true, readStart: 0, readEnd: text.length },
    approved: true, decisionHash: "d".repeat(64), rationale: "Independently read the original source and validated all company identity, date and event details." },
    trigger: p.review.analysis.disposition === "no_signal" ? null : { type: "press", source_name: "Codex · Independently reviewed public news", source_url: p.snapshot.observation.source_url,
      signal_date: p.snapshot.observation.event_date, strength: 50, half_life_days: 30, summary: "Acme opens office",
      evidence: { observationId: p.snapshot.observation.id, excerpt: "Acme opened an office.", start: 0, end: 22, observedAt: p.snapshot.observation.observed_at }, passageStart: 0, passageLength: 22 } };
}
try {
  await db.exec(`create extension pgcrypto; create role anon; create role authenticated; create role service_role;
    create table intelligence_config(id int primary key,enabled boolean); insert into intelligence_config values(1,true);
    create table intelligence_jev_budget_policy(id text primary key,enabled boolean); insert into intelligence_jev_budget_policy values('jev-rollout-2026-09-24',false);
    create table companies(id uuid primary key,name text,domain text,website_raw text,city text,state text,netsuite_internal_id text,status text,lists text[],tal_claimed boolean,record_dead boolean,description text,subindustry text,ns_industry text,tal_alert boolean);
    create table intelligence_observations(id uuid primary key,company_id uuid,source_kind text,source_url text,title text,evidence_text text,content_hash text,event_date timestamptz,observed_at timestamptz default now(),is_current boolean default true,feedback_excluded boolean default false,metadata jsonb default '{}',sections jsonb default '[]',attributes jsonb,interpretation_version text,interpreted_at timestamptz);
    create table intelligence_jobs(id uuid primary key,operation_key text,observation_id uuid,kind text,status text default 'queued',priority int default 0,due_at timestamptz default now(),attempts int default 0,lease_token uuid,lease_until timestamptz,last_error text,result jsonb,created_at timestamptz default now(),finished_at timestamptz);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,type text,strength int,half_life_days int,summary text,source_name text,source_url text,signal_date timestamptz,metadata jsonb,unique(company_id,source_url));
    create table app_events(id uuid primary key default gen_random_uuid(),module text,kind text,entity_type text,entity_id text,summary text,meta jsonb);
    create table intelligence_events(id uuid primary key,company_id uuid,trigger_id uuid);
    create table intelligence_event_observations(observation_id uuid primary key,event_id uuid);
    create function company_identity_source_context(uuid) returns jsonb language sql stable as $$select '{}'::jsonb$$;
    create function intelligence_event_bind_trigger(uuid,uuid) returns boolean language sql as $$update intelligence_events set trigger_id=$2 where id=$1 returning true$$;`);
  await db.query("insert into companies(id,name,domain,status,lists,tal_claimed) values($1,'Acme','acme.com','removed_from_tam',array['tam_removed'],true)", [company]);
  await test("migration compiles and is safely repeatable", async () => { await db.exec(source); await db.exec(source); });
  await test("request recovery is idempotent and includes retired canonical TAL", async () => {
    await seed(); const request = { requestId: randomUUID(), taskId: "/root/reader" };
    const p = await rpc("claim", request); assert.ok(p); assert.equal(p.snapshot.company.status, "removed_from_tam");
    assert.equal(await scalar("select codex_news_request_id value from intelligence_jobs where id=$1", [p.jobId]), request.requestId);
    assert.equal(p.review.requestId, request.requestId);
    assert.equal((await rpc("claim", request)).lease, p.lease);
    assert.equal((await rpc("status", { requestId: request.requestId })).jobId, p.jobId);
    assert.equal((await rpc("status", { jobId: p.jobId, requestId: request.requestId })).jobId, p.jobId);
    assert.equal(await rpc("status", { jobId: p.jobId, requestId: randomUUID() }), null);
    await assert.rejects(db.query("insert into intelligence_jobs(id,operation_key,observation_id,kind,codex_news_request_id) values($1,'duplicate',$2,'interpret',$3)",
      [randomUUID(), p.snapshot.observation.id, request.requestId]), /intelligence_codex_news_request/);
    assert.equal(await scalar("select pg_get_expr(indexprs,indrelid) value from pg_index where indexrelid='intelligence_codex_news_request'::regclass"), null);
    assert.equal(await scalar("select pg_get_expr(indpred,indrelid) value from pg_index where indexrelid='intelligence_codex_news_request'::regclass"), "(codex_news_request_id IS NOT NULL)");
    await assert.rejects(rpc("claim", { ...request, taskId: "/root/other" }), /identity conflict/);
    await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Explicit test hold preserves unfinished work and all prior native receipts." });
  });
  await test("stale/null leases, changed source, self review and partial reads cannot finish", async () => {
    await seed(); let p = await claim(); const b = bound(p);
    await assert.rejects(rpc("read", { ...b, lease: randomUUID() }), /claim mismatch/);
    await db.query("update intelligence_jobs set lease_until=null where id=$1", [p.jobId]);
    await assert.rejects(rpc("renew", { ...b, taskId: "/root/reader" }), /lease expired/);
    await db.query("update intelligence_jobs set lease_until=now()-interval '1 second' where id=$1", [p.jobId]);
    await assert.rejects(rpc("read", b), /lease expired/);
    p = await rpc("renew", { ...b, taskId: "/root/reader" });
    await db.query("update intelligence_observations set title='Changed title' where id=$1", [p.snapshot.observation.id]);
    await assert.rejects(rpc("read", bound(p)), /snapshot changed/);
    await db.query("update intelligence_observations set title='Office opening' where id=$1", [p.snapshot.observation.id]);
    p = await analyzed(p); const f = finishPayload(p);
    await assert.rejects(rpc("finish", { ...f, review: { ...f.review, reviewer: { ...f.review.reviewer, taskId: "/root/reader" } } }), /Independent review/);
    await assert.rejects(rpc("finish", { ...f, review: { ...f.review, reviewer: { ...f.review.reviewer, readEnd: 1 } } }), /Independent review/);
    await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Explicit test hold retains this independently uncompleted source review." });
  });
  await test("atomic publication, exact event readback and identical completion retry", async () => {
    await seed(); const p = await analyzed(await claim()); const f = finishPayload(p);
    const saved = await rpc("finish", f); assert.equal(saved.status, "complete");
    assert.equal(saved.publication.trigger.id, saved.review.receipt.triggerId); assert.equal(saved.publication.event.id, saved.review.receipt.eventId);
    assert.equal((await rpc("finish", f)).review.receipt.eventId, saved.review.receipt.eventId);
    assert.equal(await scalar("select count(*)::int value from triggers"), 1);
    assert.deepEqual(await scalar("select result->'parts' value from intelligence_jobs where id=$1", [p.jobId]), [{ native: "unchanged" }]);
    assert.equal(await scalar("select tal_alert value from companies where id=$1", [company]), true);
    assert.equal(await scalar("select status value from companies where id=$1", [company]), "removed_from_tam");
    await assert.rejects(rpc("finish", { ...f, review: { ...f.review, rationale: "Changed" } }), /retry differs/);
  });
  await test("late event failure rolls back trigger, job and observation together", async () => {
    await seed(); const p = await analyzed(await claim()), f = finishPayload(p);
    await db.exec("alter table app_events add constraint reject_review check(kind<>'intelligence.codex_news_reviewed') not valid");
    await assert.rejects(rpc("finish", f), /reject_review/);
    assert.equal(await scalar("select count(*)::int value from triggers"), 1);
    assert.equal(await scalar("select status value from intelligence_jobs where id=$1", [p.jobId]), "running");
    assert.equal(await scalar("select interpretation_version value from intelligence_observations where id=$1", [p.snapshot.observation.id]), null);
    await db.exec("alter table app_events drop constraint reject_review");
    await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Rollback verified; unfinished source remains explicitly held for this offline test." });
  });
  await test("full wrong-company review completes without a trigger; incomplete source does not", async () => {
    await seed(); const p = await analyzed(await claim(), "no_signal");
    assert.equal((await rpc("finish", finishPayload(p))).review.receipt.triggerId, null);
    await seed({ metadata: { textTruncated: true } }); const q = await claim();
    await assert.rejects(analyzed(q), /article is incomplete/);
    await rpc("hold", { ...bound(q), taskId: "/root/reader", reason: "The original body is truncated and must remain an explicit unresolved source hold." });
  });
  await test("claims exclude duplicate history, nonnews and unresolved paid dispatch; no anonymous RPC", async () => {
    await seed({ kind: "website" }); await seed({ result: { pendingRequest: { fingerprint: "unresolved-paid" } } });
    assert.equal(await claim(), null);
    const orphan = { requestId: randomUUID(), history: "must remain intact" };
    const orphaned = await seed({ result: { codexNews: orphan }, priority: 100 });
    await assert.rejects(claim(), /receipt requires reconciliation/);
    assert.deepEqual(await scalar("select result->'codexNews' value from intelligence_jobs where id=$1", [orphaned.id]), orphan);
    await db.query("update intelligence_jobs set codex_news_request_id=$1 where id=$2", [orphan.requestId, orphaned.id]);
    await seed(); await db.query("update companies set lists=array['tam_duplicate'] where id=$1", [company]); assert.equal(await claim(), null);
    for (const role of ["anon", "authenticated"]) assert.equal(await scalar("select has_function_privilege($1,'intelligence_codex_news(text,jsonb)','EXECUTE') value", [role]), false);
  });
  console.log(JSON.stringify({ offline: true, passed: checks.length, checks, providerCalls: 0, productionAccess: false }));
} finally { await db.close(); }
