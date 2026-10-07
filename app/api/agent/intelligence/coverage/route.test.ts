import { beforeEach, describe, expect, it, vi } from "vitest";
const id = "2520364d-2ee3-4763-8f0c-65d26780faf4";
const other = "6395f1cf-ea7d-47a3-a3e0-3cba9e422ef4";
const m = vi.hoisted(() => ({ auth: true, rows: {} as Record<string, Record<string, unknown>[]>,
  error: false, identity: null as unknown, identityError: false, calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: () => m.auth, unauthorized: () => new Response("{}", { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({
  rpc: async (name: string, args: unknown) => { m.calls.push({ table: name, method: "rpc", args: [args] });
    return { data: m.identity, error: m.identityError ? {} : null }; },
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "or", "eq", "gt", "order", "limit"]) chain[method] = (...args: unknown[]) => {
      m.calls.push({ table, method, args }); return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: m.rows[table] ?? [], error: m.error ? {} : null }).then(resolve);
    return chain;
  },
}) }));
import * as route from "./route";
import { membershipFilter, parseCoverageQuery } from "@/lib/intelligence/manualCoverage";
const req = (query = "") => new Request(`https://stanley.test/api/agent/intelligence/coverage?${query}`);
beforeEach(() => { m.auth = true; m.error = false; m.identityError = false; m.calls = []; m.rows = { companies: [{ id, name: "Account", domain: "account.test" }] }; m.identity = { record: { id, header: "Account identity header", capturedAt: "2026-10-01T00:00:00Z" }, websites: [{ id: other, url: "https://account.test/about", capturedAt: "2026-10-02T00:00:00Z", identity: { names: ["Account"], addresses: [{ addressLine1: "123 Main St", city: "Denver", state: "CO", postalCode: "80202", countryCode: "US" }] } }], claims: [] }; });
describe("read-only canonical coverage", () => {
  it("authenticates before data access and exports only GET", async () => {
    m.auth = false; expect((await route.GET(req())).status).toBe(401); expect(m.calls).toEqual([]);
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"].sort());
  });
  it.each(["view=oops", "token=secret", "limit=0", "limit=101", "limit=1&limit=2", "after=bad",
    "view=evidence", `view=evidence&companyId=${id}&limit=11`, `view=jobs&companyId=${id}`,
    `companyId=${id}`, `view=sources&companyId=${id}&after=bad%26filter`])("rejects malformed query %s before reading", async query => {
    expect((await route.GET(req(query))).status).toBe(400); expect(m.calls).toEqual([]);
  });
  it("includes independent TAL and current TAM, excluding duplicates in both branches", () => {
    const filter = membershipFilter("all");
    expect(filter).toContain("and(tal_claimed.eq.true,or(lists.is.null,lists.not.cs.{tam_duplicate}))");
    expect(filter).toContain("status.neq.removed_from_tam"); expect(filter).not.toContain("status.is.null");
    expect(membershipFilter("tal")).not.toContain("removed_from_tam");
  });
  it("uses stable keyset paging with explicit continuation and no false coverage success", async () => {
    m.rows.companies = [{ id }, { id: other }];
    const response = await route.GET(req(`limit=1&after=${id}`)); const body = await response.json();
    expect(body).toMatchObject({ page: { partial: true, nextAfter: id, limit: 1 }, coverageVerified: false });
    expect(m.calls).toContainEqual({ table: "companies", method: "gt", args: ["id", id] });
    expect(m.calls).toContainEqual({ table: "companies", method: "limit", args: [2] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns every retained evidence character, original dates and identity; excludes operational metadata", async () => {
    const text = "original😀\n".repeat(7000);
    m.rows.intelligence_observations = [{ id: other, evidence_text: text, event_date: null, observed_at: "2026-10-07T00:00:00Z",
      metadata: { textTruncated: true, providerRequest: "SECRET", sourceCharacters: 90000,
        discovery: { url: "https://publisher.test/story", token: "SECRET" } },
      sections: [{ id: "s1", start: 0, end: text.length, text, lease_token: "SECRET" }] }];
    const body = await (await route.GET(req(`view=evidence&companyId=${id}`))).json();
    expect(body.rows[0].evidence_text).toBe(text); expect(body.rows[0].sections[0].text).toBe(text);
    expect(body.rows[0]).toMatchObject({ responseTextTruncated: false, originalCompleteness: "truncated", event_date: null });
    expect(body.identity.addresses[0]).toMatchObject({ addressLine1: "123 Main St", sourceId: other, capturedAt: "2026-10-02T00:00:00Z" }); expect(body.identity).toMatchObject({ available: true, complete: false, upstreamLimits: { recordHeaderCharacters: 6000, websites: 8, claims: 20 } }); expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(body.page).toMatchObject({ partial: false, nextAfter: null });
  });
  it("projects source debt counts without leaking raw cursors or error bodies", async () => {
    m.rows.intelligence_source_state = [{ source_key: "news:google", complete: false, last_error: "SECRET",
      cursor: { offset: 4, pending: ["SECRET"], retries: { SECRET: {} }, token: "SECRET", requestId: "SECRET" } }];
    const body = await (await route.GET(req(`view=sources&companyId=${id}&after=news:google`))).json();
    expect(body.rows[0]).toMatchObject({ hasError: true, cursor: { counts: { pending: 1, retries: 1 }, position: { offset: 4 } } });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(m.calls).toContainEqual({ table: "intelligence_source_state", method: "gt", args: ["source_key", "news:google"] });
  });
  it("returns sanitized jobs and never asserts claim eligibility", async () => {
    m.rows.intelligence_observations = [{ id: other, source_kind: "news" }];
    m.rows.intelligence_jobs = [{ id, kind: "interpret", status: "queued", codex_news_request_id: "SECRET", lease_token: "SECRET", result: { pendingRequest: "SECRET" } }];
    const body = await (await route.GET(req(`view=jobs&companyId=${id}&observationId=${other}`))).json();
    expect(body.rows[0]).toMatchObject({ alreadyCodexClaimed: true, reviewKind: "codex_source", admissionVerified: false });
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(m.calls.every(call => !["insert", "update", "upsert", "delete"].includes(call.method))).toBe(true);
  });
  it("fails closed on missing membership and database errors", async () => {
    m.rows.companies = []; expect((await route.GET(req(`view=evidence&companyId=${id}`))).status).toBe(404);
    m.error = true; expect((await route.GET(req())).status).toBe(503);
  });
  it("accepts all documented query views", () => {
    expect(parseCoverageQuery(new URLSearchParams(`view=jobs&companyId=${id}&observationId=${other}`)).view).toBe("jobs");
  });
  it("labels null identity unavailable and fails closed on RPC failure or an invented shape", async () => {
    m.identity = null;
    let response = await route.GET(req(`view=evidence&companyId=${id}`));
    expect((await response.json()).identity).toMatchObject({ available: false, complete: false });
    m.identity = { aliases: [], addresses: [], context: "invented" };
    expect((await route.GET(req(`view=evidence&companyId=${id}`))).status).toBe(503);
    m.identityError = true;
    expect((await route.GET(req(`view=evidence&companyId=${id}`))).status).toBe(503);
  });
  it.each(["website", "job"])("retains %s collector provenance and labels its interpretation kind", async sourceKind => {
    m.rows.intelligence_observations = [{ id: other, source_kind: sourceKind, evidence_text: "whole source", metadata: {
      meaningfulContentHash: "a".repeat(64), collectionMode: "baseline", descriptionAvailable: true, atsType: "greenhouse",
      atsToken: "public-board", atsJobKey: "job-1", jobDateKind: "updated", atsRoleCategories: ["finance"],
      discovery: { collector: sourceKind, requestedUrls: ["https://account.test/jobs"] },
    } }];
    const evidence = await (await route.GET(req(`view=evidence&companyId=${id}`))).json();
    expect(evidence.rows[0].metadata).toMatchObject({ descriptionAvailable: true, atsType: "greenhouse", atsJobKey: "job-1", atsBoardIdentifierPresent: true, collectionMode: "baseline" });
    expect(evidence.rows[0].metadataFieldsOmitted).toContain("atsToken");
    m.rows.intelligence_jobs = [{ id, kind: "interpret", status: "queued" }];
    const jobs = await (await route.GET(req(`view=jobs&companyId=${id}&observationId=${other}`))).json();
    expect(jobs.rows[0]).toMatchObject({ reviewKind: "codex_source", admissionVerified: false });
  });
});
