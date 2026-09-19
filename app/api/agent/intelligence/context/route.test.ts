import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: true, enabled: true, companies: [{ id: "company", netsuite_internal_id: "123" }],
  rows: [] as Record<string, unknown>[], calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: () => m.auth, unauthorized: () => new Response("{}", { status: 401 }) }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => m.enabled }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: (table: string) => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "contains", "order", "limit"]) chain[method] = (...args: unknown[]) => {
    m.calls.push({ table, method, args }); return chain;
  };
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "companies" ? m.companies : m.rows, error: null }).then(resolve);
  return chain;
} }) }));
import { GET } from "./route";

beforeEach(() => { m.auth = true; m.enabled = true; m.companies = [{ id: "company", netsuite_internal_id: "123" }]; m.rows = []; m.calls = []; });
const request = (id = "123") => new Request(`https://stanley.test/api/agent/intelligence/context?internalId=${id}`);
describe("exact account public context for the local CRM comparison", () => {
  it("requires existing agent authentication and one exact ID", async () => {
    m.auth = false; expect((await GET(request())).status).toBe(401);
    m.auth = true; expect((await GET(request("123,124"))).status).toBe(400);
    expect(m.calls).toHaveLength(0);
  });
  it("does not choose between ambiguous accounts or return a removed/non-TAM account", async () => {
    m.companies.push({ id: "other", netsuite_internal_id: "123" });
    expect((await GET(request())).status).toBe(409);
    expect(m.calls).toContainEqual({ table: "companies", method: "contains", args: ["lists", ["netsuite_tam"]] });
    expect(m.calls).toContainEqual({ table: "companies", method: "neq", args: ["status", "removed_from_tam"] });
    m.companies = []; expect((await GET(request())).status).toBe(404);
  });
  it("returns bounded original public source timing and separately labeled relationships", async () => {
    m.rows = Array.from({ length: 101 }, (_, index) => ({ id: String(index), source_url: "https://example.test/news",
      title: "Public news", event_date: null, observed_at: "2026-09-19T00:00:00Z", evidence_text: "x".repeat(1800),
      attributes: { companyRelationship: "related", signalType: "ma" } }));
    const response = await GET(request()); const result = await response.json();
    expect(result).toMatchObject({ internalId: "123", coverage: { partial: true, limit: 100 } });
    expect(result.observations).toHaveLength(100);
    expect(result.observations[0]).toMatchObject({ eventDate: null, observedAt: "2026-09-19T00:00:00Z", relationship: "related", excerptTruncated: true });
    expect(result.observations[0].excerpt).toHaveLength(1600);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "eq", args: ["feedback_excluded", false] });
    expect(m.calls.every(call => !["insert", "update", "upsert", "delete"].includes(call.method))).toBe(true);
  });
});
