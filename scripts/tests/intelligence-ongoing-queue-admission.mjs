/** Offline PostgreSQL integration through actual 0119 -> 0123 -> 0124.
 * No provider/production IO. PGlite does not prove concurrent lock behavior. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const migrate = async name => db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
let passed = 0;
const check = async (name, run) => {
  await db.exec("begin");
  try { await run(); passed++; console.log(`PASS ${name}`); }
  finally { await db.exec("rollback"); }
};
const claimEvidence = limit => rows("select * from intelligence_claim($1)", [limit]);
const claimQuestion = () => scalar("select intelligence_account_question_claim()");
const snapshot = () => scalar(`select jsonb_build_object(
  'config',(select to_jsonb(c) from intelligence_config c),
  'policy',(select to_jsonb(p) from intelligence_jev_budget_policy p),
  'jobs',(select jsonb_agg(to_jsonb(j) order by id) from intelligence_jobs j),
  'questions',(select jsonb_agg(to_jsonb(q) order by view_id,company_id) from intelligence_account_question_jobs q),
  'spend',(select jsonb_agg(to_jsonb(s) order by id) from intelligence_spend s))`);

try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,netsuite_internal_id text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,subindustry text,ns_industry text,city text,state text,is_base boolean,claimable boolean);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);
    create table intelligence_shared_sources(id text primary key,name text,url text,enabled boolean,format text,scope text,states text[],verification_url text,verified_at timestamptz,poll_minutes int,coverage_description text);`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql",
    "0067_intelligence_directed_research_queue.sql", "0071_collection_repair.sql", "0074_directed_research_discovery.sql", "0075_fresh_intelligence_priority.sql",
    "0081_intelligence_document_discoveries.sql", "0105_intelligence_reuse_answered_topics.sql"]) await migrate(name);
  // The pre-catalog saved-question function is not exercised in rollout. Its
  // table contract is sufficient; both tested claim functions come from 0119.
  await db.exec(`alter table intelligence_research_sources add column metadata jsonb not null default '{}';
    create table intelligence_account_question_jobs(view_id uuid references intelligence_views(id),company_id uuid references companies(id),
      revision bigint default 1,running_revision bigint,status text default 'queued',due_at timestamptz default now(),lease_token uuid,
      lease_until timestamptz,checkpoint jsonb,last_error text,updated_at timestamptz default now(),primary key(view_id,company_id));
    create function intelligence_account_question_claim() returns jsonb language sql as $$select null::jsonb$$;`);
  for (const name of ["0082_jev_request_receipts.sql", "0090_native_jev_purposes.sql", "0107_intelligence_research_caught_up.sql",
    "0108_intelligence_coverage_priority.sql", "0109_intelligence_symmetric_answer_reuse.sql", "0112_intelligence_worker_capacity.sql",
    "0117_jev_global_budget_policy.sql", "0119_intelligence_catalog_coverage.sql", "0123_jev_provider_balance_mode.sql"]) await migrate(name);
  await db.exec(`update intelligence_config set enabled=true,catalog_mode='rollout',catalog_legacy_cutoff_at=now()-interval '1 day';
    update intelligence_jev_budget_policy set enabled=true,enforcement='provider_balance',halt_reason=null,
      confirmed_available_usd=100,funding_confirmed_at=now(),funding_receipt='offline fixture',
      legacy_reconciliation_status='reconciled',opening_liability_usd=0,reconciliation_receipt='offline fixture',
      initial_starts_at=now()-interval '2 days',initial_expires_at=now()-interval '1 day',maintenance_expires_at=now()+interval '1 day';`);
  const company = randomUUID(), observation = randomUUID(), view = randomUUID(), jobs = Array.from({ length: 16 }, () => randomUUID());
  await db.query(`insert into companies(id,name,status,lists,netsuite_internal_id,domain)
    values($1,'Synthetic eligible account','new',array['netsuite_tam'],'1234','synthetic.test')`, [company]);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash)
    values($1,$2,'site','website','https://synthetic.test/','Services','Exact retained source evidence','source-hash')`, [observation, company]);
  for (let i = 0; i < jobs.length; i++) await db.query(`insert into intelligence_jobs(id,operation_key,observation_id,kind,priority,result)
    values($1,$2,$3,'interpret',$4,'{"saved":"exact checkpoint"}')`, [jobs[i], `fixture-${i}`, observation, i]);
  await db.query("insert into intelligence_views(id,name,question) values($1,'Synthetic saved question','Does the company have multiple offices?')", [view]);
  await db.query("insert into intelligence_account_question_jobs(view_id,company_id,revision) values($1,$2,7)", [view, company]);

  await check("actual 0119 plus 0123 reproduces silent queue starvation in ongoing mode", async () => {
    assert.equal((await scalar("select intelligence_jev_budget_status()")).phase, "ongoing");
    assert.equal((await claimEvidence(6)).length, 0);
    assert.equal(await claimQuestion(), null);
    assert.equal(await scalar("select count(*)::int from intelligence_jobs where status='queued'"), 16);
  });
  const before = await snapshot();
  const definitions = await rows(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc
    where oid in ('intelligence_claim(integer)'::regprocedure,'intelligence_account_question_claim()'::regprocedure)`);
  await migrate("0124_intelligence_ongoing_queue_admission.sql");
  assert.deepEqual(await snapshot(), before, "installation must not activate, reset, requeue, dispatch or edit data");
  for (const definition of definitions) {
    const after = await scalar("select pg_get_functiondef($1::regprocedure)", [definition.signature]);
    assert.equal(after, definition.definition.replace("policy->>'phase'<>'maintenance'", "policy->>'phase' not in ('maintenance','ongoing')"));
  }
  console.log("PASS installation changes only the two phase predicates and leaves every stored row intact"); passed++;

  await check("ongoing mode claims existing eligible work with original capacity, priority and checkpoints", async () => {
    const first = await claimEvidence(100);
    assert.equal(first.length, 6);
    assert.deepEqual(first.map(j => j.priority).sort((a, b) => a - b), [10, 11, 12, 13, 14, 15]);
    assert.ok(first.every(j => j.status === "running" && j.attempts === 1 && j.lease_token && j.result.saved === "exact checkpoint"));
    const second = await claimEvidence(100);
    assert.equal(second.length, 6);
    assert.equal(new Set([...first, ...second].map(j => j.id)).size, 12);
    assert.equal((await claimEvidence(1)).length, 0, "global twelve-slot capacity remains binding");
    assert.equal(await scalar("select count(*)::int from intelligence_spend"), 0, "claiming work does not dispatch or charge Jev");
  });
  await check("ongoing mode resumes saved questions with exact evidence and revision", async () => {
    const q = await claimQuestion();
    assert.equal(q.company_id, company); assert.equal(q.view_id, view); assert.equal(q.running_revision, 7);
    assert.deepEqual(q.source_ids, [observation]); assert.ok(q.lease_token); assert.equal(q.status, "running");
    assert.equal(await claimQuestion(), null, "a live question lease must not be reclaimed");
    await db.query(`update intelligence_account_question_jobs set lease_until=now()-interval '1 second',
      checkpoint='{"saved":"answer checkpoint"}',running_revision=5 where view_id=$1`, [view]);
    const resumed = await claimQuestion();
    assert.deepEqual(resumed.checkpoint, { saved: "answer checkpoint" }); assert.equal(resumed.running_revision, 5);
    assert.equal(resumed.source_ids, null, "resume uses its existing source checkpoint");
  });
  await check("fresh priority and the reserved tenth-turn legacy slot are unchanged", async () => {
    await db.query("update intelligence_jobs set created_at=now()-interval '2 days',priority=999 where id=$1", [jobs[0]]);
    await db.exec("update intelligence_config set catalog_legacy_claim_turn=0");
    assert.notEqual((await claimEvidence(1))[0].id, jobs[0]);
    await db.exec("update intelligence_config set catalog_legacy_claim_turn=9");
    assert.equal((await claimEvidence(1))[0].id, jobs[0]);
  });
  for (const reason of ["manual_pause", "provider_billing_unavailable", "provider_authentication_unavailable"]) {
    await check(`${reason} still stops both queues and remains recorded`, async () => {
      await db.query("update intelligence_jev_budget_policy set enabled=false,halt_reason=$1", [reason]);
      const held = await snapshot();
      assert.equal((await claimEvidence(6)).length, 0); assert.equal(await claimQuestion(), null);
      assert.deepEqual(await snapshot(), held);
    });
  }
  await check("engine-disabled and pilot states still suppress both queues", async () => {
    await db.exec("update intelligence_config set enabled=false");
    assert.equal((await claimEvidence(6)).length, 0); assert.equal(await claimQuestion(), null);
    await db.exec("update intelligence_config set enabled=true,catalog_mode='pilot'");
    assert.equal((await claimEvidence(6)).length, 0); assert.equal(await claimQuestion(), null);
  });
  await check("fixed-allowance maintenance still works and initial funding stays catalog-only", async () => {
    await db.exec("update intelligence_jev_budget_policy set enforcement='budget_caps'");
    assert.equal((await scalar("select intelligence_jev_budget_status()")).phase, "maintenance");
    assert.equal((await claimEvidence(1)).length, 1); assert.ok(await claimQuestion());
    await db.exec("update intelligence_jev_budget_policy set initial_expires_at=now()+interval '1 hour'");
    assert.equal((await scalar("select intelligence_jev_budget_status()")).phase, "initial");
    assert.equal((await claimEvidence(1)).length, 0); assert.equal(await claimQuestion(), null);
  });
  await check("removed, duplicate and noncanonical accounts remain ineligible for both queues", async () => {
    for (const change of ["status='removed_from_tam'", "lists=array['netsuite_tam','tam_duplicate']", "lists='{}'", "netsuite_internal_id='not-an-internal-id'"]) {
      await db.exec("savepoint eligibility_case");
      await db.exec(`update companies set ${change}`);
      assert.equal((await claimEvidence(1)).length, 0); assert.equal(await claimQuestion(), null);
      await db.exec("rollback to savepoint eligibility_case");
    }
  });
  await check("existing public permissions remain restricted to service_role", async () => {
    for (const signature of ["intelligence_claim(integer)", "intelligence_account_question_claim()"]) {
      for (const role of ["anon", "authenticated"]) assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')", [role, signature]), false);
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')", [signature]), true);
    }
  });
  await db.exec("update intelligence_jev_budget_policy set enabled=false,halt_reason='provider_authentication_unavailable'");
  const heldBeforeInstall = await snapshot();
  await migrate("0124_intelligence_ongoing_queue_admission.sql");
  assert.deepEqual(await snapshot(), heldBeforeInstall);
  console.log("PASS installing the repair over a live authentication hold preserves it exactly"); passed++;
  console.log(`${passed} ongoing-queue integration checks passed; actual concurrent locking not tested.`);
} finally { await db.close(); }
