import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JEV_CLASSIFIER_SOURCES, jevPaidPurposeAllowed } from "./jevPurposePolicy";

const allowed = Object.entries(JEV_CLASSIFIER_SOURCES).flatMap(([purpose, sources]) => sources.map(sourceKind => ({ purpose, sourceKind })));
const retired = [
  { purpose: "operating_catalog", sourceKind: "customer_reference" },
  { purpose: "private_tam", sourceKind: "private_excerpt" },
  { purpose: "saved_view", sourceKind: "account_question_answer" },
  { purpose: "saved_view", sourceKind: "website" },
  { purpose: "research_ranking", sourceKind: "catalog_research_options" },
  { purpose: "codex_connector", sourceKind: "codex_public" },
  { purpose: "public_interpretation", sourceKind: "customer_reference" },
  { purpose: "public_interpretation", sourceKind: null },
  { purpose: "public_interpretation", sourceKind: "Website" },
  { purpose: "federal_identity", sourceKind: "website" },
];

describe("paid classifier scope", () => {
  it.each(allowed)("retains the useful classifier $purpose / $sourceKind", context => {
    expect(jevPaidPurposeAllowed(context)).toBe(true);
  });
  it.each(retired)("retires or rejects $purpose / $sourceKind", context => {
    expect(jevPaidPurposeAllowed(context)).toBe(false);
  });
  it("does not infer authorization from missing or prototype property attribution", () => {
    for (const context of [null, undefined, {}, { purpose: "constructor", sourceKind: "website" }, { purpose: "public_interpretation" }])
      expect(jevPaidPurposeAllowed(context)).toBe(false);
  });
});

// Real offline PostgreSQL exercises the two transactional gates, not merely
// migration text. This uses the repository's already installed SQL test runtime.
const requireSql = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url));
const { PGlite } = requireSql("@electric-sql/pglite");
describe("classifier SQL admission and saved-answer retention", () => {
  let db: InstanceType<typeof PGlite>;
  const company = randomUUID(), view = randomUUID(), observation = randomUUID(), key = () => randomUUID().replaceAll("-", "").repeat(2);
  const answer = { ok: true, usage: { inputTokens: 123, outputTokens: 1 }, provider_result: { answers: { original: { choice: "retained" } } } };
  let old: { fingerprint: string; reservationId: string; leaseToken: string };
  let saved: { fingerprint: string; reservationId: string; leaseToken: string };
  let historicalQuestion: unknown;
  const scalar = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0]?.value;
  const claim = (purpose: string, sourceKind: string, fingerprint = key()) => scalar(
    "select intelligence_jev_claim($1,$2,$3,null,$4,'monitoring') value", [fingerprint, purpose, company, sourceKind]);
  const dispatch = (ticket: typeof old) => scalar("select intelligence_jev_dispatch($1,$2,$3,'jev-1.13.0') value",
    [ticket.fingerprint, ticket.reservationId, ticket.leaseToken]);
  beforeAll(async () => {
    db = await PGlite.create("memory://");
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table companies(id uuid primary key,status text not null);
      create table trigger_candidates(id uuid primary key,created_at timestamptz,verdict text,promoted_trigger_id uuid);`);
    for (const name of ["0059_intelligence_evidence_and_work.sql", "0082_jev_request_receipts.sql", "0090_native_jev_purposes.sql",
      "0117_jev_global_budget_policy.sql", "0123_jev_provider_balance_mode.sql"])
      await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"));
    await db.exec("alter table companies add column name text; alter table intelligence_observations add column feedback_excluded boolean not null default false");
    const questionMigration = await readFile(new URL("../../supabase/migrations/0087_research_event_account_questions.sql", import.meta.url), "utf8");
    await db.exec(questionMigration.slice(questionMigration.indexOf("-- Saved questions now combine")));
    await db.query("insert into companies(id,name,status) values($1,'Synthetic Services','new')", [company]);
    await db.query("insert into intelligence_views(id,name,question) values($1,'Legacy question','Does the company serve agencies?')", [view]);
    await db.query("insert into intelligence_observations(id,company_id,source_key,source_kind,source_url,title,evidence_text,content_hash) values($1,$2,'source','website','https://example.test/','Services','Original full evidence','old-hash')", [observation, company]);
    await db.query("update intelligence_account_question_jobs set checkpoint=$2::jsonb,status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes' where view_id=$1", [view, { nativeReceipt: "keep" }]);
    historicalQuestion = await scalar("select to_jsonb(q) value from intelligence_account_question_jobs q where view_id=$1", [view]);
    await db.exec("update intelligence_config set enabled=true; update intelligence_jev_budget_policy set enabled=true,enforcement='provider_balance'");
    const oldKey = key(), savedKey = key();
    old = { ...await claim("research_ranking", "catalog_research_options", oldKey), fingerprint: oldKey };
    saved = { ...await claim("operating_catalog", "customer_reference", savedKey), fingerprint: savedKey };
    await scalar("select intelligence_jev_record($1,$2,$3,$4) value", [saved.fingerprint, saved.leaseToken, saved.reservationId, answer]);
    await db.exec("update intelligence_config set enabled=false; update intelligence_jev_budget_policy set enabled=false,halt_reason='user_pause'");
    await db.exec(await readFile(new URL("../../supabase/migrations/0134_jev_classifier_purpose_policy.sql", import.meta.url), "utf8"));
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it("installs without reopening the user's pause or rewriting old receipts", async () => {
    expect(await scalar("select enabled value from intelligence_config")).toBe(false);
    expect(await scalar("select enabled value from intelligence_jev_budget_policy")).toBe(false);
    expect(await scalar("select halt_reason value from intelligence_jev_budget_policy")).toBe("user_pause");
    expect(await scalar("select evaluation value from intelligence_jev_requests where fingerprint=$1", [saved.fingerprint])).toEqual(answer);
    expect((await claim("public_interpretation", "news")).reason).toBe("user_pause");
  });

  it("keeps TypeScript and SQL source-level authorization identical, including nulls", async () => {
    for (const context of [...allowed, ...retired])
      expect(await scalar("select intelligence_jev_classifier_allowed($1,$2) value", [context.purpose, context.sourceKind]))
        .toBe(jevPaidPurposeAllowed(context));
  });

  it("blocks retired work at reservation even in provider-balance mode", async () => {
    // Enabling only this in-memory fixture proves the funding mode cannot bypass scope.
    await db.exec("update intelligence_config set enabled=true; update intelligence_jev_budget_policy set enabled=true,halt_reason=null");
    const before = await scalar("select count(*)::int value from intelligence_spend");
    for (const context of retired) {
      const value = await scalar("select intelligence_jev_reserve_policy($1,$2,$3,null,$4,$5,'monitoring') value",
        [randomUUID(), context.purpose, company, context.sourceKind, key()]);
      expect(value).toMatchObject({ status: "budget_deferred", reason: "purpose_retired", retryAt: null });
    }
    expect(await scalar("select count(*)::int value from intelligence_spend")).toBe(before);
  });

  it("rechecks old tickets at dispatch, then admits one exact useful classifier only once", async () => {
    expect(await dispatch(old)).toMatchObject({ status: "budget_deferred", reason: "purpose_retired" });
    expect(await scalar("select dispatched_at value from intelligence_spend where id=$1", [old.reservationId])).toBeNull();
    for (const context of allowed) {
      const fingerprint = key(), ticket = { ...await claim(context.purpose, context.sourceKind, fingerprint), fingerprint };
      expect(ticket.status).toBe("execute");
      expect((await dispatch(ticket)).status).toBe("authorized");
      expect((await dispatch(ticket)).status).toBe("budget_deferred");
    }
  });

  it("keeps the exact cached customer answer accessible without reservation and rejects another account's read", async () => {
    const before = await scalar("select count(*)::int value from intelligence_spend");
    expect(await scalar("select intelligence_jev_cached($1,'operating_catalog',$2) value", [saved.fingerprint, company]))
      .toEqual({ status: "complete", evaluation: answer, reservationId: saved.reservationId, reused: true });
    expect(await scalar("select intelligence_jev_cached($1,'operating_catalog',$2) value", [saved.fingerprint, randomUUID()])).toBeNull();
    expect(await scalar("select intelligence_jev_cached($1,'operating_catalog',$2) value", [key(), company])).toBeNull();
    expect((await claim("operating_catalog", "customer_reference", saved.fingerprint)).evaluation).toEqual(answer);
    expect(await scalar("select count(*)::int value from intelligence_spend")).toBe(before);
  });

  it("does not expose old unrestricted reservation functions or cache answers to public roles", async () => {
    for (const role of ["anon", "authenticated"])
      expect(await scalar("select has_function_privilege($1,'intelligence_jev_cached(text,text,uuid)','EXECUTE') value", [role])).toBe(false);
    expect(await scalar("select has_function_privilege('service_role','intelligence_jev_cached(text,text,uuid)','EXECUTE') value")).toBe(true);
    expect(await scalar("select has_function_privilege('service_role','intelligence_jev_reserve_before_classifier_policy(uuid,text,uuid,uuid,text,text,text)','EXECUTE') value")).toBe(false);
  });

  it("retires saved-question admission without touching history or blocking Trigger interpretation", async () => {
    await scalar("select intelligence_account_question_enqueue($1,$2) value", [view, company]);
    expect(await scalar("select intelligence_account_question_claim() value")).toBeNull();
    expect(await scalar("select intelligence_backfill_view($1,100) value", [view])).toBe(0);
    await db.query("update intelligence_observations set is_current=false where id=$1", [observation]);
    await db.query("insert into intelligence_jobs(operation_key,observation_id,view_id,kind) values('legacy-view',$1,$2,'view')", [observation, view]);
    expect(await scalar("select count(*)::int value from intelligence_jobs where kind='view'")).toBe(0);
    expect(await scalar("select to_jsonb(q) value from intelligence_account_question_jobs q where view_id=$1", [view])).toEqual(historicalQuestion);
    await db.query("insert into intelligence_jobs(operation_key,observation_id,kind) values('trigger-source',$1,'interpret')", [observation]);
    expect(await scalar("select count(*)::int value from intelligence_jobs where kind='interpret' and operation_key='trigger-source'")).toBe(1);
    expect(await scalar("select backfill_complete value from intelligence_views where id=$1", [view])).toBe(false);
  });
});
