/** Execute the actual migration in offline PostgreSQL. No provider/live IO. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
const version = "current-catalog", versions = { rr_c01: "v1", rr_i01: "v1", rr_c05: "v1" };
const candidates = (hidden = false) => scalar("select intelligence_customer_match_candidates($1,$2,$3)", [version, versions, hidden]);
const evidence = selection => scalar("select intelligence_customer_match_evidence($1,$2,$3)", [selection, version, versions]);
let passed = 0;
async function check(name, run) {
  await db.exec("begin");
  try { await run(); passed++; console.log(`PASS ${name}`); }
  finally { await db.exec("rollback"); }
}
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table companies(id uuid primary key,name text,domain text,subindustry text,netsuite_internal_id text,status text,
      description text,ns_industry text,record_dead boolean,lists text[],tam_score numeric default 12);
    create table intelligence_catalog_accounts(company_id uuid primary key,catalog_version text,evidence_key text);
    create table intelligence_catalog_facets(company_id uuid,facet_id text,catalog_version text,facet_version text,
      evidence_key text,status text,decision text,probability numeric,native_result jsonb,citation_set_key text,citations jsonb,
      primary key(company_id,facet_id));
    create table intelligence_catalog_citation_sets(citation_set_key text primary key,company_id uuid,evidence_key text,citations jsonb);
    create table intelligence_observations(id uuid primary key,company_id uuid,is_current boolean,feedback_excluded boolean,content_hash text,
      source_url text,title text,source_kind text,event_date timestamptz,observed_at timestamptz,evidence_text text);
    create table triggers(id uuid primary key,company_id uuid,type text,summary text,source_name text,source_url text,signal_date timestamptz,metadata jsonb);
    insert into companies(id,name,domain,subindustry,netsuite_internal_id,status,record_dead,lists)
      select md5(i::text)::uuid,'Company '||i,'example.test','Business Services',i::text,'new',false,array['netsuite_tam']
      from generate_series(1,1003) i;
    insert into intelligence_catalog_accounts select id,'current-catalog','snapshot' from companies;
    insert into intelligence_observations
      select id,id,true,false,'source-hash','https://example.test/services','Full source','website',null,now(),'Hardware installation and managed services.' from companies;
    insert into intelligence_catalog_citation_sets
      select id::text,id,'snapshot',jsonb_build_array(jsonb_build_object('observationId',id,'contentHash','source-hash',
        'url','https://example.test/services','title','Full source','sourceKind','website','observedAt',now(),'start',0,'end',42)) from companies;
    insert into intelligence_catalog_facets
      select c.id,f.id,'current-catalog','v1','snapshot','answered','supported',0.9,
        jsonb_build_object('questionId',f.id,'answer',jsonb_build_object('type','choice','choice','supported')),c.id::text,'[]'
      from companies c cross join (values('rr_c01'),('rr_i01')) f(id);
    insert into intelligence_catalog_facets
      select id,'rr_c05','current-catalog','v1','snapshot','answered','insufficient_evidence',null,
        '{"questionId":"rr_c05","answer":{"type":"choice","choice":"insufficient_evidence"}}',null,'[]' from companies;
  `);
  const before = await scalar("select md5(jsonb_agg(to_jsonb(c) order by id)::text) from companies c");
  await db.exec(await readFile(new URL("../../supabase/migrations/0128_customer_reference_matches.sql", import.meta.url), "utf8"));
  assert.equal(await scalar("select md5(jsonb_agg(to_jsonb(c) order by id)::text) from companies c"), before);
  passed++; console.log("PASS migration preserves every canonical company and grade");
  const id = await scalar("select id from companies order by id limit 1");
  await db.query(`insert into triggers(id,company_id,type,summary,source_name,source_url,signal_date,metadata)
    values(gen_random_uuid(),$1,'ma','Acquisition','Company','https://example.test/acquisition',now()-interval '1 day',
      jsonb_build_object('intelligenceEvidence',repeat('complete retained long source ',4000),
        'stanley_quarantine',jsonb_build_object('active',false),'contractEventMergedInto','retained-merge-id',
        'contractTimingInactive',true,'intelligenceFeedbackExcluded',true,
        'jevFinding',jsonb_build_object('eventId','retained-event','attributes',jsonb_build_object('companyRelationship','direct','contentClass','actual_company_development'),
          'rawAnswers',repeat('native answer ',4000))))`, [id]);
  const beforeOptimization = await candidates();
  const optimization = await readFile(new URL("../../supabase/migrations/0129_customer_match_read_performance.sql", import.meta.url), "utf8");
  const transactionStart = optimization.indexOf("\nbegin;");
  // CONCURRENTLY must be a separate database command, as in production.
  await db.exec(optimization.slice(0, transactionStart));
  await db.exec(optimization.slice(transactionStart));
  const afterOptimization = await candidates();
  assert.deepEqual(afterOptimization.accounts.map(a => [a.companyId,a.decisions]),beforeOptimization.accounts.map(a => [a.companyId,a.decisions]));
  const beforeTiming = beforeOptimization.accounts.find(a => a.companyId === id).triggers[0];
  const afterTiming = afterOptimization.accounts.find(a => a.companyId === id).triggers[0];
  for (const key of ['stanley_quarantine','contractEventMergedInto','contractTimingInactive','intelligenceFeedbackExcluded'])
    assert.deepEqual(afterTiming.metadata[key],beforeTiming.metadata[key]);
  assert.deepEqual(afterTiming.metadata.jevFinding.attributes,beforeTiming.metadata.jevFinding.attributes);
  assert.equal(afterTiming.metadata.jevFinding.eventId,beforeTiming.metadata.jevFinding.eventId);
  assert.ok(JSON.stringify(afterTiming).length<JSON.stringify(beforeTiming).length/100);
  assert.equal(await scalar("select length(metadata->>'intelligenceEvidence') from triggers where company_id=$1",[id]),120000);
  await db.query("delete from triggers where company_id=$1",[id]);
  passed++; console.log("PASS read optimization retains every decision and policy field without copying full source/provider bodies");
  await check("all1003 accounts survive JSON aggregation and native uncited unknown is evaluated", async () => {
    const result = await candidates(); assert.equal(result.accounts.length, 1003);
    assert.deepEqual(result.accounts[0].decisions, { rr_c01: "supported", rr_c05: "insufficient_evidence", rr_i01: "supported" });
  });
  await check("dismissal and canonical membership filters remain exact", async () => {
    await db.query("update companies set status='dismissed' where id=$1", [id]);
    assert.equal((await candidates()).accounts.length, 1002); assert.equal((await candidates(true)).accounts.length, 1003);
    for (const update of ["status='removed_from_tam'", "lists=array['netsuite_tam','tam_duplicate']", "lists='{}'", "netsuite_internal_id='invalid'"]) {
      await db.exec("savepoint eligibility"); await db.query(`update companies set ${update} where id=$1`, [id]);
      assert.equal((await candidates(true)).accounts.length, 1002); await db.exec("rollback to savepoint eligibility");
    }
  });
  await check("changed hashes, excluded sources and a foreign source cannot support a match", async () => {
    for (const update of ["content_hash='changed'", "feedback_excluded=true", "is_current=false", "company_id=gen_random_uuid()"]) {
      await db.exec("savepoint source"); await db.query(`update intelligence_observations set ${update} where id=$1`, [id]);
      const row = (await candidates()).accounts.find(a => a.companyId === id);
      assert.deepEqual(row.decisions, { rr_c05: "insufficient_evidence" });
      assert.equal((await evidence([{ companyId: id, facets: ["rr_c01"] }]))[0].catalogFacets.length, 0);
      await db.exec("rollback to savepoint source");
    }
  });
  await check("stale versions, account keys and mismatched native decisions cannot leak into ranking", async () => {
    for (const update of ["catalog_version='old'", "facet_version='old'", "evidence_key='old'", "native_result='{}'"]) {
      await db.exec("savepoint version"); await db.query(`update intelligence_catalog_facets set ${update} where company_id=$1 and facet_id='rr_c01'`, [id]);
      assert.equal((await candidates()).accounts.find(a => a.companyId === id).decisions.rr_c01, undefined);
      await db.exec("rollback to savepoint version");
    }
  });
  await check("current inline citations still hydrate exact native proof", async () => {
    await db.query(`update intelligence_catalog_facets f set citation_set_key=null,citations=(select citations from intelligence_catalog_citation_sets where company_id=$1)
      where f.company_id=$1 and facet_id='rr_c01'`, [id]);
    const row = (await evidence([{ companyId: id, facets: ["rr_c01"] }]))[0];
    assert.equal(row.catalogFacets.length, 1); assert.equal(row.observations.length, 1);
    assert.equal(row.catalogFacets[0].nativeResult.answer.choice, "supported");
    assert.equal(row.observations[0].evidence_text, "Hardware installation and managed services.");
    assert.equal((await candidates()).accounts.find(a => a.companyId === id).decisions.rr_c01, "supported");
  });
  await check("wide evidence is bounded to25accounts while requests have no total candidate cap", async () => {
    const ids = (await candidates()).accounts.slice(0, 26).map(a => ({ companyId: a.companyId, facets: ["rr_c01", "rr_i01"] }));
    assert.equal((await evidence(ids.slice(0, 25))).length, 25);
    await db.exec("savepoint invalid"); await assert.rejects(() => evidence(ids), /Invalid customer match evidence query/); await db.exec("rollback to savepoint invalid");
  });
  await check("timing requires a real source event date and does not substitute detected_at", async () => {
    await db.query(`insert into triggers(id,company_id,type,summary,source_name,source_url,signal_date,metadata)
      values(gen_random_uuid(),$1,'ma','Known acquisition','Source','https://example.test/news',now()-interval '2 days','{}'),
      (gen_random_uuid(),$1,'ma','Undated','Source','https://example.test/unknown',null,'{}'),
      (gen_random_uuid(),$1,'ma','Old','Source','https://example.test/old',now()-interval '2 years','{}')`, [id]);
    assert.equal((await candidates()).accounts.find(a => a.companyId === id).triggers.length, 1);
  });
  await check("public roles cannot read references or execute comparison SQL", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await scalar("select has_table_privilege($1,'intelligence_customer_references','SELECT')", [role]), false);
      for (const fn of ["intelligence_customer_match_candidates(text,jsonb,boolean)", "intelligence_customer_match_evidence(jsonb,text,jsonb)"])
        assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')", [role, fn]), false);
    }
    assert.equal(await scalar("select has_table_privilege('service_role','intelligence_customer_references','SELECT,INSERT,UPDATE')"), true);
    assert.equal(await scalar("select relrowsecurity from pg_class where oid='intelligence_customer_references'::regclass"), true);
  });
  console.log(`${passed} actual PostgreSQL customer-match checks passed; no model calls or live writes.`);
} finally { await db.close(); }
