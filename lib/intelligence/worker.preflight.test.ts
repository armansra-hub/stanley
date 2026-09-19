import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }), withServiceDeadline: (_: unknown, run: () => unknown) => run() }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, INTELLIGENCE_VERSION: "test" }));
vi.mock("./feedback", () => ({ loadFeedbackExamples: async () => [] }));
vi.mock("./budget", () => ({ reserveJev: mocks.reserve, settleJev: mocks.settle, secondsUntilNextMonth: () => 60 }));
vi.mock("./publish", () => ({ publishJevFinding: vi.fn(), jevSignalType: vi.fn() }));
import { runIntelligenceWorker } from "./worker";

let observation: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("TYPESAFE_MODEL", "");
  observation = { id: "obs", company_id: "company", is_current: true, metadata: {}, evidence_text: "Acme opened a facility.",
    source_kind: "company_news", source_url: "https://acme.test/news", title: "New facility", event_date: null, observed_at: "2026-09-18T23:00:00Z" };
  let claimed = false;
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_claim"
    ? claimed ? [] : (claimed = true, [{ id: "job", observation_id: "obs", view_id: null, kind: "interpret", lease_token: "lease", attempts: 1, result: null }]) : true, error: null }));
  mocks.from.mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ["select", "eq", "limit"]) query[method] = () => query;
    const result = () => ({ data: table === "intelligence_config" ? { enabled: true } : table === "intelligence_views" ? []
      : table === "intelligence_observations" ? observation : { name: "Acme", domain: "acme.test" }, error: null });
    query.single = async () => result(); query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  });
  mocks.reserve.mockResolvedValue("reservation"); mocks.settle.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("worker predispatch budget handling", () => {
  it("rejects malformed assembled input before reserving a paid call", async () => {
    observation.title = "x".repeat(2001);
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { invalid_input: 1 } });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("releases a reservation at zero when the adapter rejects locally before dispatch", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "invalid-model");
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { invalid_request: 1 } });
    expect(mocks.reserve).toHaveBeenCalledOnce(); expect(mocks.settle).toHaveBeenCalledWith("reservation", 0);
  });
});
