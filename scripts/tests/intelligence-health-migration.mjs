import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const localRequire = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = localRequire("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const company = randomUUID(), removed = randomUUID(), duplicate = randomUUID(), observation = randomUUID();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,status text,name text,domain text,subindustry text,netsuite_internal_id text,lists text[]);
    create table trigger_candidates(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),verdict text,promoted_trigger_id uuid);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,metadata jsonb,detected_at timestamptz default now());`);
  for (const name of ["0059_intelligence_evidence_and_work.sql", "0061_intelligence_operating_topic_search.sql", "0062_intelligence_feedback_and_research.sql", "0065_intelligence_runtime_metrics.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  await db.query(`insert into companies values($1,'new','Synthetic',null,null,'1',array['netsuite_tam']),
    ($2,'removed_from_tam','Removed',null,null,'2',array['netsuite_tam']),
    ($3,'new','Duplicate',null,null,'3',array['netsuite_tam','tam_duplicate'])`, [company, removed, duplicate]);
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,observed_at,interpreted_at,attributes)
    values($1,$2,'source','website','https://example.test/news','Synthetic','Public evidence','hash',now()-interval '10 minutes',now()-interval '5 minutes','{}')`, [observation, company]);
  await db.query(`insert into intelligence_jobs(operation_key,observation_id,kind,status,due_at,finished_at)
    values('due',$1,'interpret','queued',now(),null),('deferred',$1,'interpret','queued',now()+interval '1 day',null),
      ('completed',$1,'interpret','complete',now(),now())`, [observation]);
  const excludedObservation = randomUUID();
  await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash)
    values($1,$2,'excluded','website','https://example.test/excluded','Excluded','Public evidence','excluded')`, [excludedObservation, company]);
  await db.query(`insert into intelligence_feedback(company_id,observation_id,reason) values($1,$2,'irrelevant')`, [company, excludedObservation]);
  await db.query(`insert into triggers(company_id,metadata) values($1,$2)`, [company, { jevFinding: { observationId: excludedObservation } }]);
  for (const extra of [{}, { quarantine: { reason: "excluded" } }])
    await db.query(`insert into triggers(company_id,metadata) values($1,$2)`, [company, { jevFinding: { observationId: observation }, ...extra }]);
  await db.query(`insert into triggers(company_id,metadata) values($1,'{}'),($2,$3)`, [company, removed, { jevFinding: { observationId: observation } }]);
  await db.query(`insert into intelligence_source_state(company_id,source_key,complete,last_success_at) values($1,'website',true,now()),($1,'ats:lever:test',true,now()-interval '3 days')`, [company]);
  const health = (await db.query("select intelligence_health() as result")).rows[0].result;
  assert.equal(health.coverage.tamAccounts, 1);
  assert.equal(health.coverage.accountsInterpreted, 1);
  assert.equal(health.coverage.websiteSuccess48h, 1);
  assert.equal(health.coverage.atsSuccess48h, 0);
  assert.equal(health.queue.due, 1);
  assert.equal(health.queue.deferred, 1);
  assert.equal(health.queue.completedLastHour, 1);
  assert.equal(health.yield.jevTriggersLast24h, 1);
  assert.equal(health.yield.distinctTriggeredAccountsLast24h, 1);
  assert.equal(health.freshness.medianCaptureToInterpretSeconds, 300);
  assert.ok(health.yield.medianCaptureToCardSeconds >= 600 && health.yield.medianCaptureToCardSeconds < 602);
  assert.equal((await db.query("select has_function_privilege('anon','intelligence_health()','execute') as allowed")).rows[0].allowed, false);
  console.log("PASS intelligence health: canonical coverage, due/deferred queues, observed latency, excluded findings, service-only access");
  const peer = randomUUID(), sourceA = randomUUID(), sourceB = randomUUID();
  const traits = topics => ({ companyRelationship: "direct", companyRelevance: .94,
    topicEvidence: topics.map(topic => ({ topic, probability: .9, start: 0, end: 6 })) });
  await db.query("update intelligence_observations set attributes=$2 where id=$1", [observation, traits(["multi_entity", "project_billing"])]);
  await db.query("insert into companies values($1,'new','Peer',null,'Engineering','4',array['netsuite_tam'])", [peer]);
  for (const [id, account, topic] of [[sourceA, peer, "multi_entity"], [sourceB, peer, "project_billing"], [randomUUID(), removed, "multi_entity"], [randomUUID(), removed, "project_billing"]])
    await db.query(`insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes)
      values($1::uuid,$2,$1::uuid::text,'website','https://example.test/'||$1::uuid::text,'Public source','Public evidence',$1::uuid::text,$3)`, [id, account, traits([topic])]);
  const find = async () => (await db.query("select intelligence_lookalikes($1) as result", [company])).rows[0].result;
  const matched = await find();
  assert.equal(matched.accounts.length, 1);
  assert.equal(matched.accounts[0].companyId, peer);
  assert.equal(matched.accounts[0].sources.length, 2);
  assert.equal(matched.accounts[0].sharedTopics.length, 2);
  await db.query("insert into intelligence_feedback(company_id,observation_id,reason) values($1,$2,'wrong_company')", [peer, sourceA]);
  assert.equal((await find()).accounts.length, 0);
  assert.equal((await db.query("select intelligence_lookalikes($1) as result", [randomUUID()])).rows[0].result.accounts.length, 0);
  assert.equal((await db.query("select has_function_privilege('anon','intelligence_lookalikes(uuid,integer,integer)','execute') as allowed")).rows[0].allowed, false);
  console.log("PASS operating lookalikes: combined source traits, removed-account exclusion, feedback correction, unknown seed, access control");
} catch (error) { console.error(error.message); process.exitCode = 1; } finally { await db.close(); }
