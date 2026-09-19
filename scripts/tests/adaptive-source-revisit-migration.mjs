import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
let passed = 0;
async function test(name, run) {
  await db.exec("delete from intelligence_source_state; delete from companies; update intelligence_config set enabled=true");
  await run(); passed++; console.log(`PASS ${name}`);
}
async function account(name, checkedHours = 2, { source = "ats", complete = true, interval = 1, successHours = checkedHours, error = null, stateKey, state = true } = {}) {
  const id = randomUUID();
  await db.query(`insert into companies(id,name,status,lists,domain,ats_type,ats_token,ats_checked_at,site_checked_at)
    values($1,$2,'new','{netsuite_tam}','example.test','lever','example',
    case when $3::int is null then null else clock_timestamp()-make_interval(hours=>$3) end,
    case when $3::int is null then null else clock_timestamp()-make_interval(hours=>$3) end)`, [id, name, checkedHours]);
  if (state) await db.query(`insert into intelligence_source_state(company_id,source_key,complete,cursor,last_success_at,last_error)
    values($1,$2,$3,$4,clock_timestamp()-make_interval(hours=>$5),$6)`, [id, stateKey ?? (source === "ats" ? "ats:lever:example" : "website"), complete, { revisit: { version: 1, intervalHours: interval } }, successHours ?? 0, error]);
  return id;
}
const claim = async (source, limit = 12, epoch = "date_trunc('hour',clock_timestamp())") => (await db.query(
  `select name from reserve_company_rotation($1,$2,${epoch},$3)`, [source, limit, source === "site" ? "claimable" : null])).rows.map(row => row.name);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table companies(id uuid primary key,name text,status text,lists text[],domain text,website_raw text,
      ats_type text,ats_token text,ats_checked_at timestamptz,site_checked_at timestamptz,last_checked_at timestamptz,
      signals_checked_at timestamptz,fmcsa_checked_at timestamptz,sos_checked_at timestamptz,
      subindustry text,state text,is_base boolean,claimable boolean);
    create table intelligence_config(id int primary key,enabled boolean); insert into intelligence_config values(1,true);
    create table intelligence_source_state(company_id uuid,source_key text,complete boolean,cursor jsonb,last_success_at timestamptz,last_error text,primary key(company_id,source_key));`);
  const previous = await readFile(new URL("../../supabase/migrations/0056_tam_website_rotation.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../supabase/migrations/0069_adaptive_source_revisit.sql", import.meta.url), "utf8");
  await db.exec(previous); await db.exec(migration);
  for (const source of ["ats", "site"]) {
    await test(`${source}: changed and never-checked work proceeds while quiet accounts rejoin oldest-first when due`, async () => {
      await account("quiet-not-due", 2, { source, interval: 24 });
      await account("changed-due", 2, { source });
      await account("quiet-due", 26, { source, interval: 24 });
      await account("never-checked", null, { source, state: false });
      assert.deepEqual(await claim(source, 2), ["never-checked", "quiet-due"]);
      assert.deepEqual(await claim(source, 2), ["changed-due"]);
      assert.deepEqual(await claim(source), []);
    });
    await test(`${source}: incomplete, failed and malformed histories cannot impose quiet backoff`, async () => {
      await account("partial", 4, { source, complete: false, interval: 24, successHours: 0 });
      await account("failed", 3, { source, error: "fetch unavailable", interval: 24, successHours: 0 });
      await account("malformed", 2, { source, interval: 999 });
      assert.deepEqual(await claim(source), ["partial", "failed", "malformed"]);
    });
    await test(`${source}: runtime disable restores existing hourly eligibility`, async () => {
      await account("quiet", 2, { source, interval: 24 });
      assert.deepEqual(await claim(source), []);
      await db.exec("update intelligence_config set enabled=false");
      assert.deepEqual(await claim(source), ["quiet"]);
    });
    await test(`${source}: a just-reserved row cannot reenter across an hourly boundary`, async () => {
      await account("recent", 2, { source, state: false });
      await db.exec("update companies set ats_checked_at=clock_timestamp()-interval '5 minutes',site_checked_at=clock_timestamp()-interval '5 minutes'");
      assert.deepEqual(await claim(source, 12, "clock_timestamp()"), []);
    });
  }
  await test("a newly discovered ATS board does not inherit a former board's quiet history", async () => {
    await account("new-board", 2, { interval: 24, stateKey: "ats:greenhouse:old-board" });
    assert.deepEqual(await claim("ats"), ["new-board"]);
  });
  await test("other source ownership and service-only reservation privileges remain intact", async () => {
    for (const source of ["trigger", "signals", "fmcsa", "sos"]) {
      const branch = text => { const start = text.indexOf(`  if p_source = '${source}' then`); return text.slice(start, text.indexOf("    return;\n  end if;", start)); };
      assert.equal(branch(migration.replaceAll("\r\n", "\n")), branch(previous.replaceAll("\r\n", "\n")));
    }
    assert.equal((await db.query("select has_function_privilege('anon','reserve_company_rotation(text,integer,timestamptz,text)','EXECUTE') as allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('service_role','reserve_company_rotation(text,integer,timestamptz,text)','EXECUTE') as allowed")).rows[0].allowed, true);
  });
  console.log(`${passed} adaptive reservation migration tests passed`);
} finally { await db.close(); }
