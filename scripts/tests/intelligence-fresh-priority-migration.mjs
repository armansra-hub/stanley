/** Execute the actual queue migrations in local PostgreSQL; no network/model calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const company=randomUUID(), observation=randomUUID();
let passed=0;
async function test(name,run){ await run(); passed++; console.log(`PASS ${name}`); }
const replayResult={routingBackfill:"business-services-v1",parts:[{start:0,end:8,evaluation:{questionVersion:"stanley-evidence-v2",metadata:{rawAnswers:{companyRelevance:{type:"noul",noul:.87}}}}}]};
async function add(name,priority,minutes,result=null,extra={}) {
  const id=randomUUID();
  await db.query(`insert into intelligence_jobs(id,operation_key,observation_id,kind,priority,due_at,result,status,attempts,lease_token,lease_until)
    values($1,$2,$3,'interpret',$4,now()-make_interval(mins=>$5),$6,$7,$8,$9,$10)`,
    [id,name,observation,priority,minutes,result,extra.status??"queued",extra.attempts??0,extra.lease_token??null,extra.lease_until??null]);
  return id;
}
const claim=async n=>(await db.query("select * from intelligence_claim($1)",[n])).rows;
try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table companies(id uuid primary key,status text);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);`);
  for(const file of ["0059_intelligence_evidence_and_work.sql","0075_fresh_intelligence_priority.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));
  await db.exec("update intelligence_config set enabled=true");
  await db.query("insert into companies values($1,'new')",[company]);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash)
    values($1,$2,'source','website','https://company.com/','Public source','Evidence','hash')`,[observation,company]);
  const oldest=await add("oldest-replay",30,10,replayResult);
  const otherReplay=await add("high-priority-replay",30,9,replayResult);
  const anotherReplay=await add("other-replay",30,8,replayResult);
  const freshA=await add("fresh-a",10,2),freshB=await add("fresh-b",10,1);
  let first;
  await test("two newer priority10 jobs beat priority30 replay while the oldest replay still progresses",async()=>{
    first=await claim(3);
    assert.deepEqual(new Set(first.map(j=>j.id)),new Set([oldest,freshA,freshB]));
    assert.deepEqual(first.find(j=>j.id===oldest).result,replayResult);
    assert.ok(first.every(j=>j.status==="running"&&j.attempts===1&&j.lease_token));
  });
  await test("overlapping claims cannot reuse live leases and remaining slots drain replay when fresh work is absent",async()=>{
    const next=await claim(3);
    assert.deepEqual(new Set(next.map(j=>j.id)),new Set([otherReplay,anotherReplay]));
    assert.ok(next.every(j=>!first.some(old=>old.id===j.id)));
    assert.equal((await claim(3)).length,0);
    assert.equal(new Set([...first,...next].map(j=>j.lease_token)).size,5);
  });
  await test("expired work obtains a new lease and rejects the old owner's completion",async()=>{
    const original=first.find(j=>j.id===oldest);
    await db.query("update intelligence_jobs set lease_until=now()-interval '1 second' where id=$1",[oldest]);
    const [retry]=await claim(3);
    assert.equal(retry.id,oldest);assert.notEqual(retry.lease_token,original.lease_token);
    assert.equal(retry.attempts,2);assert.deepEqual(retry.result,replayResult);
    assert.equal(await scalar("select intelligence_finish($1,$2,'queued',$3)",[oldest,original.lease_token,replayResult]),false);
    assert.equal(await scalar("select lease_token from intelligence_jobs where id=$1",[oldest]),retry.lease_token);
  });
  await test("future work, exhausted attempts and disabled processing remain excluded",async()=>{
    const future=await add("future",30,-20),exhausted=await add("exhausted",30,20,replayResult,{attempts:5});
    assert.equal((await claim(3)).length,0);
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[future]),"queued");
    assert.equal(await scalar("select status from intelligence_jobs where id=$1",[exhausted]),"failed");
    await add("due-but-disabled",30,1);
    await db.exec("update intelligence_config set enabled=false");
    assert.equal((await claim(3)).length,0);
    assert.equal(await scalar("select has_function_privilege('anon','intelligence_claim(integer)','EXECUTE')"),false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_claim(integer)','EXECUTE')"),true);
  });
  console.log(`${passed} PostgreSQL tests passed`);
} finally { await db.close(); }
