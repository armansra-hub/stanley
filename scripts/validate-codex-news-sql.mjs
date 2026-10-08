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
const repair = await readFile(new URL("../supabase/migrations/0138_codex_news_scalar_claim.sql", import.meta.url), "utf8");
const sourceReview = await readFile(new URL("../supabase/migrations/0143_codex_source_review.sql", import.meta.url), "utf8");
const exactSource = await readFile(new URL("../supabase/migrations/0144_codex_exact_source_claim.sql", import.meta.url), "utf8");
const staleHold = await readFile(new URL("../supabase/migrations/0146_codex_stale_claim_hold.sql", import.meta.url), "utf8");
const scalar = async (sql, values = []) => (await db.query(sql, values)).rows[0]?.value;
const rpc = (action, payload) => scalar("select intelligence_codex_news($1,$2) value", [action, payload]);
const checks = [];
const test = async (name, action) => { try { await action(); checks.push(name); } catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
const text = "Acme opened an office. 😀 Exact original article.";
const company = randomUUID();
async function seed(options = {}) {
  const id = randomUUID(), observation = randomUUID();
  await db.query("insert into intelligence_observations(id,company_id,source_kind,source_url,title,evidence_text,content_hash,event_date,metadata) values($1,$2,$3,$4,'Office opening',$5,'sourcehash',now()-interval '1 day',$6)",
    [observation, options.company ?? company, options.kind ?? "news", `https://acme.com/news/${observation}`, text, { articleBodyAvailable: true, evidenceKind: "article_body", textTruncated: false, ...options.metadata }]);
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
  await test("migrations compile/reapply and repair both original and minified production function bodies", async () => {
    await db.exec(source); await db.exec(source); await db.exec(repair); await db.exec(repair);
    await db.exec(source.replace(/--[^\n]*/g, "").replace(/\s+/g, " "));
    await db.exec(repair); await db.exec(repair);
    const definition = await scalar("select pg_get_functiondef('intelligence_codex_news(text,jsonb)'::regprocedure) value");
    assert.ok(definition.includes("codex-news-scalar-candidates-v1"));
    const candidates = [...definition.matchAll(/for candidate_id in([\s\S]*?)\bloop\b/g)].map(m => m[1]);
    assert.equal(candidates.length, 2);
    for (const query of candidates) {
      assert.ok(!query.includes("result")); assert.ok(!/\blimit\b/i.test(query));
      const plan = await db.query(`explain (format json, verbose true) ${query}`);
      assert.ok(!JSON.stringify(plan.rows).includes("q.result"));
    }
  });
  await test("exact-source migration replays unscoped 0138 and scoped 0143 claims unchanged, including reapply", async () => {
    await seed();
    const oldRequest = { requestId: randomUUID(), taskId: "/root/reader" };
    const old = await rpc("claim", oldRequest);
    assert.equal(old.review.selection, undefined);
    await db.exec(sourceReview);
    await seed();
    const scopedRequest = { requestId: randomUUID(), taskId: "/root/reader", sourceKind: "news", companyIds: [company], observedThrough: new Date().toISOString() };
    const scoped = await rpc("claim", scopedRequest);
    const before = await scalar("select jsonb_agg(to_jsonb(q) order by id) value from intelligence_jobs q");
    await db.exec(exactSource); await db.exec(exactSource);
    assert.equal((await rpc("claim", oldRequest)).lease, old.lease);
    assert.equal((await rpc("claim", scopedRequest)).lease, scoped.lease);
    assert.deepEqual((await rpc("claim", scopedRequest)).review.selection, scoped.review.selection);
    assert.equal((await rpc("claim", scopedRequest)).review.selection.observationId, undefined);
    assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(q) order by id) value from intelligence_jobs q"), before);
    for (const p of [old, scoped]) await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Offline migration replay verified; preserve the existing claim receipt and source hold." });
    await db.exec("truncate intelligence_jobs,intelligence_observations");
  });
  await test("scalar TAL-first selection skips many pending paid candidates and large irrelevant bodies, then reaches all-TAM fallback", async () => {
    const tam = randomUUID();
    await db.query("insert into companies(id,name,domain,status,lists,tal_claimed) values($1,'TAM only','tam-only.com','new',array['netsuite_tam'],false)", [tam]);
    const unpaidTal = await seed({ priority: 0 });
    const tamJob = await seed({ company: tam, priority: 999 });
    const pendingIds = [];
    for (let n = 0; n < 40; n++) {
      pendingIds.push((await seed({ priority: 100, result: { pendingRequest: { fingerprint: `paid-${n}`, retained: "x".repeat(90_000) } } })).id);
      await seed({ kind: "website", priority: 1000, result: { parts: [{ retained: "z".repeat(90_000) }] } });
    }
    const p = await claim(); assert.equal(p.jobId, unpaidTal.id);
    await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Offline completed selection check; keep original source explicitly uncompleted." });
    const q = await claim(); assert.equal(q.jobId, tamJob.id);
    assert.equal(await scalar("select count(*)::int value from intelligence_jobs where id=any($1::uuid[]) and status='queued' and codex_news_request_id is null and result->'pendingRequest'->>'fingerprint' like 'paid-%'", [pendingIds]), 40);
    // Synthetic fixture cleanup only; no production connection exists.
    await db.exec("truncate intelligence_jobs,intelligence_observations");
  });
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
  await test("nonnews finite selector, complete-body gates, original bindings and canonical publication", async () => {
    await db.exec("truncate intelligence_jobs,intelligence_observations");
    await db.query("update companies set lists=array['netsuite_tam'],status='new' where id=$1", [company]);
    const metadata = { textTruncated: false, retainedCharacters: text.length, sourceCharacters: text.length,
      discovery: { collector: "website" }, meaningfulContentHash: "a".repeat(64) };
    const website = await seed({ kind: "website", metadata });
    const req = { requestId: randomUUID(), taskId: "/root/reader", sourceKind: "website", companyIds: [company], observedThrough: new Date().toISOString() };
    const p = await rpc("claim", req); assert.equal(p.jobId, website.id); assert.equal(p.snapshot.observation.source_kind, "website");
    assert.equal((await rpc("claim", req)).jobId, p.jobId);
    await assert.rejects(rpc("claim", { ...req, sourceKind: "job" }), /selection conflict/);
    const a = await analyzed(p); const f = finishPayload(a); f.trigger.source_name = "Codex · Independently reviewed public website";
    const saved = await rpc("finish", f); assert.equal(saved.status, "complete");
    assert.equal(saved.publication.trigger.id, saved.review.receipt.triggerId);
    const job = await seed({ kind: "job", metadata: { ...metadata, atsType: "lever", atsToken: "acme", atsJobKey: "1", descriptionAvailable: true, bodySchemaValidated: true, bodySchemaVersion: "ats-body-schema-v1" } });
    const q = await rpc("claim", { ...req, requestId: randomUUID(), sourceKind: "job", observedThrough: new Date().toISOString() });
    assert.equal(q.jobId, job.id);
    assert.equal((await rpc("finish", finishPayload(await analyzed(q, "no_signal")))).review.receipt.triggerId, null);
    for (const provenance of [{}, { bodySchemaValidated: "true", bodySchemaVersion: "ats-body-schema-v1" }, { bodySchemaValidated: true, bodySchemaVersion: "unknown" }]) {
      await seed({ kind: "job", metadata: { ...metadata, atsType: "lever", atsToken: "acme", atsJobKey: "1", descriptionAvailable: true, ...provenance } });
      const incomplete = await rpc("claim", { ...req, requestId: randomUUID(), sourceKind: "job", observedThrough: new Date().toISOString() });
      await assert.rejects(analyzed(incomplete, "no_signal"), /Job completeness provenance missing/);
      await rpc("hold", { ...bound(incomplete), taskId: "/root/reader", reason: "Original body schema provenance absent or invalid; retain hold until verified capture exists." });
    }
    await seed({ kind: "website", metadata: { ...metadata, textTruncated: true } });
    const bad = await rpc("claim", { ...req, requestId: randomUUID(), observedThrough: new Date().toISOString() });
    await assert.rejects(analyzed(bad), /source is incomplete/);
    await rpc("hold", { ...bound(bad), taskId: "/root/reader", reason: "Original website text incomplete; explicit unresolved hold, no negative completion." });
    await assert.rejects(rpc("claim", { ...req, requestId: randomUUID(), sourceKind: "federal_award" }), /Unsupported/);
    await assert.rejects(rpc("claim", { ...req, requestId: randomUUID(), companyIds: [company, company] }), /Duplicate/);
    await assert.rejects(rpc("claim", { requestId: randomUUID(), taskId: "/root/reader", companyIds: [company] }), /Finite scope/);
    assert.equal(await rpc("claim", { ...req, requestId: randomUUID(), observedThrough: "2000-01-01T00:00:00Z" }), null);
  });
  const exactRequest = (observationId, overrides = {}) => ({ requestId: randomUUID(), taskId: "/root/reader", sourceKind: "news", companyIds: [company], observedThrough: new Date().toISOString(), observationId, ...overrides });
  const resetExact = async () => {
    await db.exec("truncate intelligence_jobs,intelligence_observations");
    await db.query("update companies set lists=array['tam_removed'],status='removed_from_tam',tal_claimed=true where id=$1", [company]);
  };
  const seedExact = async options => {
    const seeded = await seed(options);
    await db.query("update intelligence_observations set observed_at=now()-interval '1 second' where id=$1", [seeded.observation]);
    return seeded;
  };
  const savedJobs = () => scalar("select jsonb_agg(to_jsonb(q) order by id) value from intelligence_jobs q");
  await test("exact observation bypasses older incompatible siblings in TAL and TAM without changing default ordering", async () => {
    for (const tal of [true, false]) {
      await resetExact();
      if (!tal) await db.query("update companies set lists=array['netsuite_tam'],status='new',tal_claimed=false where id=$1", [company]);
      const older = await seedExact({ kind: "job", priority: 999, metadata: { descriptionAvailable: true,
        sourceCharacters: text.length, retainedCharacters: text.length, atsType: "lever", atsToken: "acme", atsJobKey: "old" } });
      const target = await seedExact({ kind: "job", metadata: { textTruncated: false, sourceCharacters: text.length, retainedCharacters: text.length,
        atsType: "lever", atsToken: "acme", atsJobKey: "new", descriptionAvailable: true, bodySchemaValidated: true, bodySchemaVersion: "ats-body-schema-v1" } });
      const before = await scalar("select to_jsonb(q) value from intelligence_jobs q where id=$1", [older.id]);
      const req = exactRequest(target.observation, { sourceKind: "job" });
      const p = await rpc("claim", req); assert.equal(p.jobId, target.id);
      assert.equal(p.review.selection.observationId, target.observation);
      assert.deepEqual(await scalar("select to_jsonb(q) value from intelligence_jobs q where id=$1", [older.id]), before);
      assert.equal((await rpc("claim", req)).lease, p.lease);
      await assert.rejects(rpc("claim", { ...req, observationId: older.observation }), /selection conflict/);
      const { observationId: omitted, ...withoutTarget } = req;
      await assert.rejects(rpc("claim", withoutTarget), /selection conflict/);
      const complete = await rpc("finish", finishPayload(await analyzed(p, "no_signal")));
      assert.equal(complete.review.receipt.observationId, target.observation);
      assert.equal(complete.publication.event.id, complete.review.receipt.eventId);
      assert.equal(complete.publication.trigger, null);
      assert.equal((await rpc("status", { requestId: req.requestId })).review.receipt.eventId, complete.review.receipt.eventId);
      // Exact selection does not rewrite the historical source or its missing provenance.
      const defaultClaim = await rpc("claim", { ...withoutTarget, requestId: randomUUID() });
      assert.equal(defaultClaim.jobId, older.id);
      await assert.rejects(analyzed(defaultClaim, "no_signal"), /Job completeness provenance missing/);
      await rpc("hold", { ...bound(defaultClaim), taskId: "/root/reader", reason: "Older incompatible source remains held; exact selection did not alter its provenance." });
    }
  });
  await test("invalid exact selectors reject before mutation and require explicit source plus singleton scope", async () => {
    await resetExact(); const target = await seedExact(); const valid = exactRequest(target.observation); const before = await savedJobs();
    for (const value of [null, "", "not-a-uuid", 1, true, [], {}, target.observation.replaceAll("-", "")]) {
      await assert.rejects(rpc("claim", { ...valid, observationId: value }), /Exact observation/);
    }
    for (const key of ["sourceKind", "companyIds", "observedThrough"]) {
      const invalid = { ...valid }; delete invalid[key];
      await assert.rejects(rpc("claim", invalid), /Exact observation|Finite scope/);
    }
    const unscoped = { ...valid }; delete unscoped.companyIds; delete unscoped.observedThrough;
    await assert.rejects(rpc("claim", unscoped), /Exact observation/);
    await assert.rejects(rpc("claim", { ...valid, sourceKind: null }), /Exact observation/);
    await assert.rejects(rpc("claim", { ...valid, companyIds: [company, randomUUID()] }), /Exact observation/);
    assert.deepEqual(await savedJobs(), before);
  });
  await test("missing or ineligible exact sources never fall back to other observations or revive existing work", async () => {
    const cases = [
      ["unknown observation", async (_t, req) => { req.observationId = randomUUID(); }],
      ["wrong company", async (_t, req) => { req.companyIds = [randomUUID()]; }],
      ["wrong kind", async (_t, req) => { req.sourceKind = "website"; }],
      ["cutoff", async (_t, req) => { req.observedThrough = "2000-01-01T00:00:00Z"; }],
      ["pending provider", async t => { await db.query("update intelligence_jobs set result=result||jsonb_build_object('pendingRequest',jsonb_build_object('fingerprint','existing-paid')) where id=$1", [t.id]); }],
      ["complete", async t => { await db.query("update intelligence_jobs set status='complete' where id=$1", [t.id]); }],
      ["running", async t => { await db.query("update intelligence_jobs set status='running',lease_token=$2,lease_until=now()+interval '20 minutes' where id=$1", [t.id, randomUUID()]); }],
      ["not due", async t => { await db.query("update intelligence_jobs set due_at=now()+interval '1 day' where id=$1", [t.id]); }],
      ["noninterpret", async t => { await db.query("update intelligence_jobs set kind='other' where id=$1", [t.id]); }],
      ["superseded", async t => { await db.query("update intelligence_observations set is_current=false where id=$1", [t.observation]); }],
      ["feedback excluded", async t => { await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [t.observation]); }],
      ["duplicate TAL history", async () => { await db.query("update companies set lists=array['tam_duplicate'] where id=$1", [company]); }],
      ["removed non-TAL", async () => { await db.query("update companies set lists=array['netsuite_tam'],tal_claimed=false,status='removed_from_tam' where id=$1", [company]); }],
      ["held", async (t, req) => { const p = await rpc("claim", req); await rpc("hold", { ...bound(p), taskId: "/root/reader", reason: "Existing canonical hold must not be reopened by another exact observation claim." }); req.requestId = randomUUID(); }],
    ];
    for (const [name, change] of cases) {
      await resetExact();
      await seedExact({ priority: 999 }); await seedExact({ kind: "website", priority: 999 });
      const target = await seedExact(); const req = exactRequest(target.observation);
      await change(target, req); const before = await savedJobs();
      assert.equal(await rpc("claim", req), null, name);
      assert.deepEqual(await savedJobs(), before, `${name} modified a job`);
    }
    await resetExact();
    const target = await seedExact({ result: { codexNews: { requestId: randomUUID(), history: "orphan-preserved" } } });
    const before = await savedJobs();
    await assert.rejects(rpc("claim", exactRequest(target.observation)), /receipt requires reconciliation/);
    assert.deepEqual(await savedJobs(), before);
  });
  await test("exact observation retains provider pause, capacity, source, snapshot, review and SQL privilege gates", async () => {
    await resetExact(); const target = await seedExact(); const req = exactRequest(target.observation);
    await db.exec("update intelligence_jev_budget_policy set enabled=true");
    await assert.rejects(rpc("claim", req), /admission unavailable/);
    await db.exec("update intelligence_jev_budget_policy set enabled=false; update intelligence_config set enabled=false");
    await assert.rejects(rpc("claim", req), /admission unavailable/);
    await db.exec("update intelligence_config set enabled=true");
    const active = [];
    for (let n = 0; n < 3; n++) { const t = await seedExact(); active.push(await rpc("claim", exactRequest(t.observation))); }
    const before = await savedJobs(); assert.equal(await rpc("claim", req), null); assert.deepEqual(await savedJobs(), before);
    await rpc("hold", { ...bound(active[0]), taskId: "/root/reader", reason: "Offline release of one capacity slot; all other active lease identities remain unchanged." });
    const p = await rpc("claim", req); assert.equal(p.jobId, target.id);
    await db.query("update intelligence_observations set title='Changed' where id=$1", [target.observation]);
    await assert.rejects(analyzed(p, "no_signal"), /snapshot changed/);
    await db.query("update intelligence_observations set title='Office opening' where id=$1", [target.observation]);
    const a = await analyzed(p, "no_signal"), f = finishPayload(a);
    await assert.rejects(rpc("finish", { ...f, review: { ...f.review, reviewer: { ...f.review.reviewer, taskId: "/root/reader" } } }), /Independent review/);
    await assert.rejects(rpc("finish", { ...f, review: { ...f.review, reviewer: { ...f.review.reviewer, readEnd: 1 } } }), /Independent review/);
    assert.equal((await rpc("finish", f)).review.receipt.triggerId, null);
    await resetExact();
    const capacityTarget = await seedExact();
    for (let n = 0; n < 12; n++) {
      const worker = await seedExact();
      await db.query("update intelligence_jobs set status='running',lease_token=$2,lease_until=now()+interval '20 minutes' where id=$1", [worker.id, randomUUID()]);
    }
    const capacityBefore = await savedJobs();
    assert.equal(await rpc("claim", exactRequest(capacityTarget.observation)), null);
    assert.deepEqual(await savedJobs(), capacityBefore);
    await resetExact();
    const incomplete = await seedExact({ metadata: { articleBodyAvailable: false } });
    const bad = await rpc("claim", exactRequest(incomplete.observation));
    await assert.rejects(analyzed(bad, "no_signal"), /article is incomplete/);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_codex_news(text,jsonb)','EXECUTE') value", [role]), false);
      await db.exec(`set role ${role}`);
      try { await assert.rejects(rpc("claim", exactRequest(incomplete.observation)), /permission denied/); }
      finally { await db.exec("reset role"); }
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_codex_news(text,jsonb)','EXECUTE') value"), true);
  });
  await db.exec(staleHold);
  await test("stale hold migration preserves the existing function branches and rejects completed, held, unchanged or paid work", async () => {
    const marker=" if p_action='reconcile_hold' then", end=" if p_action='status' then";
    const oldBody=exactSource.slice(exactSource.indexOf("create or replace function")).replaceAll("\r\n","\n");
    const newBody=staleHold.slice(staleHold.indexOf("create or replace function")).replaceAll("\r\n","\n");
    assert.equal(newBody.slice(0,newBody.indexOf(marker))+newBody.slice(newBody.indexOf(end)),oldBody);
    for(const mode of ["unchanged","complete","hold","paid_pending"]){
      await resetExact(); const target=await seedExact(); const p=await rpc("claim",exactRequest(target.observation));
      if(mode==="complete"){const a=await analyzed(p,"no_signal");await rpc("finish",finishPayload(a));}
      if(mode==="hold")await rpc("hold",{...bound(p),taskId:"/root/reader",reason:"The original source has an unresolved limitation; it must remain explicitly held without reconciliation."});
      if(mode!=="unchanged")await db.query("update intelligence_observations set title='Changed' where id=$1",[target.observation]);
      if(mode==="paid_pending")await db.query("update intelligence_jobs set result=result||'{\"pendingRequest\":{\"unresolved\":true}}'::jsonb where id=$1",[p.jobId]);
      if(mode!=="complete"&&mode!=="hold")await db.query("update intelligence_jobs set lease_until=now()-interval '1 minute' where id=$1",[p.jobId]);
      const now=await rpc("status",{jobId:p.jobId});
      const req={action:"reconcile_hold",...bound(p),requestId:p.review.requestId,currentSnapshotHash:now.snapshotHash,taskId:"/root/coordinator",reviewerTaskId:"/root/reviewer",incidentId:randomUUID(),evidenceSha256:"e".repeat(64),reason:"This fixture must not be mutated by incident reconciliation; the existing ordinary completion and hold gates remain binding."};
      const before=await savedJobs();await assert.rejects(rpc("reconcile_hold",req));assert.deepEqual(await savedJobs(),before);
    }
  });
  await test("expired changed snapshot retires to an explicit held incident with complete preservation and exact idempotent event", async () => {
    await resetExact(); const target=await seedExact(); const p=await rpc("claim",exactRequest(target.observation));
    const a=await analyzed(p,"no_signal");
    await db.query("update intelligence_jobs set lease_until=now()-interval '1 minute' where id=$1",[p.jobId]);
    await db.query("update companies set status='new' where id=$1",[p.snapshot.company.id]);
    // Ensure changed source even when the fixture already used status=new.
    await db.query("update intelligence_observations set title='Changed title after claim' where id=$1",[target.observation]);
    const current=await rpc("status",{jobId:p.jobId});
    const req={action:"reconcile_hold",...bound(p),requestId:p.review.requestId,currentSnapshotHash:current.snapshotHash,taskId:"/root/coordinator",
      reviewerTaskId:"/root/incident_reviewer",incidentId:randomUUID(),evidenceSha256:"e".repeat(64),reason:"Independently reconciled immutable prior and current snapshots and failed requests. Retain an explicit incomplete hold without completion."};
    const before=await scalar("select to_jsonb(j) value from intelligence_jobs j where id=$1",[p.jobId]);
    const otherBefore=await scalar("select jsonb_build_object('companies',(select jsonb_agg(c) from companies c),'observations',(select jsonb_agg(o) from intelligence_observations o),'triggers',(select jsonb_agg(t) from triggers t),'jev',(select jsonb_agg(b) from intelligence_jev_budget_policy b)) value");
    for(const mutation of [{jobId:randomUUID()},{requestId:randomUUID()},{lease:randomUUID()},{snapshotHash:"f".repeat(64)},
      {currentSnapshotHash:p.snapshotHash},{reviewerTaskId:req.taskId},{evidenceSha256:"bad"},{reason:"short"},{force:true}]){
      await assert.rejects(rpc("reconcile_hold",{...req,...mutation}));
      assert.deepEqual(await scalar("select to_jsonb(j) value from intelligence_jobs j where id=$1",[p.jobId]),before);
    }
    await db.query("update intelligence_jobs set lease_until=now()+interval '1 minute' where id=$1",[p.jobId]);
    await assert.rejects(rpc("reconcile_hold",req),/expired/);
    await db.query("update intelligence_jobs set lease_until=$2 where id=$1",[p.jobId,before.lease_until]);
    await db.query("update intelligence_jobs set result=result||'{\"pendingRequest\":{\"unresolved\":true}}'::jsonb where id=$1",[p.jobId]);
    await assert.rejects(rpc("reconcile_hold",req),/expired/);
    await db.query("update intelligence_jobs set result=result-'pendingRequest' where id=$1",[p.jobId]);
    const held=await rpc("reconcile_hold",req), rec=held.review.reconciliation;
    assert.equal(held.status,"queued");assert.equal(held.lease,null);assert.equal(held.leaseUntil,null);assert.equal(held.review.receipt,undefined);
    assert.equal(held.review.hold,req.reason);assert.deepEqual(held.review.analysis,a.review.analysis);assert.equal(held.review.decisionHash,a.review.decisionHash);
    assert.equal(held.review.snapshotHash,p.snapshotHash);assert.deepEqual(rec.currentSnapshot,current.snapshot);assert.deepEqual(rec.request,req);
    assert.equal(rec.receipt.analysisCompleted,false);assert.equal(rec.receipt.triggerId,null);
    const after=await scalar("select to_jsonb(j) value from intelligence_jobs j where id=$1",[p.jobId]);
    assert.deepEqual(after.result.parts,before.result.parts);assert.equal(after.attempts,before.attempts);assert.equal(after.finished_at,before.finished_at);
    const event=await scalar("select to_jsonb(e) value from app_events e where id=$1",[rec.receipt.eventId]);
    const {eventId,...meta}=rec.receipt;assert.deepEqual(event.meta,meta);assert.equal(event.kind,"intelligence.codex_news_held");
    assert.deepEqual(await rpc("reconcile_hold",req),held);assert.deepEqual(await rpc("status",{jobId:p.jobId}),held);
    await assert.rejects(rpc("reconcile_hold",{...req,incidentId:randomUUID()}),/retry differs/);
    assert.equal(await scalar("select count(*)::int value from app_events where entity_id=$1 and kind='intelligence.codex_news_held'",[p.jobId]),1);
    assert.deepEqual(await scalar("select jsonb_build_object('companies',(select jsonb_agg(c) from companies c),'observations',(select jsonb_agg(o) from intelligence_observations o),'triggers',(select jsonb_agg(t) from triggers t),'jev',(select jsonb_agg(b) from intelligence_jev_budget_policy b)) value"),otherBefore);
    assert.equal(await rpc("claim",exactRequest(target.observation)),null);
    for(const role of ["anon","authenticated"])assert.equal(await scalar("select has_function_privilege($1,'intelligence_codex_news(text,jsonb)','EXECUTE') value",[role]),false);
  });
  console.log(JSON.stringify({ offline: true, passed: checks.length, checks, providerCalls: 0, productionAccess: false }));
} finally { await db.close(); }
