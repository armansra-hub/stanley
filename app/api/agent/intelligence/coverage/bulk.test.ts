import { beforeEach, describe, expect, it, vi } from "vitest";
const id = "2520364d-2ee3-4763-8f0c-65d26780faf4";
const talId = "6395f1cf-ea7d-47a3-a3e0-3cba9e422ef4";
const absentId = "77777777-7777-4777-8777-777777777777";
const m = vi.hoisted(() => ({ auth: true, rows: {} as Record<string, Record<string, unknown>[]>,
  counts: {} as Record<string, number | null>, errorTable: "", calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: () => m.auth, unauthorized: () => new Response("{}", { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: (table: string) => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "or", "in", "eq", "gt", "order", "limit"]) chain[method] = (...args: unknown[]) => {
    m.calls.push({ table, method, args }); return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: m.rows[table] ?? [],
    count: Object.hasOwn(m.counts, table) ? m.counts[table] : (m.rows[table] ?? []).length,
    error: m.errorTable === table ? { message: "PRIVATE_DATABASE_ERROR" } : null }).then(resolve);
  return chain;
} }) }));
import * as route from "./route";
import { COMPANY_FIELDS, SOURCE_FIELDS, membershipFilter, parseCoverageQuery, sourceProjection } from "@/lib/intelligence/manualCoverage";
const req = (query: string) => new Request(`https://stanley.test/api/agent/intelligence/coverage?${query}`);
const query = (ids = [id, talId]) => `view=sources&companyIds=${ids.join(",")}`;
const tam = { id, name: "Current TAM", lists: ["netsuite_tam"], status: "new", tal_claimed: false, last_checked_at: "2026-10-07T12:00:00Z" };
const tal = { id: talId, name: "Retained TAL", lists: ["tam_removed"], status: "removed_from_tam", tal_claimed: true };
const source = (companyId = id, key = "news:google") => ({ company_id: companyId, source_key: key, complete: true,
  coverage_status: "empty", last_attempt_at: "2026-10-07T12:00:00Z", last_success_at: "2026-10-07T12:00:00Z",
  next_attempt_at: null, last_error: null, cursor: { pending: [], retries: {}, seen: [] } });
beforeEach(() => {
  m.auth = true; m.rows = { companies: [tam, tal], intelligence_source_state: [source()] }; m.counts = {}; m.calls = []; m.errorTable = "";
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider fetch is allowed"); }));
});

describe("bounded bulk source checkpoint reads", () => {
  it("authenticates before any bulk data access and remains GET-only without providers or writes", async () => {
    m.auth = false;
    expect((await route.GET(req(query()))).status).toBe(401); expect(m.calls).toEqual([]);
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"].sort());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads only exact eligible IDs in two queries, preserving removed claimed TAL and truthful empty metadata", async () => {
    const response = await route.GET(req(query([talId, id, absentId]))); const body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.requestedCompanyIds).toEqual([talId, id, absentId]);
    expect(body.accounts).toHaveLength(3);
    expect(body.accounts[0]).toMatchObject({ companyId: talId, inScope: true, company: { tal_claimed: true, status: "removed_from_tam" }, rows: [], checkpointPageComplete: true, page: { partial: false, nextAfter: null } });
    expect(body.accounts[1]).toMatchObject({ companyId: id, company: { last_checked_at: tam.last_checked_at }, rows: [sourceProjection(source())] });
    expect(body.accounts[2]).toEqual({ companyId: absentId, inScope: false, reason: "company_not_in_scope", company: null, rows: null, page: null, checkpointPageComplete: false });
    expect(body).toMatchObject({ sourceCount: 1, coverageVerified: false, page: { partial: false, nextAfter: null, limit: 1000 } });
    expect(m.calls).toContainEqual({ table: "companies", method: "select", args: [COMPANY_FIELDS, { count: "exact" }] });
    expect(m.calls).toContainEqual({ table: "companies", method: "or", args: [membershipFilter("all")] });
    expect(m.calls).toContainEqual({ table: "companies", method: "in", args: ["id", [talId, id, absentId]] });
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "select", args: [SOURCE_FIELDS, { count: "exact" }] });
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "in", args: ["company_id", [id, talId]] });
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "limit", args: [1000] });
    expect(m.calls.filter(call => call.method === "select")).toHaveLength(2);
    expect(m.calls.every(call => ["select", "or", "in", "order", "limit"].includes(call.method))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("represents an entirely out-of-scope set without reading source state", async () => {
    m.rows.companies = [];
    const body = await (await route.GET(req(query()))).json();
    expect(body.sourceCount).toBe(0); expect(body.accounts.every((row: { inScope: boolean; rows: null }) => row.inScope === false && row.rows === null)).toBe(true);
    expect(m.calls.every(call => call.table === "companies")).toBe(true);
  });

  it.each(["tam", "tal"] as const)("preserves the explicit %s membership scope", async scope => {
    m.rows.companies = [scope === "tam" ? tam : tal];
    m.rows.intelligence_source_state = [];
    const response = await route.GET(req(`${query()}&scope=${scope}`)); const body = await response.json();
    expect(response.status).toBe(200); expect(body.scope).toBe(scope);
    expect(body.accounts.map((row: { inScope: boolean }) => row.inScope)).toEqual(scope === "tam" ? [true, false] : [false, true]);
    expect(m.calls).toContainEqual({ table: "companies", method: "or", args: [membershipFilter(scope)] });
  });

  it("retains all source states and projected dates/counts, including incomplete and unavailable captures", async () => {
    const partial = { ...source(id, "website"), complete: false, coverage_status: "partial", last_error: "PRIVATE_ERROR",
      next_attempt_at: "2026-10-09T12:00:00Z", cursor: { pendingUrls: ["PRIVATE_URL"], consecutiveFailures: 2,
        revisit: { quietRuns: 4, intervalHours: 24, nextDueAt: "2026-10-09T12:00:00Z", lastChangedAt: "2026-10-06T12:00:00Z" } } };
    m.rows.intelligence_source_state = [source(), partial, { ...source(talId, "fmcsa"), complete: false, coverage_status: "unavailable", last_error: "PRIVATE_ERROR" }];
    const body = await (await route.GET(req(query()))).json();
    expect(body.accounts[0].rows).toHaveLength(2);
    expect(body.accounts[0].rows[1]).toMatchObject({ complete: false, coverage_status: "partial", hasError: true,
      next_attempt_at: "2026-10-09T12:00:00Z", cursor: { counts: { pendingUrls: 1 } },
      continuation: { consecutiveFailures: 2, revisit: partial.cursor.revisit } });
    expect(body.accounts[1].rows[0]).toMatchObject({ complete: false, coverage_status: "unavailable", hasError: true });
    expect(body.coverageVerified).toBe(false); expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  it("uses the same sanitized projection without raw cursors, provider identifiers or nested revisit data", async () => {
    const raw = { ...source(), token: "PRIVATE", error_details: "PRIVATE", cursor: { token: "PRIVATE", requestId: "PRIVATE",
      pending: ["PRIVATE"], retries: { PRIVATE: {} }, rawCaptures: [{ secret: "PRIVATE" }],
      revisit: { quietRuns: { token: "PRIVATE" }, intervalHours: ["PRIVATE"], nextDueAt: { token: "PRIVATE" }, lastChangedAt: "PRIVATE" } } };
    m.rows.intelligence_source_state = [raw];
    const body = await (await route.GET(req(query()))).json();
    expect(body.accounts[0].rows).toEqual([sourceProjection(raw)]);
    expect(body.accounts[0].rows[0].continuation.revisit).toEqual({ quietRuns: null, intervalHours: null, nextDueAt: null, lastChangedAt: null });
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  it("returns explicit overflow without rows or missing-state claims, never silently truncating", async () => {
    m.counts.intelligence_source_state = 1001;
    const response = await route.GET(req(query())); const body = await response.json();
    expect(response.status).toBe(413);
    expect(body).toMatchObject({ error: "bulk_source_limit_exceeded", sourceRowsReturned: false, sourceCount: 1001, limit: 1000, coverageVerified: false });
    expect(body.accounts).toBeUndefined(); expect(body.rows).toBeUndefined();
  });

  it("returns exactly 1000 source rows when the exact total fits, including each account boundary", async () => {
    m.rows.intelligence_source_state = Array.from({ length: 1000 }, (_, i) => source(i < 500 ? id : talId, `news:feed-${i}`));
    const response = await route.GET(req(query())); const body = await response.json();
    expect(response.status).toBe(200); expect(body.sourceCount).toBe(1000);
    expect(body.accounts.map((row: { rows: unknown[] }) => row.rows.length)).toEqual([500, 500]);
    expect(body.accounts.every((row: { checkpointPageComplete: boolean }) => row.checkpointPageComplete)).toBe(true);
    expect(body.coverageVerified).toBe(false);
  });

  it.each(["companies", "intelligence_source_state"])("fails closed on a backend row cap or missing exact count for %s", async table => {
    m.counts[table] = (m.rows[table]?.length ?? 0) + 1;
    expect((await route.GET(req(query()))).status).toBe(503);
    m.counts[table] = null;
    expect((await route.GET(req(query()))).status).toBe(503);
  });

  it.each(["companies", "intelligence_source_state"])("fails closed on %s read failure without private error details", async table => {
    m.errorTable = table;
    const response = await route.GET(req(query())); const body = await response.json();
    expect(response.status).toBe(503); expect(body.coverageVerified).toBe(false); expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  it.each(["outside", "duplicate", "tam_duplicate", "removed_not_tal"])("rejects an unexpected returned company: %s", async kind => {
    m.rows.companies = kind === "outside" ? [{ ...tam, id: absentId }] : kind === "duplicate" ? [tam, tam]
      : kind === "tam_duplicate" ? [{ ...tal, lists: ["tam_duplicate"] }] : [{ ...tal, tal_claimed: false }];
    expect((await route.GET(req(query()))).status).toBe(503);
    expect(m.calls.some(call => call.table === "intelligence_source_state")).toBe(false);
  });

  it.each(["outside", "duplicate", "missing_key"])("rejects unexpected source binding: %s", async kind => {
    m.rows.intelligence_source_state = kind === "outside" ? [source(absentId)] : kind === "duplicate" ? [source(), source()] : [{ ...source(), source_key: "" }];
    expect((await route.GET(req(query()))).status).toBe(503);
  });

  it("keeps the singleton source response and paging contract", async () => {
    m.rows.companies = [tam];
    const response = await route.GET(req(`view=sources&companyId=${id}&after=news:google&limit=1`)); const body = await response.json();
    expect(response.status).toBe(200); expect(body.accounts).toBeUndefined();
    expect(body).toMatchObject({ company: { id }, rows: [sourceProjection(source())], page: { partial: false, nextAfter: null, limit: 1 } });
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "gt", args: ["source_key", "news:google"] });
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "limit", args: [2] });
  });
});

describe("explicit bulk coverage query bounds", () => {
  it("accepts 1–100 exact IDs, normalizes UUID case and applies a total-row cap only to bulk", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${i.toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc`);
    expect(parseCoverageQuery(new URLSearchParams(query(ids)))).toMatchObject({ companyIds: ids, companyId: null, limit: 1000 });
    expect(parseCoverageQuery(new URLSearchParams(query([id.toUpperCase()])+"&limit=7"))).toMatchObject({ companyIds: [id], limit: 7 });
    expect(parseCoverageQuery(new URLSearchParams(`view=sources&companyId=${id}`))).not.toHaveProperty("companyIds");
  });
  it.each([
    "view=sources&companyIds=", `view=sources&companyIds=${id},`, `view=sources&companyIds=${id},${id.toUpperCase()}`,
    `${query()}&companyIds=${id}`, `${query()}&companyId=${id}`, `${query()}&after=`, `${query()}&after=news:google`,
    `${query()}&observationId=${id}`, `${query()}&sourceKey=fmcsa`, `${query()}&limit=1001`, `${query()}&limit=0`,
    `${query()}&limit=2.5`, `${query()}&limit=2&limit=3`, `companyIds=${id}`, `view=evidence&companyIds=${id}`,
    `view=jobs&companyIds=${id}`, `view=registry-capture&companyIds=${id}&sourceKey=fmcsa`,
    `view=sources&companyIds=${Array.from({ length: 101 }, (_, i) => `${i.toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc`).join(",")}`,
  ])("rejects invalid bulk scope before any read: %s", async value => {
    expect((await route.GET(req(value))).status).toBe(400); expect(m.calls).toEqual([]);
  });
});
