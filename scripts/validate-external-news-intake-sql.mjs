// Offline actual PostgreSQL DDL/function checks, using the existing PGlite installation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
const require = createRequire(process.env.STANLEY_PGLITE_PACKAGE ?? new URL("../../stanley-jev-intelligence-20260918/work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = require("@electric-sql/pglite"), { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const db = await PGlite.create("memory://", { extensions: { pgcrypto } });
const source = async name => (await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const rpc = (action, payload) => scalar("select intelligence_external_news_intake($1,$2) value", [action, payload]);
const sha = v => createHash("sha256").update(v).digest("hex");
const checks = [], test = async (name, fn) => { try { await fn(); checks.push(name); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
const company = randomUUID(), identity = { name: "Acme", domain: "acme.com", netsuiteInternalId: "123" };
function discovery(items = [{ position: 1, title: "Acme opens an office", canonicalUrl: `https://acme.com/${randomUUID()}`, captureEligible: true, itemSha256: "a".repeat(64), date: "2 months ago" }]) {
  return { requestId: randomUUID(), taskId: "/root/reader", companyId: company, expectedIdentity: identity, sourceOnly: true,
    lane: "news", endpoint: "tinyfish.web.search.news", queryHash: sha(randomUUID()), query: '"Acme"', callId: randomUUID(),
    retrievedAt: "2026-10-12T00:00:00Z", providerRequest: '{"public":"request"}', providerResponse: '{"public":"response"}',
    requestSha256: sha('{"public":"request"}'), responseSha256: sha('{"public":"response"}'), items, outcome: items.length ? "success" : "empty" };
}
const capture = p => ({ action: "capture_discovery_url", requestId: randomUUID(), taskId: "/root/reader", companyId: p.companyId,
  expectedIdentity: p.expectedIdentity, sourceOnly: true, discoveryId: p.requestId, position: 1 });
function observation(c, url) {
  const text = "A complete original with exact public company details. ".repeat(12);
  return { sourceKey: sha(url), url, text, contentHash: sha(text+url), observedAt: "2026-10-12T00:01:00Z", eventDate: null,
    sections: [{ id: "s1", start: 0, end: text.length, text }], metadata: { externalCaptureId: c.requestId, articleBodyAvailable: true,
      evidenceKind: "article_body", textTruncated: false, eventDateBasis: "unknown", sourceDates: [], retainedCharacters: text.length, sourceCharacters: text.length, companyName: "Acme" } };
}
const state = () => scalar(`select jsonb_build_object(
  'queries',(select jsonb_agg(to_jsonb(t) order by company_id,query_hash) from intelligence_external_research_queries t),
  'sources',(select jsonb_agg(to_jsonb(t) order by company_id,source_url) from intelligence_research_sources t),
  'attempts',(select jsonb_agg(to_jsonb(t) order by company_id,source_url) from intelligence_research_attempts t),
  'states',(select jsonb_agg(to_jsonb(t) order by company_id,source_key) from intelligence_source_state t),
  'events',(select jsonb_agg(to_jsonb(t) order by id) from app_events t),
  'observations',(select jsonb_agg(to_jsonb(t) order by id) from intelligence_observations t),
  'discoveries',(select jsonb_agg(to_jsonb(t) order by observation_id,discovery_key) from intelligence_observation_discoveries t),
  'jobs',(select jsonb_agg(to_jsonb(t) order by id) from intelligence_jobs t)) value`);
try {
  await db.exec(`create extension pgcrypto; create role anon; create role authenticated; create role service_role;
    create table companies(id uuid primary key,name text,domain text,netsuite_internal_id text,subindustry text,status text,lists text[],tal_claimed boolean);
    create table intelligence_directed_research_jobs(company_id uuid primary key,context_revision bigint not null default 0);`);
  await db.exec((await source("0059_intelligence_evidence_and_work.sql")).split("-- Source-key lock")[0]+"commit;");
  await db.exec(await source("0014_app_events.sql"));
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false; update intelligence_config set enabled=true;");
  const research = await source("0062_intelligence_feedback_and_research.sql");
  await db.exec(research.slice(research.indexOf("create table public.intelligence_research_attempts"),research.indexOf("create function public.intelligence_research_claim")));
  await db.exec((await source("0074_directed_research_discovery.sql")).split("create or replace function")[0]+"commit;");
  await db.exec((await source("0087_research_event_account_questions.sql")).split("create function")[0]+"commit;");
  const repair = await source("0071_collection_repair.sql");
  await db.exec(repair.slice(repair.indexOf("alter table public.intelligence_source_state"),repair.indexOf("-- Old empty")));
  await db.exec("alter table intelligence_research_attempts add column refresh_generation integer not null default 0,add column claimed_generation integer not null default 0;");
  const caught = await source("0107_intelligence_research_caught_up.sql");
  await db.exec(caught.slice(caught.indexOf("create or replace function public.intelligence_research_claim"),caught.indexOf("create or replace function public.intelligence_directed_claim")));
  await db.exec((await source("0081_intelligence_document_discoveries.sql")).split("-- These fields")[0]+"commit;");
  await db.exec((await source("0105_intelligence_reuse_answered_topics.sql")).split("create or replace function public.intelligence_observe")[0]+"commit;");
  // Actual latest observe body + exact deployed 0136 guard (no hand-written observation stub).
  const oldGuard = "select subindustry into v_subindustry from companies where id=p_company and status <> 'removed_from_tam';";
  const tal = await source("0136_tal_news_membership_independence.sql"), newGuard = tal.match(/new_guard := \$observe_new\$([\s\S]*?)\$observe_new\$/)[1];
  const observe = await source("0109_intelligence_symmetric_answer_reuse.sql"); assert.equal(observe.split(oldGuard).length,2);
  await db.exec(observe.replace(oldGuard,newGuard));
  await db.query("insert into companies values($1,'Acme','acme.com','123',null,'new',array['netsuite_tam'],false)",[company]);
  await db.query("insert into intelligence_source_state(company_id,source_key,complete,last_error,coverage_status) values($1,'news:google',false,'original Google 503','unavailable')",[company]);
  const migration = await source("0152_external_news_receipt_intake.sql");
  await test("migration compiles/reapplies with actual canonical DDL; service-only RPC",async()=>{
    await db.exec(migration); await db.exec(migration);
    for(const role of ["anon","authenticated"]) assert.equal(await scalar("select has_function_privilege($1,'intelligence_external_news_intake(text,jsonb)','EXECUTE') value",[role]),false);
    assert.equal(await scalar("select has_function_privilege('service_role','intelligence_external_news_intake(text,jsonb)','EXECUTE') value"),true);
  });
  await test("atomic populated and empty query imports; Google failure, native provenance and no-analysis credit preserved",async()=>{
    const p=discovery();
    await db.query("insert into intelligence_research_sources(company_id,source_url,title,discovered_from,metadata) values($1,$2,'Native title','native','{\"original\":true}')",[company,p.items[0].canonicalUrl]);
    const r=await rpc("import",p); assert.equal(r.state,"imported");assert.equal(r.analysisCompleted,false);assert.equal(r.accountCompleted,false);
    assert.equal(await scalar("select title value from intelligence_research_sources where company_id=$1 and source_url=$2",[company,p.items[0].canonicalUrl]),"Native title");
    const e=discovery([]),empty=await rpc("import",e);assert.equal(empty.outcome,"empty");assert.equal(empty.pagination,"unknown");
    assert.equal(await scalar("select count(*)::int value from intelligence_observations"),0);
    assert.equal(await scalar("select count(*)::int value from intelligence_jobs"),0);
    assert.equal(await scalar("select last_error value from intelligence_source_state where source_key='news:google'"),"original Google 503");
    assert.equal(await scalar("select bool_or(complete) value from intelligence_source_state"),false);
    const before=await state(); assert.deepEqual(await rpc("import",p),r);assert.deepEqual(await rpc("status",{requestId:p.requestId}),r);assert.deepEqual(await state(),before);
    await assert.rejects(rpc("import",{...p,taskId:"/root/different"}),/request_conflict/);
    await assert.rejects(rpc("import",{...p,requestId:randomUUID()}),/intelligence_external_news_call_once/);
    assert.deepEqual(await state(),before);
  });
  await test("late event failure rolls back every ledger; active query ownership and raw-byte hashes are fenced",async()=>{
    const p=discovery();await db.exec("alter table app_events add constraint reject_import check(kind<>'intelligence.external_news.import') not valid");
    const before=await state();await assert.rejects(rpc("import",p),/reject_import/);assert.deepEqual(await state(),before);
    await db.exec("alter table app_events drop constraint reject_import");
    await assert.rejects(rpc("import",{...p,responseSha256:"0".repeat(64)}),/invalid_external_query_receipt/);
    await db.query("insert into intelligence_external_research_queries(company_id,query_hash,query,purpose,lease_token) values($1,$2,$3,'news',$4)",[company,p.queryHash,p.query,randomUUID()]);
    const locked=await state();await assert.rejects(rpc("import",p),/existing_state_conflict/);assert.deepEqual(await state(),locked);
  });
  await test("gateway metadata is retained without making it a fetchable research source",async()=>{
    const p=discovery([{position:1,title:"Google-hosted result",canonicalUrl:"https://news.google.com/articles/token",captureEligible:false,captureHoldReason:"direct_original_url_required"}]);
    const r=await rpc("import",p);assert.equal(r.sourceCount,1);assert.equal(r.capturableResultCount,0);
    assert.equal(await scalar("select count(*)::int value from intelligence_research_sources where source_url=$1",[p.items[0].canonicalUrl]),0);
    const a=await rpc("begin_capture",capture(p));assert.equal(a.fetch,false);assert.equal(a.operation.state,"held");
    assert.equal(await scalar("select count(*)::int value from intelligence_research_attempts where source_url=$1",[p.items[0].canonicalUrl]),0);
  });
  await test("canonical union allows current TAM/removed claimed TAL and denies duplicate/removed/unscoped/changed identity",async()=>{
    for(const [status,lists,claimed,allowed] of [["removed_from_tam",[],true,true],["removed_from_tam",["netsuite_tam"],false,false],["new",["tam_duplicate","netsuite_tam"],true,false],["new",null,false,false]]) {
      const cid=randomUUID();await db.query("insert into companies values($1,'Acme','acme.com','123',null,$2,$3,$4)",[cid,status,lists,claimed]);
      const p={...discovery(),companyId:cid};
      if(allowed){await rpc("import",p);const c=capture(p),a=await rpc("begin_capture",c);
        assert.equal(a.fetch,true);const saved=await rpc("finish_capture",{requestId:c.requestId,lease:a.lease,observation:observation(c,p.items[0].canonicalUrl),version:"evidence-v2"});assert.equal(saved.state,"captured");}
      else await assert.rejects(rpc("import",p),/not_in_scope/);
    }
    await assert.rejects(rpc("import",{...discovery(),expectedIdentity:{...identity,domain:"namesake.com"}}),/identity_changed/);
  });
  await test("capture reserves existing URL ledger before fetch; uncertain and other-UUID operations never redispatch",async()=>{
    const p=discovery();await rpc("import",p);const c=capture(p),a=await rpc("begin_capture",c);assert.equal(a.fetch,true);assert.ok(a.lease);
    const before=await state();assert.equal((await rpc("begin_capture",c)).fetch,false);assert.deepEqual(await state(),before);
    assert.equal((await rpc("begin_capture",{...c,requestId:randomUUID()})).operation.state,"held");
    await db.query("update intelligence_research_attempts set lease_until=now()-interval '1 second' where company_id=$1 and source_url=$2",[company,p.items[0].canonicalUrl]);
    assert.equal((await rpc("begin_capture",c)).fetch,false);
    await assert.rejects(rpc("finish_capture",{requestId:c.requestId,lease:a.lease,observation:null}),/lease_expired/);
  });
  await test("existing native/held original is reused without resetting its observation or job",async()=>{
    const p=discovery();await rpc("import",p);const c=capture(p),o=observation(c,p.items[0].canonicalUrl),oid=randomUUID();
    await db.query("insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash,attributes,feedback_excluded) values($1,$2,$3,'news',$4,'Native',$5,$6,'{\"native\":true}',true)",[oid,company,o.sourceKey,o.url,o.text,o.contentHash]);
    await db.query("insert into intelligence_jobs(operation_key,observation_id,kind,status,result) values($1,$2,'interpret','complete','{\"native\":true}')",[randomUUID(),oid]);
    const before=await state(),a=await rpc("begin_capture",c);assert.equal(a.fetch,false);assert.equal(a.operation.state,"reused");assert.equal(a.operation.observationId,oid);
    const after=await state();for(const key of ["observations","jobs","attempts"])assert.deepEqual(after[key],before[key]);
  });
  await test("actual canonical observe and URL finish commit atomically; bad complete-body and late-event failures roll back",async()=>{
    const p=discovery();await rpc("import",p);const c=capture(p),a=await rpc("begin_capture",c),o=observation(c,p.items[0].canonicalUrl);
    const f={requestId:c.requestId,lease:a.lease,observation:o,version:"evidence-v2"},before=await state();
    await assert.rejects(rpc("finish_capture",{...f,observation:{...o,metadata:{...o.metadata,textTruncated:true}}}),/incomplete_external_original/);
    await assert.rejects(rpc("finish_capture",{...f,observation:{...o,eventDate:"2026-09-01T00:00:00Z"}}),/external_original_date_mismatch/);
    o.eventDate="2026-09-01T00:00:00.000Z";o.metadata.eventDateBasis="page_publication";o.metadata.sourceDates=[{kind:"published",value:o.eventDate,source:"article:published_time"}];
    await db.exec("alter table app_events add constraint reject_captured check(meta->>'state'<>'captured') not valid");
    await assert.rejects(rpc("finish_capture",f),/reject_captured/);assert.deepEqual(await state(),before);
    await db.exec("alter table app_events drop constraint reject_captured");
    const r=await rpc("finish_capture",f);assert.equal(r.state,"captured");assert.equal(r.lease,null);assert.equal(r.analysisCompleted,false);
    assert.equal(await scalar("select count(*)::int value from intelligence_jobs where observation_id=$1 and kind='interpret' and status='queued' and attempts=0",[r.observationId]),1);
    assert.equal(await scalar("select evidence_text value from intelligence_observations where id=$1",[r.observationId]),o.text);
    assert.equal(await scalar("select event_date=$2::timestamptz value from intelligence_observations where id=$1",[r.observationId,o.eventDate]),true);
    assert.deepEqual(await rpc("status",{requestId:c.requestId}),r);
    await assert.rejects(rpc("finish_capture",f),/already_terminal_read_status/);
  });
  await test("native original arriving during HTTP is reused and missing originals hold without false observations",async()=>{
    const p=discovery();await rpc("import",p);const c=capture(p),a=await rpc("begin_capture",c),o=observation(c,p.items[0].canonicalUrl),oid=randomUUID();
    await db.query("insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash) values($1,$2,$3,'news',$4,'Native',$5,'nativehash')",[oid,company,o.sourceKey,o.url,o.text]);
    const r=await rpc("finish_capture",{requestId:c.requestId,lease:a.lease,observation:o,version:"evidence-v2"});assert.equal(r.state,"reused");assert.equal(r.observationId,oid);
    assert.equal(await scalar("select count(*)::int value from intelligence_jobs where observation_id=$1",[oid]),0);
    const p2=discovery();await rpc("import",p2);const c2=capture(p2),a2=await rpc("begin_capture",c2),before=await state();
    const held=await rpc("finish_capture",{requestId:c2.requestId,lease:a2.lease,observation:null,failure:"original_unavailable"});assert.equal(held.state,"held");assert.equal(held.lease,null);
    const after=await state();assert.deepEqual(after.observations,before.observations);assert.deepEqual(after.jobs,before.jobs);
    assert.equal(await scalar("select next_attempt_at::text value from intelligence_research_attempts where company_id=$1 and source_url=$2",[company,p2.items[0].canonicalUrl]),"infinity");
  });
  await test("missing, conflicting, modified-only and future page metadata cannot manufacture a capture date",async()=>{
    for(const dates of [[],[{kind:"modified",value:"2026-09-01T00:00:00Z"}],
      [{kind:"published",value:"2026-09-01T00:00:00Z"},{kind:"published",value:"2026-09-02T00:00:00Z"}],
      [{kind:"published",value:"2099-09-01T00:00:00Z"}]]){
      const p=discovery();await rpc("import",p);const c=capture(p),a=await rpc("begin_capture",c),o=observation(c,p.items[0].canonicalUrl);
      o.metadata.sourceDates=dates;
      const f={requestId:c.requestId,lease:a.lease,observation:o,version:"evidence-v2"};
      await assert.rejects(rpc("finish_capture",{...f,observation:{...o,eventDate:"2026-09-01T00:00:00Z",metadata:{...o.metadata,eventDateBasis:"page_publication"}}}),/external_original_date_mismatch/);
      const r=await rpc("finish_capture",f);assert.equal(r.state,"captured");
      assert.equal(await scalar("select event_date value from intelligence_observations where id=$1",[r.observationId]),null);
      assert.deepEqual(await scalar("select metadata->'sourceDates' value from intelligence_observations where id=$1",[r.observationId]),dates);
    }
  });
  console.log(JSON.stringify({passed:checks.length,checks,networkCalls:0,productionWrites:0}));
} catch(e) { console.error(JSON.stringify({message:e.message,detail:e.detail,where:e.where,position:e.position})); process.exitCode=1; }
finally {await db.close();}
