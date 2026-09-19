import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const company = randomUUID(), observation = randomUUID();
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb);`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0067_intelligence_directed_research_queue.sql", "0074_directed_research_discovery.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  await db.query("insert into companies values($1,'new','Synthetic','company.com','HR & Staffing','1',array['netsuite_tam'])", [company]);
  await db.exec("update intelligence_config set enabled=true");
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
    values($1,$2,'source','website','https://company.com/','Services','Synthetic public services evidence','hash','{}')`, [observation, company]);
  assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "queued");
  console.log("PASS unknown topics after an interpreted baseline can deepen without another approval score");

  const before = await scalar("select desired_hash from intelligence_directed_research_jobs where company_id=$1", [company]);
  await db.query("insert into intelligence_source_state(company_id,source_key,cursor) values($1,'website',$2)", [company, { pendingUrls: ["https://company.com/services/payroll"], verifiedUrls: [] }]);
  assert.notEqual(await scalar("select desired_hash from intelligence_directed_research_jobs where company_id=$1", [company]), before);
  const job = (await db.query("select * from intelligence_directed_claim(1)")).rows[0];
  await db.query("update intelligence_source_state set cursor=$2 where company_id=$1", [company, { knownUrls: ["https://company.com/services/payroll", "https://company.com/careers/finance"] }]);
  assert.equal(await scalar("select lease_token from intelligence_directed_research_jobs where company_id=$1", [company]), job.lease_token);
  assert.equal(await scalar("select intelligence_directed_finish($1,$2,$3,'queued',600,'{}',null)", [company, job.lease_token, job.desired_hash]), true);
  console.log("PASS unread links change the wakeup fingerprint without invalidating an active research lease");

  await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [observation]);
  assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "superseded");
  await db.query("update intelligence_observations set feedback_excluded=false where id=$1", [observation]);
  assert.equal(await scalar("select status from intelligence_directed_research_jobs where company_id=$1", [company]), "queued");
  console.log("PASS excluding the last evidence stops research and Undo restores it");

  assert.equal(await scalar("select has_table_privilege('anon','intelligence_research_sources','SELECT')"), false);
  assert.equal(await scalar("select relrowsecurity from pg_class where relname='intelligence_research_sources'"), true);
  assert.equal(await scalar("select has_function_privilege('anon','intelligence_directed_refresh(uuid)','EXECUTE')"), false);
  console.log("PASS discovered-source storage and wakeups remain service-only");
} catch (error) { console.error(error.message, error.detail ?? "", error.where ?? ""); process.exitCode = 1; }
finally { await db.close(); }
