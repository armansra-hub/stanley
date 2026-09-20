/** Offline real-SQL checks; no Supabase or paid Jev connection. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params=[]) => Object.values((await db.query(sql,params)).rows[0])[0];
let passed=0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const account = randomUUID(), key = "a".repeat(64);
const result = { ok:true,usage:{inputTokens:2000,outputTokens:5},model:"jev-test",questionVersion:"v3",metadata:{rawAnswers:{role:{choice:"subject"}}} };
const claim = (fingerprint=key,company=account) => scalar("select intelligence_jev_claim($1,'public_interpretation',$2,null,'website','initial_coverage')",[fingerprint,company]);
const record = (c,fingerprint=key,evaluation=result) => scalar("select intelligence_jev_record($1,$2,$3,$4)",[fingerprint,c.leaseToken,c.reservationId,evaluation]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text not null);
    create table trigger_candidates(id uuid primary key,created_at timestamptz,verdict text,promoted_trigger_id uuid);`);
  await db.exec(await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql",import.meta.url),"utf8"));
  const originalReserve = await scalar("select prosrc from pg_proc where oid='intelligence_reserve(uuid,text,numeric)'::regprocedure");
  await db.exec(await readFile(new URL("../../supabase/migrations/0082_jev_request_receipts.sql",import.meta.url),"utf8"));
  await db.exec("update intelligence_config set enabled=true");
  await test("preserves the existing reservation implementation and saves task attribution atomically",async()=>{
    assert.equal(await scalar("select prosrc from pg_proc where oid='intelligence_reserve(uuid,text,numeric)'::regprocedure"),originalReserve);
    const c=await claim(); assert.equal(c.status,"execute");
    const s=(await db.query("select purpose,company_id,source_kind,workload from intelligence_spend where id=$1",[c.reservationId])).rows[0];
    assert.deepEqual(s,{purpose:"public_interpretation",company_id:account,source_kind:"website",workload:"initial_coverage"});
    assert.equal((await claim()).status,"busy");
    assert.equal(await scalar("select count(*)::int from intelligence_spend"),1);
    assert.equal(await record(c),true);
    assert.equal(await record(c),true);
  });
  await test("received answer survives a bookkeeping failure, then settles exactly once",async()=>{
    const settleDefinition=await scalar("select pg_get_functiondef('intelligence_settle(uuid,numeric,bigint)'::regprocedure)");
    await db.exec("create or replace function intelligence_settle(p_id uuid,p_actual numeric,p_tokens bigint default null) returns boolean language plpgsql as $$ begin raise exception 'temporary accounting failure'; end $$");
    const cached=await claim(); assert.deepEqual(cached.evaluation,result);
    await assert.rejects(db.query("select intelligence_jev_settle($1,$2)",[key,cached.reservationId]),/temporary accounting failure/);
    assert.deepEqual((await claim()).evaluation,result);
    await db.exec(settleDefinition);
    assert.equal(await scalar("select intelligence_jev_settle($1,$2)",[key,cached.reservationId]),true);
    assert.equal(await scalar("select intelligence_jev_settle($1,$2)",[key,cached.reservationId]),true);
    assert.equal(Number(await scalar("select charged_usd from intelligence_spend where id=$1",[cached.reservationId])),0.000084);
    assert.equal(await scalar("select count(*)::int from intelligence_spend"),1);
  });
  await test("account scope differs and old leases cannot overwrite a new attempt",async()=>{
    await assert.rejects(claim(key,randomUUID()),/scope mismatch/);
    const k="b".repeat(64), old=await claim(k);
    await db.query("update intelligence_jev_requests set lease_until=now()-interval '1 second' where fingerprint=$1",[k]);
    const next=await claim(k); assert.equal(next.status,"execute");
    assert.notEqual(next.reservationId,old.reservationId);
    assert.equal(await record(old,k),false);
    assert.equal(await record(next,k),true);
    const uncertain=(await db.query("select input_tokens,charged_usd,reserved_usd,state from intelligence_spend where id=$1",[old.reservationId])).rows[0];
    assert.equal(uncertain.input_tokens,null); assert.equal(uncertain.charged_usd,uncertain.reserved_usd); assert.equal(uncertain.state,"settled");
  });
  await test("budget deferral never creates a receipt and private snippets cannot enter this cache",async()=>{
    await db.exec("update intelligence_config set jev_limit_usd=0");
    assert.equal((await claim("c".repeat(64))).status,"budget_deferred");
    assert.equal(await scalar("select count(*)::int from intelligence_jev_requests where fingerprint=$1",["c".repeat(64)]),0);
    await assert.rejects(db.query("select intelligence_jev_claim($1,'private_tam')",["d".repeat(64)]),/Invalid cache request/);
  });
  await test("only service role can access cached native answers",async()=>{
    for(const role of ["anon","authenticated"]){
      assert.equal(await scalar("select has_table_privilege($1,'intelligence_jev_requests','SELECT')",[role]),false);
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_jev_claim(text,text,uuid,uuid,text,text)','EXECUTE')",[role]),false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_jev_claim(text,text,uuid,uuid,text,text)','EXECUTE')"),true);
  });
  console.log(`${passed} Jev receipt SQL tests passed`);
} finally { await db.close(); }
