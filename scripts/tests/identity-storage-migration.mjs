/** Offline PostgreSQL identity persistence checks; no live reads/model calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const requireLocal = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireLocal("@electric-sql/pglite");
const db = await PGlite.create("memory://");
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value;
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const company = "11111111-1111-4111-8111-111111111111";
const payload = { uei: "ABCDEFGHIJKL", cage_code: "1AB23", usaspending_recipient_id: "recipient-1", legal_name: "Acme", source: "SAM.gov",
  address_line1: "100 Main St", evidence: { addressLine2: "Suite 200", psc: ["R001"] }, source_url: "https://sam.gov/entity/ABCDEFGHIJKL" };
const pending = { status: "pending", method: "name_candidate", confidence: .35, evidence: { candidatePlausible: true } };
const native = { status: "verified", method: "jev_identity", confidence: .97, evidence: { provider_result: { answers: { relationship: { choice: "same_legal_entity" } } } } };
const save = input => scalar("select government_identity_save_entity($1) value", [input]);
const match = (entity, decision, c = company) => scalar("select government_identity_save_match($1,$2,$3) value", [c, entity, decision]);
const row = id => scalar("select to_jsonb(g) value from government_entities g where id=$1", [id]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
   create table companies(id uuid primary key); insert into companies values('${company}');`);
  // Exact production tables/indexes; unrelated growth tables are unnecessary.
  const schema = await readFile(new URL("../../supabase/migrations/0041_tam_public_growth.sql", import.meta.url), "utf8");
  await db.exec(schema.slice(schema.indexOf("create table if not exists government_entities"), schema.indexOf("create table if not exists federal_awards")));
  await db.exec(await readFile(new URL("../../supabase/migrations/0101_intelligence_identity_storage.sql", import.meta.url), "utf8"));
  let id;
  await test("all supplied keys converge and repeated source writes are idempotent", async () => {
    id = await save(payload); assert.equal(await save(payload), id);
    assert.equal(await scalar("select count(*)::int value from government_entities"), 1);
    assert.equal((await row(id)).evidence.addressLine2AddressLine1, "100 Main St");
    assert.equal((await row(id)).evidence.addressLine2SourceUrl, payload.source_url);
  });
  await test("CAGE-only refresh preserves UEI/recipient and all supplied key conflicts refuse writes", async () => {
    assert.equal(await save({ ...payload, uei: null, usaspending_recipient_id: null }), id);
    assert.equal((await row(id)).uei, payload.uei); assert.equal((await row(id)).usaspending_recipient_id, "recipient-1");
    for (const change of [{ uei: "ZZZZZZZZZZZZ" }, { cage_code: "9ZZ99" }, { usaspending_recipient_id: "different" }]) {
      const before = await row(id);
      await assert.rejects(save({ ...payload, ...change }), /conflicting stored government identifiers/);
      assert.deepEqual(await row(id), before);
    }
  });
  await test("keys that already identify different entities cannot merge their rows", async () => {
    await save({ ...payload, uei: "ZZZZZZZZZZZZ", cage_code: "9ZZ99", usaspending_recipient_id: "recipient-2" });
    await assert.rejects(save({ ...payload, cage_code: "9ZZ99" }), /conflicting government identifier mappings/);
    assert.equal(await scalar("select count(*)::int value from government_entities"), 2);
  });
  await test("null identifiers cannot erase identity, and incomplete candidates do not create anonymous entities", async () => {
    assert.equal(await save({ ...payload, uei: " abcdefghijkl ", cage_code: null, usaspending_recipient_id: null }), id);
    assert.equal((await row(id)).cage_code, "1AB23");
    await assert.rejects(save({ ...payload, uei: null, cage_code: null, usaspending_recipient_id: null }), /invalid government entity identity/);
    await assert.rejects(save({ ...payload, uei: "bad" }), /invalid government entity identity/);
  });
  await test("SAM suite evidence survives other-source writes with its original street provenance", async () => {
    await save({ ...payload, address_line1: "900 New Rd", evidence: { businessCategories: ["corporation"] }, source: "USAspending", source_url: "https://usaspending.gov/award/one" });
    const result = await row(id);
    assert.equal(result.address_line1, "900 New Rd"); assert.equal(result.evidence.addressLine2, "Suite 200");
    assert.equal(result.evidence.addressLine2AddressLine1, "100 Main St");
    assert.equal(result.evidence.addressLine2SourceUrl, payload.source_url);
    assert.deepEqual(result.evidence.businessCategories, ["corporation"]);
    // No false concatenation: the retained suite's street differs from current.
    assert.notEqual(result.evidence.addressLine2AddressLine1, result.address_line1);
  });
  await test("new pending evidence upgrades atomically and keeps the native Jev answer intact", async () => {
    assert.equal((await match(id, pending)).disposition, "inserted");
    const upgraded = await match(id, native);
    assert.equal(upgraded.disposition, "updated"); assert.equal(upgraded.match.match_status, "verified");
    assert.equal(upgraded.match.verified_by, "jev_identity"); assert.ok(upgraded.match.verified_at);
    assert.deepEqual(upgraded.match.evidence, native.evidence);
  });
  await test("stale pending/different results and refreshes preserve the entire verified before-image", async () => {
    const before = (await match(id, native)).match;
    for (const decision of [pending, { ...pending, status: "rejected", method: "jev_different" }, { ...native, method: "domain" }]) {
      const result = await match(id, decision); assert.equal(result.disposition, "preserved_verified"); assert.deepEqual(result.match, before);
    }
  });
  await test("explicit rejected history cannot be overwritten even by a new verified result", async () => {
    const rejectedEntity = await save({ ...payload, uei: "QQQQQQQQQQQQ", cage_code: "8QQ88", usaspending_recipient_id: "recipient-3" });
    const original = await match(rejectedEntity, { ...pending, status: "rejected", method: "manual", evidence: { reason: "different legal company" } });
    const next = await match(rejectedEntity, native);
    assert.equal(next.disposition, "preserved_rejected"); assert.deepEqual(next.match, original.match);
  });
  await test("invalid/fractional status payloads never change existing decisions", async () => {
    const before = (await match(id, native)).match;
    for (const change of [{ status: "related" }, { confidence: 2 }, { confidence: null }, { evidence: [] }, { method: "" }])
      await assert.rejects(match(id, { ...pending, ...change }), /invalid government match decision/);
    assert.deepEqual((await match(id, native)).match, before);
  });
  await test("a legacy insertion winner is reread by every identifier before acceptance", async () => {
    // A trigger simulates a legacy writer winning between lookup and insert.
    await db.exec(`create function inject_identity_collision() returns trigger language plpgsql as $$ begin
      if pg_trigger_depth()=1 and new.uei in ('RRRRRRRRRRRR','SSSSSSSSSSSS') then
        insert into government_entities(uei,cage_code,usaspending_recipient_id,legal_name,source)
          values(new.uei,case when new.uei='RRRRRRRRRRRR' then new.cage_code else '4BAD4' end,new.usaspending_recipient_id,'Legacy winner','fixture');
      end if; return new; end $$;
      create trigger test_collision before insert on government_entities for each row execute function inject_identity_collision();`);
    const winner = await save({ ...payload, uei: "RRRRRRRRRRRR", cage_code: "3RR33", usaspending_recipient_id: "race-1" });
    assert.equal((await row(winner)).legal_name, "Acme");
    assert.equal(await scalar("select count(*)::int value from government_entities where uei='RRRRRRRRRRRR'"), 1);
    await assert.rejects(save({ ...payload, uei: "SSSSSSSSSSSS", cage_code: "3SS33", usaspending_recipient_id: "race-2" }), /conflicting stored government identifiers/);
    assert.equal(await scalar("select count(*)::int value from government_entities where uei='SSSSSSSSSSSS'"), 0, "conflict transaction rolls back all writes");
  });
  await test("match insertion collision preserves the actual winner, not the stale proposed decision", async () => {
    const otherCompany = "33333333-3333-4333-8333-333333333333";
    await db.query("insert into companies values($1)", [otherCompany]);
    await db.exec(`create function inject_match_collision() returns trigger language plpgsql as $$ begin
      if pg_trigger_depth()=1 and new.company_id='${otherCompany}'::uuid then
        insert into company_government_matches(company_id,government_entity_id,match_status,match_method,confidence,evidence)
         values(new.company_id,new.government_entity_id,'rejected','manual',1,'{"reason":"explicit"}');
      end if; return new; end $$;
      create trigger test_match_collision before insert on company_government_matches for each row execute function inject_match_collision();`);
    const result = await match(id, native, otherCompany);
    assert.equal(result.disposition, "preserved_rejected"); assert.equal(result.match.match_method, "manual");
  });
  await test("identity mutation RPCs are executable only by the service role", async () => {
    for (const signature of ["government_identity_save_entity(jsonb)", "government_identity_save_match(uuid,uuid,jsonb)"]) {
      assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE') value", [signature]), false);
      assert.equal(await scalar("select has_function_privilege('authenticated',$1,'EXECUTE') value", [signature]), false);
      assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value", [signature]), true);
    }
  });
  console.log(JSON.stringify({ passed: true, checks: passed }));
} finally { await db.close(); }
