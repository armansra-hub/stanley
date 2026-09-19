import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), priority: vi.fn(), authorized: vi.fn(), failure: { table: "", code: "" }, calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/lib/intelligence/worker", () => ({ runIntelligenceWorker: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => true }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: m.priority }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: m.authorized, sameOriginMutation: () => true,
  isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value), smallJson: (request: Request) => request.json() }));
import { GET, POST } from "./route";
const company = "10000000-0000-4000-8000-000000000001", observation = "10000000-0000-4000-8000-000000000002";
beforeEach(() => {
  m.failure.table = ""; m.failure.code = "";
  m.calls.length = 0; m.authorized.mockReturnValue(true); m.priority.mockReset().mockResolvedValue(10);
  m.rpc.mockReset().mockResolvedValue({ data: { enabled: true }, error: null });
  m.from.mockImplementation((table: string) => {
    let single = false;
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "order", "limit", "range", "gte", "in", "upsert", "delete", "single"]) chain[method] = (...args: unknown[]) => {
      m.calls.push({ table, method, args }); if (method === "single") single = true; return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "intelligence_observations"
      ? single ? { company_id: company, title: "Source headline" } : [{ id: observation, company_id: company, companies: { name: "Synthetic" } }]
      : [], error: m.failure.table === table ? { code: m.failure.code, message: "private provider detail must not be logged" } : null }).then(resolve);
    return chain;
  });
});
afterEach(() => vi.restoreAllMocks());
const post = (body: Record<string, unknown>) => POST(new NextRequest("https://stanley.test/api/headhunter/intelligence", { method: "POST", body: JSON.stringify(body) }));

describe("reversible intelligence feedback API", () => {
  it.each([
    ["intelligence_views", "views", "PGRST205"],
    ["intelligence_observations", "observations", "42703"],
    ["intelligence_feedback", "feedback", "42501"],
  ])("logs only the fixed stage and standard error code for %s", async (table, stage, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.failure.table = table; m.failure.code = code;
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "intelligence_storage_unavailable", stage });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("intelligence.read_failed", { stage, code });
  });
  it("identifies status RPC failure and suppresses arbitrary error-code text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.rpc.mockResolvedValue({ data: null, error: { code: "private SQL or token", details: "not for logs" } });
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(await response.json()).toEqual({ error: "intelligence_storage_unavailable", stage: "status" });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("intelligence.read_failed", { stage: "status", code: "unknown" });
  });
  it("filters exclusions before both saved-view pagination and all-evidence pagination", async () => {
    for (const suffix of ["", `?viewId=${company}`]) {
      m.calls.length = 0;
      expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence${suffix}`))).status).toBe(200);
      const index = m.calls.findIndex(call => call.table === "intelligence_observations" && call.method === "eq" && call.args[0] === "feedback_excluded");
      expect(m.calls[index].args).toEqual(["feedback_excluded", false]);
      expect(index).toBeLessThan(m.calls.findIndex(call => call.method === "range"));
      const select = String(m.calls.find(call => call.table === "intelligence_observations" && call.method === "select")?.args[0]);
      expect(select).toContain("companies:companies!intelligence_observations_company_id_fkey!inner(name,status)");
      if (suffix) expect(select).toContain("intelligence_view_matches:intelligence_view_matches!intelligence_view_matches_observation_id_fkey!inner(probability,view_id)");
    }
  });
  it("loads exact-account cached evidence without global status, health or saved views", async () => {
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence?scope=account&companyId=${company}`));
    expect(response.status).toBe(200);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.calls.some(call => call.table === "intelligence_views")).toBe(false);
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "eq", args: ["company_id", company] });
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "neq", args: ["companies.status", "removed_from_tam"] });
    expect(await response.json()).toMatchObject({ views: [], health: null, observations: [{ company_id: company }] });
  });
  it("rejects an unbound account scope", async () => {
    expect((await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence?scope=account"))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("provides an explicit excluded-evidence review path for Undo", async () => {
    expect((await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence?dismissed=true"))).status).toBe(200);
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "eq", args: ["feedback_excluded", true] });
  });
  it("stores a correction separately and recomputes only public priority", async () => {
    const response = await post({ action: "feedback", observationId: observation, reason: "wrong_company", note: "The customer, not this account." });
    expect(await response.json()).toEqual({ ok: true, priorityUpdated: true });
    expect(m.calls.find(call => call.method === "upsert")?.args[0]).toMatchObject({ company_id: company, observation_id: observation, reason: "wrong_company", note: "The customer, not this account." });
    expect(m.priority).toHaveBeenCalledWith(company);
  });
  it("clears only the exact account/observation feedback and reports an independent priority retry honestly", async () => {
    m.priority.mockRejectedValue(new Error("temporary write unavailable"));
    const response = await post({ action: "clear_feedback", observationId: observation });
    expect(await response.json()).toEqual({ ok: true, priorityUpdated: false });
    expect(m.calls).toContainEqual({ table: "intelligence_feedback", method: "eq", args: ["company_id", company] });
    expect(m.calls).toContainEqual({ table: "intelligence_feedback", method: "eq", args: ["observation_id", observation] });
    expect(m.calls.some(call => call.method === "delete")).toBe(true);
  });
  it("authenticates before loading evidence", async () => {
    m.authorized.mockReturnValue(false); m.from.mockClear();
    expect((await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"))).status).toBe(401);
    expect(m.from).not.toHaveBeenCalled();
  });
});
