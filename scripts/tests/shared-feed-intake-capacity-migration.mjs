/** Ephemeral local PostgreSQL only; never connects to hosted Supabase. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const source = "wa_commerce";
const item = { item_key: "a".repeat(64), payload: { url: "https://www.commerce.wa.gov/news/company", title: "Company expands", text: "Original excerpt", eventDate: null } };
const snapshot = (lease, items = [item]) => db.query("select intelligence_shared_snapshot($1,$2,$3,null)", [source, lease, items]);
let passed = 0;
const seed = async (rows, textLength, bodyFetched, complete = false, sourceId = "gsa_news") => db.query(`
  insert into intelligence_shared_items(source_id,item_key,payload,complete,completed_at)
  select $1,lpad(to_hex(n),64,'0'),jsonb_build_object('url','https://example.com/'||n,'text',repeat('x',$3),'bodyFetched',$4::boolean),
    $5::boolean,case when $5::boolean then now()-interval '90 days' else null end from generate_series(1,$2::integer) n`,
  [sourceId, rows, textLength, bodyFetched, complete]);
const fingerprint = () => scalar("select md5(coalesce(string_agg(source_id||item_key||payload::text||complete::text,'' order by source_id,item_key),'')) from intelligence_shared_items");
async function test(name, fn) {
  await db.exec(`truncate intelligence_shared_items;
    update intelligence_shared_sources set lease_token=null,lease_until=null,next_fetch_at=now(),last_success_at=null,last_fetch_error=null,last_fetch_status=null;`);
  const lease = await scalar("select intelligence_shared_claim($1)", [source]);
  await fn(lease.lease_token); passed++; console.log(`PASS ${name}`);
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table intelligence_config(id integer primary key,enabled boolean); insert into intelligence_config values(1,true);`);
  for (const migration of ["0060_intelligence_shared_sources.sql","0084_conditional_source_fetch.sql","0122_shared_feed_intake_capacity.sql"]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
  await test("article bodies above 2 MB no longer starve another feed; every prior payload remains exact", async lease => {
    await seed(55,40000,true);
    const before = (await db.query("select source_id,item_key,payload,complete from intelligence_shared_items order by item_key")).rows;
    await snapshot(lease);
    await snapshot(lease); // exact dedupe still holds
    const after = (await db.query("select source_id,item_key,payload,complete from intelligence_shared_items where source_id='gsa_news' order by item_key")).rows;
    assert.deepEqual(after,before);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"),56);
    assert.equal(await scalar("select last_fetch_status from intelligence_shared_sources where id=$1",[source]),"success");
  });
  await test("completed receipts do not consume excerpt intake and are never deleted by a snapshot", async lease => {
    await seed(55,40000,false,true,source);
    const before = (await db.query("select item_key,payload,completed_at from intelligence_shared_items order by item_key")).rows;
    await snapshot(lease);
    assert.deepEqual((await db.query("select item_key,payload,completed_at from intelligence_shared_items where complete order by item_key")).rows,before);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"),56);
  });
  await test("uncached excerpt intake remains capped at 2 MB and rejected snapshots are atomic", async lease => {
    await seed(49,40000,false);
    const before = await fingerprint();
    await assert.rejects(snapshot(lease,[{...item,payload:{...item.payload,text:"x".repeat(50000)}}]),/storage_capacity_exceeded/);
    assert.equal(await fingerprint(),before);
    assert.equal(await scalar("select last_fetch_status from intelligence_shared_sources where id=$1",[source]),null);
  });
  await test("combined storage still cannot exceed the existing 8 MB ceiling", async lease => {
    await seed(199,40000,true);
    const before = await fingerprint();
    await assert.rejects(snapshot(lease,[{...item,payload:{...item.payload,text:"x".repeat(50000)}}]),/storage_capacity_exceeded/);
    assert.equal(await fingerprint(),before);
    // A readback of an unchanged/empty feed does not add storage and remains valid.
    await snapshot(lease,[]);
    assert.equal(await fingerprint(),before);
  });
  await test("exclusive leases, per-source rows and role restrictions remain enforced", async lease => {
    await assert.rejects(snapshot(randomUUID()),/lease_lost/);
    await seed(5000,1,false,false,source);
    await assert.rejects(snapshot(lease),/source_capacity_exceeded/);
    for (const role of ["anon","authenticated"]) {
      assert.equal(await scalar("select has_function_privilege($1,'intelligence_shared_snapshot(text,uuid,jsonb,text)','EXECUTE')",[role]),false);
    }
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_shared_snapshot(text,uuid,jsonb,text)','EXECUTE')"),true);
  });
  console.log(`${passed} shared-feed intake SQL regression checks passed`);
} finally { await db.close(); }
