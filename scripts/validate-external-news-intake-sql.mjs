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
  await db.exec("alter table intelligence_observations add column feedback_excluded boolean not null default false; alter table intelligence_jobs add column codex_news_request_id uuid; update intelligence_config set enabled=true;");
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
    const originalDefinition=await scalar("select pg_get_functiondef('intelligence_external_news_intake(text,jsonb)'::regprocedure) value");
    await db.exec(await source("0153_retained_http_article_intake.sql"));
    await db.exec(await source("0153_retained_http_article_intake.sql"));
    const changedDefinition=await scalar("select pg_get_functiondef('intelligence_external_news_intake(text,jsonb)'::regprocedure) value");
    // The entire existing TinyFish implementation after the new branch is identical.
    const anchor="  if p_action='import' then";
    assert.equal(changedDefinition.slice(changedDefinition.indexOf(anchor)),originalDefinition.slice(originalDefinition.indexOf(anchor)));
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
  async function retained() {
    const url=`https://acme.com/news/${randomUUID()}`,head="Exact retained headline",hash=sha(head+url);
    const seed=await scalar(`select intelligence_observe($1,$2,'news',$3,'Headline',$4,$5,null,'2026-10-12T00:00:00Z',
      '{"evidenceKind":"headline_only","articleBodyAvailable":false,"textTruncated":false}', '[]','evidence-v2') value`,[company,sha(url),url,head,hash]);
    const p={action:"import_retained_http",requestId:randomUUID(),taskId:"/root/reader",companyId:company,expectedIdentity:identity,sourceOnly:true,
      observationId:seed.id,expectedContentHash:hash,title:"Acme expansion",version:"evidence-v2"};
    const text="Acme has completed its own new warehouse and now offers additional storage. ".repeat(8);
    const html=`<html><head><title>Acme expansion</title></head><body><main>${text}</main></body></html>`;
    p.receipt={sourceKind:"retained_http",attestorTaskId:p.taskId,requestedUrl:url,finalUrl:url,fetchedAt:"2026-10-14T00:49:35.552Z",status:200,
      redirectCount:0,completeResponse:true,headers:{"content-type":"text/html; charset=utf-8"},bodyBase64:Buffer.from(html).toString("base64"),bodyBytes:Buffer.byteLength(html),bodySha256:sha(html)};
    const {bodyBase64,...provenance}=p.receipt;
    p.observation={url,sourceKey:sha(url),text,contentHash:sha(text+url),observedAt:p.receipt.fetchedAt,eventDate:null,
      sections:[{id:"s1",start:0,end:text.length,text}],metadata:{companyName:identity.name,companyDomain:identity.domain,evidenceKind:"article_body",articleBodyAvailable:true,
        textTruncated:false,eventDateBasis:"unknown",sourceDates:[],retainedCharacters:text.length,sourceCharacters:text.length,
        retainedHttp:{...provenance,operationId:p.requestId,priorObservationId:p.observationId,expectedContentHash:hash,networkIndependentlyVerified:false,rawBodyLocation:"intake_operation_request"}}};
    return p;
  }
  await test("retained HTTP atomically creates canonical body/job with fetch time and immutable old source/jobs/failure; exact request recovery",async()=>{
    const p=await retained(),old=await scalar("select to_jsonb(o) value from intelligence_observations o where id=$1",[p.observationId]);
    const oldJobs=await scalar("select jsonb_agg(to_jsonb(j) order by id) value from intelligence_jobs j where observation_id=$1",[p.observationId]);
    const before=await state();await db.exec("alter table app_events add constraint reject_retained check(kind<>'intelligence.external_news.retained_http') not valid");
    await assert.rejects(rpc("import_retained_http",p),/reject_retained/);assert.deepEqual(await state(),before);
    await db.exec("alter table app_events drop constraint reject_retained");
    const result=await rpc("import_retained_http",p);assert.equal(result.state,"captured");assert.notEqual(result.observationId,p.observationId);
    assert.equal(result.provider,"retained_http");assert.equal(result.networkIndependentlyVerified,false);assert.equal(result.analysisCompleted,false);
    const afterOld=await scalar("select to_jsonb(o) value from intelligence_observations o where id=$1",[p.observationId]);
    assert.deepEqual(afterOld,{...old,is_current:false});
    assert.deepEqual(await scalar("select jsonb_agg(to_jsonb(j) order by id) value from intelligence_jobs j where observation_id=$1",[p.observationId]),oldJobs);
    assert.equal(await scalar("select observed_at=$2::timestamptz value from intelligence_observations where id=$1",[result.observationId,p.receipt.fetchedAt]),true);
    assert.equal(await scalar("select count(*)::int value from intelligence_jobs where observation_id=$1 and status='queued' and attempts=0",[result.observationId]),1);
    const after=await state();assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.states,before.states);
    assert.deepEqual(await rpc("import_retained_http",p),result);assert.deepEqual(await rpc("status",{requestId:p.requestId}),result);assert.deepEqual(await state(),after);
    await assert.rejects(rpc("import_retained_http",{...p,title:"changed"}),/request_conflict/);
    const newId=randomUUID(),sameBody={...p,requestId:newId,observationId:result.observationId,expectedContentHash:p.observation.contentHash,
      observation:{...p.observation,metadata:{...p.observation.metadata,retainedHttp:{...p.observation.metadata.retainedHttp,operationId:newId,priorObservationId:result.observationId,expectedContentHash:p.observation.contentHash}}}};
    const reused=await rpc("import_retained_http",sameBody);assert.equal(reused.state,"reused");assert.equal(reused.observationId,result.observationId);
    const reuseState=await state();assert.deepEqual(reuseState.observations,after.observations);assert.deepEqual(reuseState.jobs,after.jobs);
  });
  await test("retained exact URL/hash/identity/currentness and whole raw-byte/date bindings reject without writes",async()=>{
    const p=await retained(),before=await state();
    for(const patch of [{expectedContentHash:"0".repeat(64)},{expectedIdentity:{...identity,domain:"other.com"}},
      {observation:{...p.observation,url:"https://acme.com/wrong"}},{receipt:{...p.receipt,bodySha256:"0".repeat(64)}},
      {observation:{...p.observation,observedAt:"2026-10-14T01:00:00Z"}},{observation:{...p.observation,eventDate:"2026-10-12T00:00:00Z"}}]){
      await assert.rejects(rpc("import_retained_http",{...p,...patch}));assert.deepEqual(await state(),before);
    }
    await db.query("update intelligence_observations set is_current=false where id=$1",[p.observationId]);
    await assert.rejects(rpc("import_retained_http",p),/source_binding_changed/);
    const stale=await retained();
    await db.query("update intelligence_observations set observed_at=$2::timestamptz+interval '1 second' where id=$1",[stale.observationId,stale.receipt.fetchedAt]);
    const unchanged=await state();await assert.rejects(rpc("import_retained_http",stale),/capture_precedes_current_source/);assert.deepEqual(await state(),unchanged);
  });
  await test("retained import never bypasses claimed, held, completed, uncertain, feedback or previously attempted source jobs",async()=>{
    for(const change of ["status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '20 minutes'",
      "result='{\"codexNews\":{\"hold\":\"identity_gap\"}}'","status='complete',finished_at=now()",
      "result='{\"pendingRequest\":{\"id\":\"unknown\"}}'","attempts=1","codex_news_request_id=gen_random_uuid()"]){
      const p=await retained();await db.query(`update intelligence_jobs set ${change} where observation_id=$1`,[p.observationId]);
      const before=await state();await assert.rejects(rpc("import_retained_http",p),/requires_reconciliation/);assert.deepEqual(await state(),before);
    }
    const p=await retained();await db.query("update intelligence_observations set feedback_excluded=true where id=$1",[p.observationId]);
    await assert.rejects(rpc("import_retained_http",p),/source_binding_changed/);
    const q=await retained();await db.query("insert into intelligence_research_attempts(company_id,source_url,lease_token,lease_until) values($1,$2,$3,now()+interval '1 hour')",[company,q.receipt.requestedUrl,randomUUID()]);
    await assert.rejects(rpc("import_retained_http",q),/requires_reconciliation/);
    const v=await retained();await db.query("insert into intelligence_observations(company_id,source_key,source_kind,source_url,title,evidence_text,content_hash) values($1,$2,'news',$3,'Concurrent native','Native text','otherhash')",[company,v.observation.sourceKey,v.observation.url]);
    await assert.rejects(rpc("import_retained_http",v),/source_version_conflict/);
  });
  await test("retained import honors canonical TAM-or-claimed-TAL membership without altering it",async()=>{
    for(const [status,lists,claimed,allowed] of [["removed_from_tam",[],true,true],["removed_from_tam",["netsuite_tam"],false,false],["new",["tam_duplicate","netsuite_tam"],true,false],["new",[],false,false]]){
      const p=await retained();await db.query("update companies set status=$2,lists=$3,tal_claimed=$4 where id=$1",[company,status,lists,claimed]);
      if(allowed)assert.equal((await rpc("import_retained_http",p)).state,"captured");
      else await assert.rejects(rpc("import_retained_http",p),/not_in_scope/);
      await db.query("update companies set status='new',lists=array['netsuite_tam'],tal_claimed=false where id=$1",[company]);
    }
  });
  console.log(JSON.stringify({passed:checks.length,checks,networkCalls:0,productionWrites:0}));
} catch(e) { console.error(JSON.stringify({message:e.message,detail:e.detail,where:e.where,position:e.position})); process.exitCode=1; }
finally {await db.close();}
