/** Local ephemeral PostgreSQL only. Reuses optional work/intelligence-sql-test PGlite.
 * This does not prove multi-connection locking or touch hosted Supabase.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create table public.companies(id uuid primary key,status text not null);
  create table public.trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),verdict text,promoted_trigger_id uuid);`);
await db.exec(await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8"));
await db.exec(await readFile(new URL("../../supabase/migrations/0060_intelligence_shared_sources.sql", import.meta.url), "utf8"));
const source = "wa_commerce";
const item = { item_key: "a".repeat(64), payload: { url: "https://www.commerce.wa.gov/news/company", title: "Company expands", text: "Source feed excerpt", eventDate: null } };
const claim = () => scalar("select intelligence_shared_claim($1)", [source]);
const snapshot = (lease, items = [item], error = null) => scalar("select intelligence_shared_snapshot($1,$2,$3,$4)", [source, lease, items, error]);
const save = (lease, payload = null, done = false, error = null) => scalar("select intelligence_shared_item($1,$2,$3,$4,$5,$6)", [source, lease, item.item_key, payload, done, error]);
const release = (lease) => scalar("select intelligence_shared_release($1,$2,null)", [source, lease]);

let checks = 0;
async function test(name, run) {
  await db.exec(`truncate intelligence_shared_items;
    update intelligence_config set enabled=true;
    update intelligence_shared_sources set lease_token=null,lease_until=null,next_fetch_at=now(),last_fetch_at=null,last_success_at=null,
      last_fetch_status=null,last_fetch_error=null,last_work_error=null,last_item_count=null;`);
  await run(); checks++; console.log(`PASS ${name}`);
}
try {
  assert.equal(await scalar("select enabled from intelligence_config"), false);
  assert.equal(await scalar("select count(*)::int from intelligence_shared_sources where enabled"), 3);
  await test("global disable and exclusive source lease", async () => {
    await db.exec("update intelligence_config set enabled=false");
    assert.equal(await claim(), null);
    await db.exec("update intelligence_config set enabled=true");
    const first = await claim();
    assert.ok(first.lease_token);
    assert.equal(await claim(), null);
    await db.query("update intelligence_shared_sources set lease_until=now()-interval '1 second' where id=$1", [source]);
    const replacement = await claim();
    assert.notEqual(replacement.lease_token, first.lease_token);
    await assert.rejects(snapshot(first.lease_token), /lease_lost/);
    await assert.rejects(release(first.lease_token), /lease_lost/);
    await snapshot(replacement.lease_token);
  });
  await test("atomic feed receipt, content dedupe, and empty-vs-error state", async () => {
    const { lease_token: lease } = await claim();
    await snapshot(lease);
    await snapshot(lease);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"), 1);
    await snapshot(lease, [], null);
    assert.equal(await scalar("select last_fetch_status from intelligence_shared_sources where id=$1", [source]), "empty");
    const success = await scalar("select last_success_at::text from intelligence_shared_sources where id=$1", [source]);
    await snapshot(lease, null, "feed_unavailable");
    assert.deepEqual(await row("select last_fetch_status,last_fetch_error,last_success_at::text from intelligence_shared_sources where id=$1", [source]),
      { last_fetch_status: "error", last_fetch_error: "feed_unavailable", last_success_at: success });
    const invalid = { ...item, item_key: "b".repeat(64), payload: null };
    await assert.rejects(snapshot(lease, [invalid]));
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"), 1);
  });
  await test("backlog survives release, body cache, and retry; completed text is removed", async () => {
    const { lease_token: lease } = await claim();
    await snapshot(lease);
    await save(lease, { ...item.payload, text: "Cached full article body", bodyFetched: true });
    await save(lease, null, false, "queue_unavailable");
    assert.deepEqual(await row("select complete,attempts,payload->>'text' as text from intelligence_shared_items"), { complete: false, attempts: 1, text: "Cached full article body" });
    await release(lease);
    assert.equal(await claim(), null); // item has future retry and feed is not yet due
    await db.exec("update intelligence_shared_items set next_attempt_at=now()");
    const next = await claim();
    await save(next.lease_token, null, true);
    assert.equal(await scalar("select payload ? 'text' from intelligence_shared_items"), false);
    assert.equal(await scalar("select complete from intelligence_shared_items"), true);
    await assert.rejects(save(next.lease_token, null, true), /missing_or_complete/);
  });
  await test("retention removes only old completed receipts and never pending evidence", async () => {
    const { lease_token: lease } = await claim();
    await snapshot(lease);
    await save(lease, null, true);
    await db.exec("update intelligence_shared_items set completed_at=now()-interval '31 days'");
    await snapshot(lease, [{ ...item, item_key: "b".repeat(64) }]);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"), 1);
    await db.exec("update intelligence_shared_items set created_at=now()-interval '100 days'");
    await snapshot(lease, []);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"), 1);
  });
  await test("intake byte budget fails atomically and leaves the feed retryable", async () => {
    const { lease_token: lease } = await claim();
    const large = Array.from({ length: 50 }, (_, i) => ({ item_key: i.toString(16).padStart(64, "0"), payload: { ...item.payload, text: "x".repeat(42000) } }));
    await assert.rejects(snapshot(lease, large), /storage_capacity_exceeded/);
    assert.equal(await scalar("select count(*)::int from intelligence_shared_items"), 0);
    assert.equal(await scalar("select last_fetch_status from intelligence_shared_sources where id=$1", [source]), null);
  });
  await test("anonymous and authenticated roles cannot read or call source workers", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from intelligence_shared_items"), /permission denied/);
      await assert.rejects(claim(), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.ok((await claim()).lease_token);
    await db.exec("reset role");
    await assert.rejects(snapshot(randomUUID()), /lease_lost/);
  });
  console.log(`${checks} shared-feed SQL regression checks passed`);
} finally { await db.close(); }
