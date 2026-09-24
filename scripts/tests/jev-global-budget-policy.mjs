/** Offline PostgreSQL semantics, no Supabase/provider access.
 * PGlite serializes connections: this does NOT prove real concurrent locking. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(new URL("../../work/intelligence-sql-test/package.json",import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0]??{})[0];
const migration = async name => db.exec(await readFile(new URL("../../supabase/migrations/"+name,import.meta.url),"utf8"));
let passed=0;
const check = async (name,run) => { await run(); passed++; console.log("PASS "+name); };
const key = () => randomUUID().replaceAll("-","").repeat(2);
const claim = (purpose="operating_catalog",fingerprint=key()) => scalar("select intelligence_jev_claim($1,$2,null,null,'catalog','initial_coverage')",[fingerprint,purpose]);
const dispatch = (c,fp,model="jev-1.13.0") => scalar("select intelligence_jev_dispatch($1,$2,$3,$4)",[fp,c.reservationId,c.leaseToken,model]);
const reserveAmount = .002753;
const policy = "jev-rollout-2026-09-24";
const clearEpoch = async () => {
  await db.exec("delete from intelligence_jev_requests where purpose<>'private_tam'; delete from intelligence_spend where jev_policy_id is not null;");
  await db.exec("update intelligence_jev_budget_policy set enabled=true,halt_reason=null,confirmed_available_usd=99.81,opening_liability_usd=0,legacy_reconciliation_status='reconciled',funding_confirmed_at=now(),funding_receipt='fixture funded-balance receipt',reconciliation_receipt='fixture audited legacy opening liability'");
};
const exposure = async (amount,phase,day,tokens=1,dispatched=true) => {
  const id=randomUUID();
  await db.query(`insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,input_tokens,state,jev_policy_id,jev_phase,jev_budget_day,jev_model,jev_max_input_tokens,jev_usd_per_million,dispatched_at)
    values($1,'2026-09-01','jev',$2,$2,$3,'settled',$4,$5,$6,'jev-1.13.0',65536,.042,case when $7 then '2026-09-24T20:00:00Z'::timestamptz else null end)`,[id,amount,tokens,policy,phase,day,dispatched]);
  return id;
};
try {
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create table companies(id uuid primary key,status text not null);create table trigger_candidates(id uuid primary key,created_at timestamptz,verdict text,promoted_trigger_id uuid);");
  for(const f of ["0059_intelligence_evidence_and_work.sql","0082_jev_request_receipts.sql","0090_native_jev_purposes.sql"])await migration(f);
  const legacyId=randomUUID();
  await db.query("insert into intelligence_spend(id,month,category,reserved_usd,charged_usd,state) values($1,'2026-09-01','jev',119.678,119.678,'settled')",[legacyId]);
  // Model a historical deployment whose stored enum admitted private receipts.
  // The migration must preserve them even though current API admission excludes them.
  await db.exec("alter table intelligence_jev_requests drop constraint intelligence_jev_requests_purpose_check");
  const legacyPrivateFingerprint=key();
  await db.query(`insert into intelligence_jev_requests(fingerprint,purpose,workload,state,reservation_id,lease_token,lease_until,evaluation,completed_at)
    values($1,'private_tam','manual','complete',$2,$3,now(),'{"ok":false,"usage":null}',now())`,[legacyPrivateFingerprint,legacyId,randomUUID()]);
  await db.exec("alter table intelligence_jev_requests add constraint intelligence_jev_requests_purpose_check check(purpose in ('public_interpretation','research_ranking','saved_view','private_tam','federal_identity','event_match','codex_connector'))");
  const originalPrivateReceipt=await scalar("select to_jsonb(r) from intelligence_jev_requests r where fingerprint=$1",[legacyPrivateFingerprint]);
  await migration("0117_jev_global_budget_policy.sql");
  // Freeze only this disposable test database's function clocks. No clock
  // override or caller-controlled time is shipped in the migration.
  const functions=["intelligence_jev_reserve_policy","intelligence_jev_dispatch","intelligence_jev_claim","intelligence_settle","intelligence_jev_budget_status"];
  const defs=await db.query("select proname,pg_get_functiondef(oid) as definition from pg_proc where pronamespace='public'::regnamespace and proname=any($1)",[functions]);
  const at=async iso=>{for(const row of defs.rows)await db.exec(row.definition.replaceAll("clock_timestamp()","'"+iso+"'::timestamptz"));};
  await at("2026-09-24T20:00:00Z");
  await db.exec("update intelligence_config set enabled=true");
  await check("migration preserves the exact historical private receipt while new private admission remains closed",async()=>{
    assert.deepEqual(await scalar("select to_jsonb(r) from intelligence_jev_requests r where fingerprint=$1",[legacyPrivateFingerprint]),originalPrivateReceipt);
    await assert.rejects(claim("private_tam",legacyPrivateFingerprint),/Invalid cache request/);
    await assert.rejects(claim("private_tam"),/Invalid cache request/);
    await assert.rejects(scalar("select intelligence_reserve_jev($1,.002753,'private_tam',null,null,'tam',$2,'manual')",[randomUUID(),key()]),/Invalid Jev policy attribution/);
  });
  await check("installation is closed and old unknown outage holds remain untouched",async()=>{
    assert.equal((await claim()).reason,"policy_disabled");
    assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),false);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[legacyId])),119.678);
    assert.equal(Number(await scalar("select legacy_snapshot->>'unknownOrInFlightReservedUsd' from intelligence_jev_budget_policy")),119.678);
    assert.equal(await scalar("select intelligence_reserve($1,'jev',.002753)",[randomUUID()]),false);
    assert.equal(await scalar("select intelligence_reserve($1,'generation',.03)",[randomUUID()]),false);
  });
  await check("enabling alone cannot spend before funded-balance and legacy reconciliation receipts",async()=>{
    await db.exec("update intelligence_jev_budget_policy set enabled=true");
    assert.equal((await claim()).reason,"funding_or_reconciliation_required");
    const closed=await scalar("select intelligence_jev_budget_status()");
    assert.equal(closed.enabled,false);assert.equal(closed.blockedReason,"funding_or_reconciliation_required");
    await clearEpoch();
    assert.equal((await claim()).status,"execute");
    assert.equal(Number((await scalar("select intelligence_jev_budget_status()")).initialMaxUsd),69.81);
  });
  await check("initial admission is catalog-only and private TAM is rejected",async()=>{
    await clearEpoch();
    for(const purpose of ["public_interpretation","research_ranking","saved_view","federal_identity","event_match","codex_connector"]){
      const d=await claim(purpose);assert.equal(d.reason,"purpose_not_admitted");assert.equal(Date.parse(d.retryAt),Date.parse("2026-09-25T07:00:00Z"));
    }
    await assert.rejects(claim("private_tam"),/Invalid cache request/);
    assert.equal((await scalar("select intelligence_jev_claim($1,'research_ranking',null,null,'catalog_research_options','initial_coverage')",[key()])).status,"execute");
    await assert.rejects(scalar("select intelligence_reserve_jev($1,.002753,'private_tam',null,null,'tam',$2,'manual')",[randomUUID(),key()]),/Invalid Jev policy attribution/);
    assert.equal(await scalar("select intelligence_reserve_jev($1,.000001,'operating_catalog',null,null,'catalog',$2,'manual')",[randomUUID(),key()]),false);
  });
  await check("69.81 cap includes reservations, protects30, and subtracts real new opening liability only",async()=>{
    await clearEpoch();await exposure(69.808,"initial","2026-09-24");
    assert.equal((await claim()).reason,"initial_allowance_exhausted");
    await clearEpoch();await db.exec("update intelligence_jev_budget_policy set opening_liability_usd=1");
    await exposure(68.808,"initial","2026-09-24");assert.equal((await claim()).reason,"initial_allowance_exhausted");
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[legacyId])),119.678);
  });
  await check("dispatch is one-use, model-bound, lease-bound and pause-aware",async()=>{
    await clearEpoch();const fp=key(),c=await claim("operating_catalog",fp);
    assert.equal((await dispatch(c,fp,"jev-1.14.0")).status,"budget_deferred");
    assert.equal((await dispatch(c,fp)).status,"authorized");
    assert.equal((await dispatch(c,fp)).status,"budget_deferred");
    const fp2=key(),c2=await claim("operating_catalog",fp2);
    await db.exec("update intelligence_jev_budget_policy set enabled=false");
    assert.equal((await dispatch(c2,fp2)).reason,"policy_disabled");
  });
  await check("known usage releases headroom once; unknown usage remains fully charged",async()=>{
    await clearEpoch();const fp=key(),c=await claim("operating_catalog",fp);await dispatch(c,fp);
    assert.equal(await scalar("select intelligence_settle($1,.000042,1000)",[c.reservationId]),true);
    assert.equal(await scalar("select intelligence_settle($1,0,0)",[c.reservationId]),false);
    const fp2=key(),c2=await claim("operating_catalog",fp2);await dispatch(c2,fp2);
    await scalar("select intelligence_settle($1,null,null)",[c2.reservationId]);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[c2.reservationId])),reserveAmount);
  });
  await check("uncertain expired attempts retain spend; never-authorized attempts refund before separately reserved recovery",async()=>{
    await clearEpoch();const fp=key(),old=await claim("operating_catalog",fp);await dispatch(old,fp);
    await db.query("update intelligence_jev_requests set lease_until='2020-01-01' where fingerprint=$1",[fp]);
    const recovered=await claim("operating_catalog",fp);assert.notEqual(recovered.reservationId,old.reservationId);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[old.reservationId])),reserveAmount);
    const fp2=key(),old2=await claim("operating_catalog",fp2);
    await db.query("update intelligence_jev_requests set lease_until='2020-01-01' where fingerprint=$1",[fp2]);
    await claim("operating_catalog",fp2);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[old2.reservationId])),0);
  });
  await check("Pacific midnight expires initial tickets and admits all purposes into one50c daily cap",async()=>{
    await clearEpoch();await at("2026-09-25T06:59:59Z");const fp=key(),c=await claim("operating_catalog",fp);
    await at("2026-09-25T07:00:00Z");assert.equal((await dispatch(c,fp)).reason,"invalid_or_expired_dispatch_ticket");
    await clearEpoch();
    for(const purpose of ["operating_catalog","public_interpretation","research_ranking","saved_view","federal_identity","event_match","codex_connector"])assert.equal((await claim(purpose)).status,"execute");
    await exposure(.48,"maintenance","2026-09-25");
    const d=await claim();assert.equal(d.reason,"daily_allowance_exhausted");assert.equal(Date.parse(d.retryAt),Date.parse("2026-09-26T07:00:00Z"));
  });
  await check("aggregate30 spans months; exhausted aggregate and expiry never auto-renew",async()=>{
    await clearEpoch();await at("2026-11-01T20:00:00Z");await exposure(29.999,"maintenance","2026-10-15");
    const d=await claim();assert.equal(d.reason,"maintenance_allowance_exhausted");assert.equal(d.retryAt,null);
    await clearEpoch();await at("2026-11-24T07:59:59Z");assert.equal((await claim()).status,"execute");
    await at("2026-11-24T08:00:00Z");assert.equal((await claim()).reason,"policy_term_exhausted");
    assert.equal(await scalar("select (maintenance_expires_at at time zone timezone)::date-(initial_expires_at at time zone timezone)::date from intelligence_jev_budget_policy"),60);
  });
  await check("DST reset isPacificmidnight, and prior unresolved acceptance carries into the nextday",async()=>{
    await clearEpoch();await at("2026-11-01T08:00:00Z");await exposure(.499,"maintenance","2026-11-01");
    assert.equal(Date.parse((await claim()).retryAt),Date.parse("2026-11-02T08:00:00Z"));
    await clearEpoch();await at("2026-09-26T08:00:00Z");await exposure(.499,"maintenance","2026-09-25",null);
    assert.equal((await claim()).reason,"daily_allowance_exhausted");
    assert.equal(Number((await scalar("select intelligence_jev_budget_status()")).carriedUnknownUsd),.499);
  });
  await check("provider bound breach records the real charge and closes all further dispatch",async()=>{
    await clearEpoch();await at("2026-09-24T20:00:00Z");const c=await claim();
    await scalar("select intelligence_settle($1,.0042,100000)",[c.reservationId]);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[c.reservationId])),.0042);
    assert.equal(await scalar("select halt_reason from intelligence_jev_budget_policy"),"provider_cost_ceiling_breached");
    assert.equal((await claim()).reason,"policy_disabled");
  });
  await check("recorded billing/authentication failure atomically stops all dispatch and retains unknown usage",async()=>{
    for(const error of [{kind:"billing"},{kind:"authentication"},{code:"typesafe_http_402"},{code:"typesafe_http_401"},{code:"typesafe_http_403"}]){
      await clearEpoch();const fp=key(),c=await claim("operating_catalog",fp);await dispatch(c,fp);
      const pendingFp=key(),pending=await claim("operating_catalog",pendingFp);
      assert.equal(await scalar("select intelligence_jev_record($1,$2,$3,$4)",[fp,c.leaseToken,c.reservationId,{ok:false,error,usage:null}]),true);
      assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),false);
      assert.match(await scalar("select halt_reason from intelligence_jev_budget_policy"),/^provider_(billing|authentication)_unavailable$/);
      assert.equal((await dispatch(pending,pendingFp)).reason,"policy_disabled");
      assert.equal((await claim()).reason,"policy_disabled");
      await scalar("select intelligence_jev_settle($1,$2)",[fp,c.reservationId]);
      assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[c.reservationId])),reserveAmount);
    }
    await clearEpoch();const fp=key(),c=await claim("operating_catalog",fp);
    assert.equal(await scalar("select intelligence_jev_record($1,$2,$3,$4)",[fp,c.leaseToken,c.reservationId,{ok:false,error:{kind:"billing"},usage:null}]),true);
    assert.equal(await scalar("select enabled from intelligence_jev_budget_policy"),true); // No verified dispatch: cannot trip provider circuit.
  });
  await check("anonymous clients cannot reserve or change policy; legacy bypass is not service-callable",async()=>{
    for(const role of ["anon","authenticated"]){
      assert.equal(await scalar("select has_table_privilege($1,'intelligence_jev_budget_policy','UPDATE')",[role]),false);
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_jev_reserve_policy(uuid,text,uuid,uuid,text,text,text)','EXECUTE')",[role]),false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_reserve_before_global_jev_budget(uuid,text,numeric)','EXECUTE')"),false);
  });
  console.log(passed+" global Jev budget SQL checks passed; real multi-connection concurrency not tested.");
} finally { await db.close(); }
