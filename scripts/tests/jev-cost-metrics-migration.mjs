/** Offline real PostgreSQL cost/accounting checks; no provider calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const account = randomUUID();
async function receipt(key, purpose, source, workload, tokens, complete = true) {
  const fingerprint = key.repeat(64);
  const claim = await scalar("select intelligence_jev_claim($1,$2,$3,null,$4,$5)", [fingerprint, purpose, account, source, workload]);
  assert.equal(claim.status, "execute");
  if (complete) {
    const evaluation = { ok: tokens !== null, usage: tokens === null ? null : { inputTokens: tokens, outputTokens: 3 } };
    assert.equal(await scalar("select intelligence_jev_record($1,$2,$3,$4)", [fingerprint, claim.leaseToken, claim.reservationId, evaluation]), true);
    assert.equal(await scalar("select intelligence_jev_settle($1,$2)", [fingerprint, claim.reservationId]), true);
  }
  return { ...claim, fingerprint };
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null);
    create table trigger_candidates(id uuid primary key,created_at timestamptz,verdict text,promoted_trigger_id uuid);`);
  for (const file of ["0059_intelligence_evidence_and_work.sql", "0082_jev_request_receipts.sql", "0083_intelligence_jev_cost_metrics.sql", "0106_jev_recent_cost_window.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
  }
  await db.exec("update intelligence_config set enabled=true");
  await test("empty ledger is measured zero, with no invented attribution", async () => {
    const metrics = await scalar("select intelligence_jev_cost_metrics()");
    assert.equal(metrics.month.totals.requests, 0);
    assert.equal(metrics.last24h.totals.reportedInputTokens, 0);
    assert.equal(metrics.last1h.totals.reportedInputTokens, 0);
    assert.deepEqual(metrics.month.byActivity, []);
    assert.equal(metrics.attributionStartedAt, null);
  });
  const website = await receipt("a", "public_interpretation", "website", "initial_coverage", 2000);
  await receipt("b", "public_interpretation", "news", "monitoring", 3500);
  await receipt("c", "research_ranking", "website", "monitoring", null);
  await receipt("d", "saved_view", "news", "manual", null, false);
  const privateId = randomUUID(), historyId = randomUUID(), generationId = randomUUID();
  await scalar("select intelligence_reserve_jev($1,.002753,'private_tam',$2,null,null,null,'manual')", [privateId, account]);
  await scalar("select intelligence_settle($1,.000252,6000)", [privateId]);
  await scalar("select intelligence_reserve($1,'jev',.002753)", [historyId]);
  await scalar("select intelligence_settle($1,.000042,1000)", [historyId]);
  await scalar("select intelligence_reserve($1,'generation',.03)", [generationId]);
  await scalar("select intelligence_settle($1,.01,77)", [generationId]);

  await test("reports actual known tokens separately from unknown and in-progress allowances", async () => {
    const metrics = await scalar("select intelligence_jev_cost_metrics()");
    const expected = { requests: 6, knownUsageRequests: 4, reportedInputTokens: 12500, estimatedUsd: .000525,
      unknownUsageRequests: 1, unknownUsageReserveUsd: .002753, inFlightRequests: 1, inFlightReserveUsd: .002753 };
    assert.deepEqual(metrics.month.totals, expected);
    assert.deepEqual(metrics.last24h.totals, expected);
    assert.deepEqual(metrics.last1h.totals, expected);
    assert.equal(metrics.usdPerMillionInputTokens, .042);
    assert.ok(metrics.attributionStartedAt);
  });
  await test("activity and workload breakdowns reconcile without inferring historical attribution", async () => {
    const metrics = await scalar("select intelligence_jev_cost_metrics()");
    for (const dimension of ["byPurpose", "byActivity", "byWorkload"]) {
      assert.equal(metrics.month[dimension].reduce((sum, row) => sum + row.requests, 0), 6);
      assert.equal(metrics.month[dimension].reduce((sum, row) => sum + row.reportedInputTokens, 0), 12500);
    }
    assert.equal(metrics.month.byActivity.find(row => row.key === "website_research").reportedInputTokens, 2000);
    assert.equal(metrics.month.byActivity.find(row => row.key === "news_research").reportedInputTokens, 3500);
    assert.equal(metrics.month.byActivity.find(row => row.key === "private_tam").reportedInputTokens, 6000);
    assert.equal(metrics.month.byPurpose.find(row => row.key === "historical_unattributed").reportedInputTokens, 1000);
    assert.equal(metrics.month.byWorkload.find(row => row.key === "historical_unattributed").reportedInputTokens, 1000);
    assert.equal(metrics.month.byWorkload.find(row => row.key === "initial_coverage").requests, 1);
    assert.equal(metrics.month.byWorkload.find(row => row.key === "monitoring").requests, 2);
  });
  await test("cached reuse and repeated settlement never add a second charged request", async () => {
    const before = await scalar("select intelligence_jev_cost_metrics()");
    const cached = await scalar("select intelligence_jev_claim($1,'public_interpretation',$2,null,'website','monitoring')", [website.fingerprint, account]);
    assert.equal(cached.status, "complete");
    assert.equal(cached.reservationId, website.reservationId);
    await scalar("select intelligence_jev_settle($1,$2)", [website.fingerprint, website.reservationId]);
    await scalar("select intelligence_jev_settle($1,$2)", [website.fingerprint, website.reservationId]);
    const after = await scalar("select intelligence_jev_cost_metrics()");
    assert.deepEqual(after.month, before.month);
    assert.deepEqual(after.last24h, before.last24h);
  });
  await test("out-of-window and generation spending cannot leak into Jev totals", async () => {
    const oldId = randomUUID();
    await db.query(`insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,input_tokens,state,created_at,settled_at)
      select $1,date_trunc('month',old_at at time zone 'UTC')::date,'jev',.002753,1,999999,'settled',old_at,old_at
      from (select least(date_trunc('month',now() at time zone 'UTC') at time zone 'UTC',now()-interval '24 hours')-interval '1 day' old_at) dates`, [oldId]);
    const metrics = await scalar("select intelligence_jev_cost_metrics()");
    assert.equal(metrics.month.totals.requests, 6);
    assert.equal(metrics.last24h.totals.requests, 6);
    assert.equal(metrics.month.totals.reportedInputTokens, 12500);
  });
  await test("only the service role can read aggregate costs", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_jev_cost_metrics()','EXECUTE')", [role]), false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_jev_cost_metrics()','EXECUTE')"), true);
  });
  await test("current hourly spending excludes earlier work without changing history or unknown charges", async () => {
    await db.query("update intelligence_spend set created_at=now()-interval '2 hours' where id=$1", [website.reservationId]);
    const metrics = await scalar("select intelligence_jev_cost_metrics()");
    assert.equal(metrics.last24h.totals.requests, 6);
    assert.equal(metrics.last24h.totals.reportedInputTokens, 12500);
    assert.equal(metrics.last1h.totals.requests, 5);
    assert.equal(metrics.last1h.totals.reportedInputTokens, 10500);
    assert.equal(metrics.last1h.totals.estimatedUsd, .000441);
    assert.equal(metrics.last1h.totals.unknownUsageRequests, 1);
    assert.equal(metrics.last1h.totals.inFlightRequests, 1);
    assert.ok(!metrics.last1h.byActivity.some(row => row.key === 'website_research'));
  });
  console.log(`${passed} Jev cost metrics SQL tests passed`);
} finally { await db.close(); }
