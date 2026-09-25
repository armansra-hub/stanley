/** Offline real-migration PostgreSQL checks. No provider or production IO.
 * PGlite serializes connections; these do not prove concurrent locking. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const migrate = async name => db.exec(await readFile(new URL("../../supabase/migrations/" + name, import.meta.url), "utf8"));
const key = () => randomUUID().replaceAll("-", "").repeat(2);
const claim = (purpose = "operating_catalog", fingerprint = key()) => scalar(
  "select intelligence_jev_claim($1,$2,null,null,'catalog','initial_coverage')", [fingerprint, purpose]);
const dispatch = (c, fp, model = "jev-1.13.0") => scalar(
  "select intelligence_jev_dispatch($1,$2,$3,$4)", [fp, c.reservationId, c.leaseToken, model]);
const record = (c, fp, evaluation) => scalar("select intelligence_jev_record($1,$2,$3,$4)", [fp, c.leaseToken, c.reservationId, evaluation]);
const settle = (c, fp) => scalar("select intelligence_jev_settle($1,$2)", [fp, c.reservationId]);
const purposes = ["operating_catalog", "public_interpretation", "research_ranking", "saved_view", "federal_identity", "event_match", "codex_connector"];
const policy = "jev-rollout-2026-09-24";
const reservation = 0.002753;
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log("PASS " + name); };
const resume = () => db.exec("update intelligence_jev_budget_policy set enabled=true,halt_reason=null; update intelligence_config set enabled=true");

try {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table companies(id uuid primary key,status text not null); create table trigger_candidates(id uuid primary key,created_at timestamptz,verdict text,promoted_trigger_id uuid)");
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0082_jev_request_receipts.sql", "0090_native_jev_purposes.sql"]) await migrate(name);
  const legacyId = randomUUID();
  await db.query("insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,input_tokens,state) values($1,'2020-01-01','jev',119.678,119.678,null,'settled')", [legacyId]);
  await migrate("0117_jev_global_budget_policy.sql");
  const unknownId = randomUUID();
  await db.query(`insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,input_tokens,state,jev_policy_id,jev_phase,jev_budget_day,jev_model,jev_max_input_tokens,jev_usd_per_million,dispatched_at)
    values($1,'2020-01-01','jev',9999,9999,null,'settled',$2,'maintenance','2020-01-01','jev-1.13.0',65536,.042,'2020-01-01')`, [unknownId, policy]);
  const history = await scalar("select jsonb_agg(to_jsonb(s) order by id) from intelligence_spend s");
  const priorPolicy = await scalar("select to_jsonb(p) from intelligence_jev_budget_policy p");
  await migrate("0123_jev_provider_balance_mode.sql");

  await check("installation preserves existing policy mode, authorization and every historical financial value", async () => {
    assert.deepEqual(await scalar("select to_jsonb(p)-'enforcement' from intelligence_jev_budget_policy p"), priorPolicy);
    assert.equal(await scalar("select enforcement from intelligence_jev_budget_policy"), "budget_caps");
    assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(s) order by id) from intelligence_spend s"), history);
    assert.equal((await claim()).reason, "policy_disabled");
    await resume();
    await db.exec(`update intelligence_config set monthly_limit_usd=0,jev_limit_usd=0;
      update intelligence_jev_budget_policy set initial_starts_at='2020-01-01',initial_expires_at='2020-01-02',maintenance_expires_at='2020-03-02',
      initial_limit_usd=0,initial_effective_limit_usd=0,daily_limit_usd=0,maintenance_limit_usd=0,confirmed_available_usd=0,
      opening_liability_usd=9999,legacy_reconciliation_status='reconciled',funding_confirmed_at=now(),
      funding_receipt='offline funded receipt',reconciliation_receipt='offline legacy receipt'`);
    assert.equal((await claim()).status, "budget_deferred");
    assert.equal((await scalar("select intelligence_jev_budget_status()")).enforcement, "budget_caps");
  });

  await check("explicit provider-balance mode admits every public purpose despite all old caps, expiry, zero estimate and unknown holds", async () => {
    await db.exec("update intelligence_jev_budget_policy set enforcement='provider_balance'");
    for (const purpose of purposes) {
      const c = await claim(purpose);
      assert.equal(c.status, "execute", purpose);
      assert.equal(await scalar("select jev_phase from intelligence_spend where id=$1", [c.reservationId]), "ongoing");
      assert.equal(Number(await scalar("select reserved_usd from intelligence_spend where id=$1", [c.reservationId])), reservation);
    }
    const status = await scalar("select intelligence_jev_budget_status()");
    assert.equal(status.enabled, true); assert.equal(status.enforcement, "provider_balance"); assert.equal(status.phase, "ongoing");
    for (const field of ["initialMaxUsd", "dailyCapUsd", "maintenanceLimitUsd", "totalRemainingUsd", "dailyRemainingUsd", "initialRemainingUsd", "maintenanceRemainingUsd", "nextResetAt", "initialExpiresAt", "maintenanceExpiresAt", "providerBalanceUsd", "providerBalanceAsOf"])
      assert.equal(status[field], null, field);
    assert.ok(Number(status.unknownReserveUsd) >= 9999);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [legacyId])), 119.678);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [unknownId])), 9999);
  });

  await check("private TAM and untracked or under-reserved dispatch bypasses remain closed", async () => {
    await assert.rejects(claim("private_tam"), /Invalid cache request/);
    await assert.rejects(scalar("select intelligence_reserve_jev($1,.002753,'private_tam',null,null,'tam',$2,'manual')", [randomUUID(), key()]), /Invalid Jev policy attribution/);
    assert.equal(await scalar("select intelligence_reserve($1,'jev',.002753)", [randomUUID()]), false);
    assert.equal(await scalar("select intelligence_reserve_jev($1,.000001,'operating_catalog',null,null,'catalog',$2,'manual')", [randomUUID(), key()]), false);
    assert.equal(await scalar("select intelligence_reserve($1,'generation',.03)", [randomUUID()]), false);
  });

  await check("tickets remain model-bound, lease-bound, one-use and expiration-aware", async () => {
    const fp = key(), c = await claim("operating_catalog", fp);
    assert.equal((await dispatch(c, fp, "jev-1.14.0")).status, "budget_deferred");
    assert.equal((await dispatch({ ...c, leaseToken: randomUUID() }, fp)).reason, "invalid_dispatch_ticket");
    assert.equal((await dispatch(c, fp)).status, "authorized");
    assert.equal((await dispatch(c, fp)).status, "budget_deferred");
    const expiredFp = key(), expired = await claim("operating_catalog", expiredFp);
    await db.query("update intelligence_spend set dispatch_expires_at='2020-01-01' where id=$1", [expired.reservationId]);
    assert.equal((await dispatch(expired, expiredFp)).reason, "invalid_or_expired_dispatch_ticket");
  });

  let cachedFp, cachedClaim, cachedEvaluation;
  await check("actual settlement stays exact and idempotent; unknown usage is retained and excess usage is recorded without a spending pause", async () => {
    cachedFp = key(); cachedClaim = await claim("operating_catalog", cachedFp);
    await dispatch(cachedClaim, cachedFp);
    cachedEvaluation = { ok: true, provider_result: { model: "jev-1.13.0", answers: { fact: { type: "noul", noul: .87 } } }, usage: { inputTokens: 1000, outputTokens: 0 } };
    assert.equal(await record(cachedClaim, cachedFp, cachedEvaluation), true);
    assert.equal(await settle(cachedClaim, cachedFp), true);
    assert.equal(await settle(cachedClaim, cachedFp), true);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [cachedClaim.reservationId])), .000042);
    assert.equal(await scalar("select intelligence_settle($1,0,0)", [cachedClaim.reservationId]), false);
    const fp = key(), c = await claim("operating_catalog", fp); await dispatch(c, fp);
    assert.equal(await scalar("select intelligence_settle($1,null,null)", [c.reservationId]), true);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [c.reservationId])), reservation);
    assert.equal(await scalar("select input_tokens from intelligence_spend where id=$1", [c.reservationId]), null);
    const large = await claim();
    assert.equal(await scalar("select intelligence_settle($1,.0042,100000)", [large.reservationId]), true);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [large.reservationId])), .0042);
    assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"), true);
  });

  await check("429 does not trip the payment circuit or erase unknown acceptance", async () => {
    for (const error of [{ code: "typesafe_http_429", retryable: true }, { kind: "rate_limit", statusCode: 429, retryable: true }]) {
      const fp = key(), c = await claim("operating_catalog", fp); await dispatch(c, fp);
      assert.equal(await record(c, fp, { ok: false, error, usage: null }), true);
      assert.equal(await settle(c, fp), true);
      assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"), true);
      assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [c.reservationId])), reservation);
    }
  });

  await check("a durable dispatched402 stops every purpose and already-issued ticket while successful cache remains usable", async () => {
    for (const error of [{ code: "typesafe_http_402", retryable: false }, { kind: "billing", statusCode: 402, retryable: false }]) {
      await resume();
      const fp = key(), c = await claim("operating_catalog", fp); await dispatch(c, fp);
      const waitingFp = key(), waiting = await claim("federal_identity", waitingFp);
      assert.equal(await record(c, fp, { ok: false, error, usage: null }), true);
      assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"), false);
      assert.equal(await scalar("select halt_reason from intelligence_jev_budget_policy"), "provider_billing_unavailable");
      for (const purpose of purposes) assert.equal((await claim(purpose)).reason, "provider_billing_unavailable");
      assert.equal((await dispatch(waiting, waitingFp)).status, "budget_deferred");
      const before = await scalar("select count(*) from intelligence_spend");
      const reused = await claim("operating_catalog", cachedFp);
      assert.equal(reused.status, "complete"); assert.equal(reused.reused, true);
      assert.deepEqual(reused.evaluation, cachedEvaluation);
      assert.equal(reused.reservationId, cachedClaim.reservationId);
      assert.equal(await scalar("select count(*) from intelligence_spend"), before);
      assert.equal(await settle(c, fp), true);
      assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1", [c.reservationId])), reservation);
      assert.equal((await scalar("select intelligence_jev_budget_status()")).blockedReason, "provider_billing_unavailable");
    }
    await resume();
    const fp = key(), c = await claim("operating_catalog", fp);
    await record(c, fp, { ok: false, error: { code: "typesafe_http_402" }, usage: null });
    assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"), true, "unverified dispatch cannot trip circuit");
  });

  await check("permission boundaries and original financial history survive the entire run", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await scalar("select has_table_privilege($1,'intelligence_jev_budget_policy','UPDATE')", [role]), false);
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text)','EXECUTE')", [role]), false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_jev_reserve_fixed_allowance(uuid,text,uuid,uuid,text,text,text)','EXECUTE')"), false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_jev_fixed_allowance_status()','EXECUTE')"), false);
    assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(s) order by id) from intelligence_spend s where id=any($1::uuid[])", [[legacyId, unknownId]]), history);
  });
  console.log(`${passed} provider-balance SQL checks passed; real concurrent locking not tested.`);
} finally { await db.close(); }
