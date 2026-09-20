/** Offline PostgreSQL integration of the existing federal worker and Jev proof.
 * No production access, provider requests, CRM reads or grading changes. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
let checks = 0;
const test = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };
const company = "11111111-1111-4111-8111-111111111111", observation = "22222222-2222-4222-8222-222222222222";
const leasedCompany = "33333333-3333-4333-8333-333333333333", leasedToken = "44444444-4444-4444-8444-444444444444";
const pending = { status: "pending", method: "jev_insufficient", confidence: 0, evidence: { reason: "missing_identity_evidence" } };
const native = (uei = "ABCDEFGHIJKL") => ({ status: "verified", method: "jev_identity", confidence: .12,
  evidence: { jevIdentity: { version: "federal-recipient-identity-v1", candidateId: `uei:${uei}`, outcome: "same_company", relationship: "legal_name",
    decision: { status: "verified", method: "jev_identity", confidence: .12, evidence: { sourceGrounded: true } },
    supportingSourceIds: [observation], requestFingerprint: "a".repeat(64), answerId: "candidate_relation", supportingAnswerId: "candidate_source",
    nativeJev: { model: "jev-1.13.0", answers: { candidate_relation: { type: "choice", choice: "legal_name", confidence: .12,
      probabilities: { legal_name: .12, insufficient_evidence: .09 } }, candidate_source: { type: "choice", choice: "s_material" } },
      usage: { input_tokens: 925, output_tokens: 31 }, retainedProviderField: "unchanged" }, reused: false } } });
const entityPayload = (uei, suffix = uei) => ({ uei, usaspending_recipient_id: `recipient-${suffix}`, legal_name: `Acme ${suffix} LLC`,
  address_line1: "100 Main St", city: "Austin", state: "TX", postal_code: "78701", country_code: "US", source: "usaspending",
  source_url: `https://usaspending.gov/recipient/${suffix}` });
const saveEntity = payload => scalar("select government_identity_save_entity($1) value", [payload]);
const saveMatch = (entity, decision = pending, companyId = company) => scalar("select government_identity_save_match($1,$2,$3) value", [companyId, entity, decision]);
const getMatch = entity => scalar("select to_jsonb(m) value from company_government_matches m where company_id=$1 and government_entity_id=$2", [company, entity]);
let job;
const finish = (before, decision, token = job.lease_token) => scalar("select federal_identity_finish_pending_match($1,$2,$3,$4) value", [company, token, before, decision]);
const next = (token = job.lease_token) => scalar("select federal_identity_next_pending_match($1,$2) value", [company, token]);
const claim = (name, relationship) => scalar("insert into company_federal_identity_claims(company_id,observation_id,fingerprint,subject_name,candidate_name,relationship,source_url,source_quote,captured_at) values($1,$2,$3,'Acme',$3,$4,'https://acme.com/legal','Acme explicitly declares the named relationship.',now()) returning id value", [company, observation, name, relationship]);
const bind = (claimId, payload, decision) => scalar("select federal_identity_bind_candidate($1,$2,$3,$4,$5) value", [company, job.lease_token, claimId, payload, decision]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table companies(id uuid primary key,name text,domain text,website_raw text,city text,state text,netsuite_internal_id text,lists text[],status text);
    create table intelligence_observations(id uuid primary key,company_id uuid,source_url text,observed_at timestamptz,is_current boolean,feedback_excluded boolean,source_kind text,metadata jsonb,evidence_text text);
    create table lead_documents(id uuid primary key,company_id uuid,netsuite_internal_id text,doc_type text,body text,captured_at timestamptz);
    create table triggers(id uuid primary key default gen_random_uuid(),company_id uuid,strength integer,metadata jsonb,dedupe_key text);`);
  const growth = await readFile(new URL("../../supabase/migrations/0041_tam_public_growth.sql", import.meta.url), "utf8");
  await db.exec(growth.slice(growth.indexOf("create table if not exists government_entities"), growth.indexOf("create table if not exists federal_award_transactions")));
  for (const name of ["0085_federal_identity_research.sql", "0095_federal_repair_exact_selection.sql", "0101_intelligence_identity_storage.sql"])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
  await db.query("insert into companies values($1,'Acme','acme.com',null,'Austin','TX','123',array['netsuite_tam'],'active'),($2,'Busy','busy.example',null,'Austin','TX','456',array['netsuite_tam'],'active')", [company, leasedCompany]);
  await db.query("insert into intelligence_observations values($1,$2,'https://acme.com/legal',now(),true,false,'website','{}','Acme government identity context')", [observation, company]);
  const directEntity = await saveEntity(entityPayload("ABCDEFGHIJKL"));
  await saveMatch(directEntity); await saveMatch(directEntity, pending, leasedCompany);
  await db.query("insert into federal_identity_jobs(company_id,lease_token,lease_expires_at,due_at,cursor) values($1,$2,now()+interval '4 minutes',now()+interval '3 days','{\"existing\":\"continuation\"}')", [leasedCompany, leasedToken]);
  const activeBefore = await scalar("select to_jsonb(j) value from federal_identity_jobs j where company_id=$1", [leasedCompany]);
  await test("all four migrations compile and pending records enter the existing worker", async () => {
    await db.exec(await readFile(new URL("../../supabase/migrations/0102_jev_federal_identity_research.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../../supabase/migrations/0103_federal_pending_match_lock_order.sql", import.meta.url), "utf8"));
    assert.equal(await scalar("select count(*)::int value from federal_identity_jobs"), 2);
    const after = await scalar("select to_jsonb(j) value from federal_identity_jobs j where company_id=$1", [leasedCompany]);
    for (const field of ["lease_token", "lease_expires_at", "cursor", "attempts"]) assert.deepEqual(after[field], activeBefore[field], `${field} preserved`);
    job = await scalar("select federal_identity_claim_job() value");
    assert.equal(job.company_id, company);
    assert.equal(await scalar("select federal_identity_claim_job() value"), null, "no second concurrent worker");
  });
  await test("native source proof is accepted without imposing a confidence threshold", async () => {
    for (const confidence of [0, .12, 1]) assert.equal(await scalar("select federal_identity_supported_direct($1) value", [{ ...native(), confidence }]), true);
    const before = await getMatch(directEntity), result = await finish(before, native());
    assert.deepEqual(result, { outcome: "recorded", matchStatus: "verified" });
    const after = await getMatch(directEntity);
    assert.equal(after.confidence, .12); assert.equal(after.verified_by, "jev_identity");
    assert.deepEqual(after.evidence, native().evidence, "raw native probabilities and provider payload retained");
    const receipt = await scalar("select to_jsonb(r) value from federal_identity_remediation_receipts r where match_id=$1", [after.id]);
    assert.deepEqual(receipt.before_image, before); assert.deepEqual(receipt.after_image, after);
  });
  const unresolvedEntity = await saveEntity(entityPayload("QQQQQQQQQQQQ"));
  await saveMatch(unresolvedEntity);
  await test("missing, ungrounded and nonnative proofs cannot upgrade a pending identity", async () => {
    const before = await getMatch(unresolvedEntity);
    for (const edit of [
      value => { value.evidence.jevIdentity.supportingSourceIds = []; },
      value => { value.evidence.jevIdentity.decision.evidence.sourceGrounded = false; },
      value => { value.evidence.jevIdentity.nativeJev = null; },
      value => { value.evidence.jevIdentity.requestFingerprint = "incomplete"; },
    ]) {
      const decision = native("QQQQQQQQQQQQ"); edit(decision);
      assert.equal(await scalar("select federal_identity_supported_direct($1) value", [decision]), false);
      await assert.rejects(finish(before, decision), /unsupported pending repair/);
      assert.deepEqual(await getMatch(unresolvedEntity), before);
    }
  });
  await test("withdrawn or excluded source evidence blocks ordinary and pending writes until restored", async () => {
    const before = await getMatch(unresolvedEntity), decision = native("QQQQQQQQQQQQ");
    const receiptCount = await scalar("select count(*)::int value from federal_identity_remediation_receipts");
    for (const field of ["feedback_excluded", "is_current"]) {
      await db.query(`update intelligence_observations set ${field}=$1 where id=$2`, [field === "feedback_excluded", observation]);
      assert.equal(await scalar("select federal_identity_sources_current($1,$2) value", [company, decision]), false);
      await assert.rejects(finish(before, decision), /unsupported pending repair/);
      await assert.rejects(saveMatch(unresolvedEntity, decision), /unsupported Jev identity source/);
      assert.deepEqual(await getMatch(unresolvedEntity), before);
      assert.equal(await scalar("select count(*)::int value from federal_identity_remediation_receipts"), receiptCount);
      await db.query(`update intelligence_observations set ${field}=$1 where id=$2`, [field !== "feedback_excluded", observation]);
      assert.equal(await scalar("select federal_identity_sources_current($1,$2) value", [company, decision]), true);
    }
    assert.equal(await scalar("select federal_identity_sources_current($1,$2) value", [leasedCompany, decision]), false, "another account's source cannot be borrowed");
  });
  await test("the same selected pending record is retained until a fenced exact write succeeds", async () => {
    const first = await next(); assert.equal(first.match.government_entity_id, unresolvedEntity);
    assert.deepEqual(await next(), first, "read-only selection does not consume the candidate");
    await assert.rejects(next("99999999-9999-4999-8999-999999999999"), /identity lease lost/);
    await assert.rejects(finish(first.match, pending, "99999999-9999-4999-8999-999999999999"), /identity lease lost/);
    assert.deepEqual(await finish({ ...first.match, confidence: .4 }, pending), { outcome: "stale" });
    assert.deepEqual((await next()).match, first.match);
  });
  await test("unresolved outcomes keep history and avoid repeated scans until the existing cooldown expires", async () => {
    const before = await getMatch(unresolvedEntity);
    assert.deepEqual(await finish(before, pending), { outcome: "recorded", matchStatus: "pending" });
    assert.deepEqual(await next(), { match: null, pending: false });
    await db.query("update federal_identity_remediation_receipts set created_at=now()-interval '8 days' where match_id=$1", [before.id]);
    assert.equal((await next()).match.id, before.id);
    assert.deepEqual(await finish((await next()).match, pending), { outcome: "recorded", matchStatus: "pending" });
    assert.equal(await scalar("select count(*)::int value from federal_identity_remediation_receipts where match_id=$1", [before.id]), 2);
  });
  await test("rejected history and stale verified selections cannot be overwritten by ordinary Jev repair", async () => {
    const entity = await saveEntity(entityPayload("RRRRRRRRRRRR")), inserted = await saveMatch(entity), before = inserted.match;
    const rejected = await saveMatch(entity, { status: "rejected", method: "manual", confidence: 1, evidence: { reason: "different business" } });
    assert.deepEqual(await finish(before, native("RRRRRRRRRRRR")), { outcome: "stale" });
    assert.deepEqual((await saveMatch(entity, native("RRRRRRRRRRRR"))).match, rejected.match);
    const verified = await getMatch(directEntity);
    assert.deepEqual(await finish(verified, pending), { outcome: "stale" });
    assert.deepEqual(await getMatch(directEntity), verified);
  });
  await test("new source-claim binding accepts native proof but keeps a subsidiary in related context", async () => {
    const directClaim = await claim("Acme Federal LLC", "legal_name"), relatedClaim = await claim("Acme West LLC", "subsidiary");
    const directPayload = entityPayload("SSSSSSSSSSSS"), relatedPayload = entityPayload("TTTTTTTTTTTT");
    const direct = await bind(directClaim, directPayload, native(directPayload.uei));
    assert.equal(await bind(directClaim, directPayload, native(directPayload.uei)), direct);
    const related = await bind(relatedClaim, relatedPayload, native(relatedPayload.uei));
    assert.equal(await scalar("select count(*)::int value from company_government_matches where company_id=$1 and government_entity_id=$2", [company, related]), 0);
    assert.equal(await scalar("select relationship value from company_related_government_entities where government_entity_id=$1", [related]), "subsidiary");
    assert.deepEqual((await getMatch(direct)).evidence.jevIdentity.nativeJev, native().evidence.jevIdentity.nativeJev);
    await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [observation]);
    await assert.rejects(bind(relatedClaim, entityPayload("UUUUUUUUUUUU"), native("UUUUUUUUUUUU")), /identity source changed/);
    await db.query("update intelligence_observations set feedback_excluded=false where id=$1", [observation]);
  });
  await test("historical weak bindings gain sourced native proof without losing award history", async () => {
    const entity = await saveEntity(entityPayload("VVVVVVVVVVVV"));
    const before = (await saveMatch(entity, { status: "verified", method: "name_only", confidence: .6, evidence: { legacy: true } })).match;
    await db.query("insert into federal_awards(government_entity_id,generated_award_id,source_url) values($1,'historic-award','https://usaspending.gov/award/historic')", [entity]);
    await db.query("update intelligence_observations set feedback_excluded=true where id=$1", [observation]);
    await assert.rejects(scalar("select federal_identity_repair_match($1,$2,$3,$4,'strengthened_direct',$5,$6) value",
      [company, job.lease_token, before.id, before, native("VVVVVVVVVVVV"), { jev: true }]), /unsupported direct repair/);
    assert.deepEqual(await getMatch(entity), before);
    await db.query("update intelligence_observations set feedback_excluded=false where id=$1", [observation]);
    const result = await scalar("select federal_identity_repair_match($1,$2,$3,$4,'strengthened_direct',$5,$6) value", [company, job.lease_token, before.id, before, native("VVVVVVVVVVVV"), { jev: true }]);
    assert.equal(result.outcome, "strengthened_direct");
    const after = await getMatch(entity); assert.equal(after.match_method, "jev_identity"); assert.equal(after.verified_by, "jev_identity");
    assert.deepEqual(after.evidence.jevIdentity.nativeJev, native().evidence.jevIdentity.nativeJev);
    assert.equal(await scalar("select count(*)::int value from federal_awards where government_entity_id=$1", [entity]), 1);
  });
  await test("pending selection crosses previously capped match counts without skipping unreceipted identities", async () => {
    await db.exec("insert into government_entities(id,uei,legal_name,source) select md5('pending-'||n)::uuid,'U'||lpad(n::text,11,'0'),'Pending '||n,'fixture' from generate_series(1,205) n");
    await db.query("insert into company_government_matches(id,company_id,government_entity_id,match_status,match_method,confidence,evidence,updated_at) select lpad(to_hex(n),32,'0')::uuid,$1,md5('pending-'||n)::uuid,'pending','name_only',.5,'{}','2020-01-01' from generate_series(1,205) n", [company]);
    await db.query("insert into federal_identity_remediation_receipts(match_id,company_id,policy_version,before_image,outcome,evidence) select m.id,$1,'jev-recipient-v1',to_jsonb(m),'insufficient_evidence','{}' from company_government_matches m where m.company_id=$1 and m.id between lpad(to_hex(1),32,'0')::uuid and lpad(to_hex(204),32,'0')::uuid", [company]);
    assert.equal((await next()).match.id, "00000000-0000-0000-0000-0000000000cd");
  });
  await test("new entry points remain service-only and finishing releases the same existing lease", async () => {
    for (const signature of ["federal_identity_supported_direct(jsonb)", "federal_identity_sources_current(uuid,jsonb)", "federal_identity_next_pending_match(uuid,uuid)", "federal_identity_finish_pending_match(uuid,uuid,jsonb,jsonb)"]) {
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE') value", [signature]), false);
      assert.equal(await scalar("select has_function_privilege('authenticated',$1,'EXECUTE') value", [signature]), false);
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    }
    assert.equal(await scalar("select federal_identity_finish_job($1,$2,'{}','{\"status\":\"tested\"}',true) value", [company, job.lease_token]), true);
    await assert.rejects(next(), /identity lease lost/);
  });
  console.log(JSON.stringify({ passed: true, checks }));
} finally { await db.close(); }
