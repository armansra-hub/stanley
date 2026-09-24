import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ enabled: true, worker: vi.fn(), questionWorker: vi.fn(), deadline: vi.fn(), from: vi.fn(), rpc: vi.fn(), priority: vi.fn(), authorized: vi.fn(), failure: { table: "", code: "" }, calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }), withServiceDeadline: m.deadline }));
vi.mock("@/lib/intelligence/worker", () => ({ runIntelligenceWorker: m.worker }));
vi.mock("@/lib/intelligence/accountQuestions", () => ({ runAccountQuestionWorker: m.questionWorker }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => m.enabled }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: m.priority }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: m.authorized, sameOriginMutation: () => true,
  isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value), smallJson: (request: Request) => request.json() }));
import { GET, POST } from "./route";
const company = "10000000-0000-4000-8000-000000000001", observation = "10000000-0000-4000-8000-000000000002";
beforeEach(() => {
  m.failure.table = ""; m.failure.code = "";
  m.enabled = true; m.worker.mockClear(); m.questionWorker.mockClear();
  m.deadline.mockReset().mockImplementation((_deadline: number, read: () => Promise<unknown>) => read());
  m.calls.length = 0; m.authorized.mockReturnValue(true); m.priority.mockReset().mockResolvedValue(10);
  m.rpc.mockReset().mockResolvedValue({ data: { enabled: true }, error: null });
  m.from.mockImplementation((table: string) => {
    let single = false;
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "not", "order", "limit", "range", "gte", "in", "upsert", "delete", "single"]) chain[method] = (...args: unknown[]) => {
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
  it.each(["", `?viewId=${company}`])("hides dismissed accounts before pagination while Jev is paused: %s", async suffix => {
    m.enabled = false;
    expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence${suffix}`))).status).toBe(200);
    const filter = m.calls.findIndex(call => call.method === "not" && call.args[0] === "companies.status");
    expect(filter).toBeGreaterThan(-1);
    expect(m.calls[filter].args).toEqual(["companies.status", "in", "(reviewed,dismissed,exported_csv,exported_sql)"]);
    expect(filter).toBeLessThan(m.calls.findIndex(call => call.method === "range"));
    expect(m.worker).not.toHaveBeenCalled();
    expect(m.questionWorker).not.toHaveBeenCalled();
  });
  it.each(["?showHidden=true", `?showHidden=true&viewId=${company}`, `?scope=account&companyId=${company}`])("keeps hidden research available for restoration or exact-account review: %s", async suffix => {
    expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence${suffix}`))).status).toBe(200);
    expect(m.calls.some(call => call.method === "not" && call.args[0] === "companies.status")).toBe(false);
    expect(m.calls.some(call => call.method === "neq" && call.args[1] === "removed_from_tam")).toBe(true);
  });
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
  it("keeps evidence available when monitoring fails without fabricating zero counts or logging private errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.rpc.mockResolvedValue({ data: null, error: { code: "private SQL or token", details: "not for logs" } });
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activityAvailable: false, processingEnabled: null,
      health: null, spend: { available: false }, observations: [{ id: observation }] });
    expect(log).not.toHaveBeenCalled();
  });
  it("keeps saved reads independent of thrown metric errors and uses bounded storage requests", async () => {
    const started = Date.now();
    m.rpc.mockRejectedValue(new Error("private metric timeout"));
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activityAvailable: false, health: null, observations: [{ id: observation }] });
    expect(m.deadline).toHaveBeenCalledTimes(3);
    for (const [deadline] of m.deadline.mock.calls) expect(deadline).toBeGreaterThanOrEqual(started + 2_500);
  });
  it("returns stored evidence and saved view matches while processing is paused, without starting workers", async () => {
    m.enabled = false;
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, processingEnabled: false, observations: [{ id: observation }] });
    const matches = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence?viewId=${company}`));
    expect(matches.status).toBe(200);
    expect(m.calls.some(call => call.table === "intelligence_views")).toBe(true);
    expect(m.calls.some(call => call.table === "intelligence_account_question_matches")).toBe(true);
    expect((await post({ action: "save_view", name: "Paused", question: "Which accounts are expanding?" })).status).toBe(409);
    expect(m.calls.some(call => call.method === "upsert")).toBe(false);
    expect(m.worker).not.toHaveBeenCalled();
    expect(m.questionWorker).not.toHaveBeenCalled();
  });
  it("keeps saved question answers readable when their queue count is unavailable", async () => {
    m.failure.table = "intelligence_account_question_jobs";
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence?viewId=${company}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accountMatches: [], accountQuestionPending: null });
  });
  it("filters exclusions before all-evidence pagination", async () => {
    for (const suffix of [""]) {
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
  it("returns native account-wide question results without a hard probability cutoff", async () => {
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence?viewId=${company}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observations: [], accountMatches: [] });
    expect(m.calls).toContainEqual({ table: "intelligence_account_question_matches", method: "eq", args: ["view_id", company] });
    expect(m.calls.some(call => call.table === "intelligence_observations")).toBe(false);
    expect(m.calls.some(call => call.method === "gte")).toBe(false);
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
  it("keeps evidence readable when cost attribution is temporarily unavailable", async () => {
    m.rpc.mockImplementation((name: string) => Promise.resolve(name === "intelligence_jev_cost_metrics"
      ? { data: null, error: { code: "PGRST202" } } : { data: { enabled: true }, error: null }));
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jevCost: { available: false }, observations: [{ id: observation }] });
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
