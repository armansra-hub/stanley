import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }), withServiceDeadline: (_: number, fn: () => unknown) => fn() }));
vi.mock("@/lib/companyIdentity", () => ({ enrichCompanyIdentity: async (company: object) => ({ ...company, legalNames: [], addresses: [] }) }));
vi.mock("./http", async original => ({ ...await original<typeof import("./http")>(), fetchJson: mocks.fetch }));
vi.mock("./federalIdentityResolution", () => ({ resolveFederalIdentity: mocks.resolve, FederalIdentityDeferredError: class extends Error {} }));
import { captureFederalPendingSource, federalSourceOnlyHash, FederalCaptureReadbackRequired } from "./federalDiscoverySourceOnly";
import { federalDiscoveryCompanyIdentity } from "./federalDiscovery";
import { parseFederalDiscoveryContinuation, type FederalDiscoveryContinuation } from "./federalDiscoveryState";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = { id: id(1), name: "Acme Aerospace", domain: "acme.example", website_raw: null, city: "Austin", state: "TX",
  netsuite_internal_id: "123", lists: ["netsuite_tam"], status: "new", tal_claimed: false };
const state = (): FederalDiscoveryContinuation => ({ version: 1, companyId: id(1), companyIdentity: federalDiscoveryCompanyIdentity(company),
  searchEndDate: "2026-09-29", targets: [{ query: company.name, identity: null }], targetIndex: 0, page: 1,
  candidate: null, lastPageHash: null, searchAfter: null });
const sourceRow = { generated_internal_id: "AWARD1", "Award ID": "PIID1", "Recipient Name": company.name,
  "Recipient UEI": "ABCDEFGHIJKL", "Start Date": "2025-04-03", unknownPublicField: { retained: "all  characters" } };
const page = () => ({ results: [sourceRow], page_metadata: { hasNext: false }, unknownEnvelope: "original" });
const detail = () => ({ generated_unique_award_id: "AWARD1", piid: "PIID1", type: "D", total_obligation: 10,
  recipient: { recipient_name: company.name, recipient_uei: "ABCDEFGHIJKL", recipient_hash: "recipient1", location: { city_name: "Austin" } },
  period_of_performance: { start_date: "2025-04-03", end_date: "2027-03-31" }, unknownDetail: "full original" });
// Test adapter permits only reads plus the existing observation RPC.
/* eslint-disable @typescript-eslint/no-explicit-any */
let tables: Record<string, any[]>;
let rpcUncertain = false, badReadback = false, jobMissing = false;
function query(table: string) {
  if (!["companies", "company_government_matches", "intelligence_observations", "intelligence_jobs"].includes(table)) throw new Error(`Forbidden table ${table}`);
  const filters: Record<string, unknown> = {};
  let single = false, cap = Infinity;
  const q: any = { select: (columns: string) => {
      if (table === "intelligence_jobs" && columns.split(",").includes("company_id")) throw new Error("column intelligence_jobs.company_id does not exist");
      return q;
    }, eq: (key: string, value: unknown) => {
      if (table === "intelligence_jobs" && key === "company_id") throw new Error("column intelligence_jobs.company_id does not exist");
      filters[key] = value; return q;
    },
    limit: (value: number) => { cap = value; return q; }, maybeSingle: () => { single = true; return q; },
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve().then(() => {
      let rows = tables[table].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)).slice(0, cap);
      if (table === "intelligence_jobs" && jobMissing) rows = [];
      if (table === "intelligence_observations" && badReadback && rows.length) return { data: null, error: { code: "readback_failed" } };
      return { data: structuredClone(single ? rows[0] ?? null : rows), error: null };
    }).then(resolve, reject) };
  return q;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  tables = { companies: [structuredClone(company)], company_government_matches: [], intelligence_observations: [], intelligence_jobs: [] };
  rpcUncertain = false; badReadback = false; jobMissing = false; mocks.from.mockImplementation(query); mocks.fetch.mockResolvedValue(page());
  mocks.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe("intelligence_observe");
    const observationId = id(100 + tables.intelligence_observations.length);
    tables.intelligence_observations.push({ id: observationId, company_id: args.p_company, source_key: args.p_source_key,
      source_kind: args.p_source_kind, source_url: args.p_url, evidence_text: args.p_text, metadata: args.p_metadata,
      observed_at: args.p_observed_at, is_current: true });
    tables.intelligence_jobs.push({ id: id(200 + tables.intelligence_jobs.length),
      observation_id: observationId, kind: "interpret", status: "queued", attempts: 0, lease_token: null, lease_until: null, finished_at: null, codex_news_request_id: null });
    return rpcUncertain ? { data: null, error: { code: "timeout_after_write" } } : { data: { id: observationId, queued: true }, error: null };
  });
});
afterEach(() => { expect(mocks.resolve).not.toHaveBeenCalled(); vi.unstubAllEnvs(); });

describe("federal pending source-only collection", () => {
  it("binds jobs through the real0059 observation FK; the deployed erroneous company column is rejected by PostgreSQL", async () => {
    const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
    const db = await PGlite.create("memory://");
    try {
      const migration = await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8");
      const jobDefinition = migration.match(/create table public\.intelligence_jobs \([\s\S]*?\n\);/)?.[0];
      expect(jobDefinition).toBeTruthy();
      await db.exec("create table public.intelligence_observations(id uuid primary key,company_id uuid not null); create table public.intelligence_views(id uuid primary key);");
      await db.exec(jobDefinition!);
      await db.query("insert into intelligence_observations(id,company_id) values($1,$2)", [id(100),id(1)]);
      await db.query("insert into intelligence_jobs(id,observation_id,operation_key,kind) values($1,$2,'known-original','interpret')", [id(200),id(100)]);
      await expect(db.query("select id,company_id,observation_id,kind,status from intelligence_jobs where company_id=$1 and observation_id=$2", [id(1),id(100)])).rejects.toThrow(/company_id/);
      const result = await db.query("select id,observation_id,kind,status from intelligence_jobs where observation_id=$1 and kind='interpret' limit 2", [id(100)]);
      expect(result.rows).toEqual([{ id:id(200),observation_id:id(100),kind:"interpret",status:"queued" }]);
    } finally { await db.close(); }
  });
  it("captures one full search original and canonical job, preserving candidate identity/date/unknown fields", async () => {
    const result = await captureFederalPendingSource(id(1), state(), id(10));
    expect(result).toMatchObject({ status: "incomplete", sourceRequests: 1, sourceCaptured: true, analysisComplete: false,
      identityVerified: false, historyComplete: false, reason: "search_captured_detail_pending", observationId: id(100), jobId: id(200) });
    expect(result.continuation.candidate).toEqual({ id: "AWARD1", name: company.name, uei: "ABCDEFGHIJKL" });
    expect(result.continuation.sourceCapture?.status).toBe("pending");
    expect(JSON.parse(tables.intelligence_observations[0].evidence_text)).toEqual(page());
    expect(tables.intelligence_observations[0]).toMatchObject({ source_kind: "government", metadata: { originalHttpBytesRetained: false, analysisComplete: false, identityVerified: false } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0].slice(2, 4)).toEqual([20_000, 1]);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(parseFederalDiscoveryContinuation(result.continuation, id(1))).toEqual(result.continuation);
  });
  it("reuses the exact retained original without another provider or observation write", async () => {
    const first = await captureFederalPendingSource(id(1), state(), id(10));
    mocks.fetch.mockClear(); mocks.rpc.mockClear();
    const reused = await captureFederalPendingSource(id(1), state(), id(11));
    expect(reused).toMatchObject({ sourceRequests: 0, reusedCapture: true, observationId: first.observationId, jobId: first.jobId });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("retained-only recovery reads the exact operation/source/job with no provider or observation write", async () => {
    await captureFederalPendingSource(id(1), state(), id(10));
    const original = tables.intelligence_observations[0], job = tables.intelligence_jobs[0];
    const binding = { observationId: original.id, jobId: job.id, sourceKey: original.source_key,
      requestSha256: original.metadata.requestSha256, retainedJsonSha256: original.metadata.retainedJsonSha256 };
    mocks.fetch.mockClear(); mocks.rpc.mockClear();
    const outcome = await captureFederalPendingSource(id(1), state(), id(10), Date.now() + 60_000, binding);
    expect(outcome).toMatchObject({ sourceRequests: 0, sourceCaptured: true, reusedCapture: true, observationId: original.id, jobId: job.id });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["missing", "wrong-operation", "body", "source-key", "request", "before", "observation", "job", "attempted", "leased", "codex-claimed"])("retained-only mismatches never fall back to provider or storage writes: %s", async kind => {
    await captureFederalPendingSource(id(1), state(), id(10));
    const original = tables.intelligence_observations[0], job = tables.intelligence_jobs[0];
    const binding = { observationId: original.id, jobId: job.id, sourceKey: original.source_key,
      requestSha256: original.metadata.requestSha256, retainedJsonSha256: original.metadata.retainedJsonSha256 };
    if (kind === "missing") tables.intelligence_observations = [];
    if (kind === "wrong-operation") original.metadata.operationId = id(11);
    if (kind === "body") original.evidence_text = "{}";
    if (kind === "source-key") binding.sourceKey = "c".repeat(64);
    if (kind === "request") binding.requestSha256 = "c".repeat(64);
    if (kind === "before") original.metadata.continuationBefore.page++;
    if (kind === "observation") binding.observationId = id(999);
    if (kind === "job") binding.jobId = id(999);
    if (kind === "attempted") job.attempts = 1;
    if (kind === "leased") job.lease_token = id(999);
    if (kind === "codex-claimed") job.codex_news_request_id = id(999);
    mocks.fetch.mockClear(); mocks.rpc.mockClear();
    await expect(captureFederalPendingSource(id(1), state(), id(10), Date.now() + 60_000, binding)).rejects.toBeInstanceOf(FederalCaptureReadbackRequired);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fetches only one detail after its intact original search, then holds for actual independent review", async () => {
    const first = await captureFederalPendingSource(id(1), state(), id(10)); mocks.fetch.mockResolvedValue(detail());
    const result = await captureFederalPendingSource(id(1), first.continuation, id(11));
    expect(result).toMatchObject({ sourceRequests: 1, reason: "candidate_detail_captured_awaiting_independent_review", sourceCaptured: true });
    expect(result.continuation.sourceCapture?.status).toBe("held");
    expect(JSON.parse(tables.intelligence_observations[1].evidence_text)).toEqual(detail());
    await expect(captureFederalPendingSource(id(1), result.continuation, id(12))).rejects.toThrow("hold cannot be replayed");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["outside", "removed"])("includes canonical claimed TAL %s TAM", async kind => {
    tables.companies[0].tal_claimed = true; tables.companies[0].lists = [];
    if (kind === "removed") tables.companies[0].status = "removed_from_tam";
    expect((await captureFederalPendingSource(id(1), state(), id(10))).sourceCaptured).toBe(true);
  });
  it.each(["removed", "notmember", "duplicate", "identity-changed", "query-changed"])("holds unsafe company binding before provider: %s", async kind => {
    const original = state();
    if (kind === "removed") tables.companies[0].status = "removed_from_tam";
    if (kind === "notmember") tables.companies[0].lists = [];
    if (kind === "duplicate") { tables.companies[0].tal_claimed = true; tables.companies[0].lists.push("tam_duplicate"); }
    if (kind === "identity-changed") tables.companies[0].name = "Different Company";
    if (kind === "query-changed") original.targets[0].query = "Unrelated";
    expect((await captureFederalPendingSource(id(1), original, id(10))).continuation.sourceCapture?.status).toBe("held");
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not replay a legacy candidate whose original detail outcome is unknown", async () => {
    const original = state(); original.candidate = { id: "AWARD1", name: company.name, uei: "ABCDEFGHIJKL" };
    expect((await captureFederalPendingSource(id(1), original, id(10))).reason).toBe("legacy_candidate_requires_original_readback");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("holds provider failure once; no automatic retry or negative result", async () => {
    mocks.fetch.mockRejectedValue(new Error("503 private body"));
    const result = await captureFederalPendingSource(id(1), state(), id(10));
    expect(result).toMatchObject({ reason: "provider_unavailable_no_retry", status: "incomplete", sourceRequests: 1, sourceCaptured: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["empty-terminal", "empty-continue", "malformed", "identity-conflict"])("preserves truthful captured scope: %s", async kind => {
    const original = state();
    if (kind === "empty-terminal") original.collection = "idvs";
    if (kind.startsWith("empty")) mocks.fetch.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    if (kind === "malformed") mocks.fetch.mockResolvedValue({ error: "upstream shape changed" });
    if (kind === "identity-conflict") {
      const first = await captureFederalPendingSource(id(1), original, id(10));
      mocks.fetch.mockResolvedValue({ ...detail(), generated_unique_award_id: "OTHER" });
      expect((await captureFederalPendingSource(id(1), first.continuation, id(11))).reason).toBe("captured_detail_identity_conflict"); return;
    }
    const result = await captureFederalPendingSource(id(1), original, id(10));
    expect(result.sourceCaptured).toBe(true); expect(result.analysisComplete).toBe(false);
    expect(result.continuation.sourceCapture?.status).toBe(kind === "empty-continue" ? "pending" : "held");
    expect(parseFederalDiscoveryContinuation(result.continuation, id(1))).toBeTruthy();
  });
  it.each([60_000, 262_145])("fails closed before the observation RPC for an original of %i characters", async size => {
    mocks.fetch.mockResolvedValue({ ...page(), huge: "x".repeat(size) });
    expect((await captureFederalPendingSource(id(1), state(), id(10))).reason).toBe("source_exceeds_lossless_capture_bound");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["write-uncertain", "readback-unavailable", "job-missing", "original-changed"])("propagates exact write/readback uncertainty for the durable fence: %s", async kind => {
    if (kind === "write-uncertain") rpcUncertain = true;
    if (kind === "readback-unavailable") badReadback = true;
    if (kind === "job-missing") jobMissing = true;
    if (kind === "original-changed") {
      await captureFederalPendingSource(id(1), state(), id(10));
      tables.intelligence_observations[0].evidence_text = "{}"; mocks.fetch.mockClear();
    }
    await expect(captureFederalPendingSource(id(1), state(), id(10))).rejects.toBeInstanceOf(FederalCaptureReadbackRequired);
    expect(mocks.fetch).toHaveBeenCalledTimes(kind === "original-changed" ? 0 : 1);
  });
  it("hashes JSONB independent of object-key order while preserving array order", () => {
    expect(federalSourceOnlyHash({ b: [1, 2], a: { d: 2, c: 1 } })).toBe(federalSourceOnlyHash({ a: { c: 1, d: 2 }, b: [1, 2] }));
    expect(federalSourceOnlyHash([1, 2])).not.toBe(federalSourceOnlyHash([2, 1]));
    expect(federalSourceOnlyHash({})).toBe(createHash("sha256").update("{}").digest("hex"));
  });
  it("requires capture enabled before any database/provider action", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(captureFederalPendingSource(id(1), state(), id(10))).rejects.toThrow("disabled");
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
