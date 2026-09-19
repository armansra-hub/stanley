import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }), withServiceDeadline: (_: unknown, run: () => unknown) => run() }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, INTELLIGENCE_VERSION: "test" }));
vi.mock("./feedback", () => ({ loadFeedbackExamples: async () => [] }));
vi.mock("./budget", () => ({ reserveJev: mocks.reserve, settleJev: mocks.settle, secondsUntilNextMonth: () => 60 }));
vi.mock("./publish", () => ({ publishJevFinding: vi.fn(), jevSignalType: vi.fn() }));
vi.mock("./events", () => ({ attachObservationEvent: async () => null, bindEventTrigger: vi.fn() }));
vi.mock("./narratives", () => ({ queueAccountStory: async () => true }));
import { runIntelligenceWorker } from "./worker";
import { buildPublicScaleContext } from "./publicContext";

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
  it("continues beyond the old small batch while claiming only immediate concurrency", async () => {
    observation.is_current = false;
    let remaining = 60;
    mocks.rpc.mockImplementation(async (name: string, args: { p_limit?: number }) => {
      if (name !== "intelligence_claim") return { data: true, error: null };
      const size = Math.min(remaining, args.p_limit ?? 0);
      remaining -= size;
      return { data: Array.from({ length: size }, (_, i) => ({ id: `job-${remaining+i}`, observation_id: "obs", kind: "interpret", lease_token: "lease", attempts: 1, result: null })), error: null };
    });
    expect(await runIntelligenceWorker(60)).toMatchObject({ processed: 60, outcomes: { superseded: 60 }, stoppedBy: "batch_limit" });
    const claims = mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_claim");
    expect(claims).toHaveLength(20);
    expect(claims.every(([, args]) => args.p_limit <= 3)).toBe(true);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("does not claim jobs without enough function time to execute them", async () => {
    expect(await runIntelligenceWorker(192, Date.now() + 1000)).toMatchObject({ processed: 0, stoppedBy: "deadline" });
    expect(mocks.rpc.mock.calls.some(([name]) => name === "intelligence_claim")).toBe(false);
  });
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
  it.each(["stanley-evidence-v2", "stanley-public-scale-v1"])("resumes paid %s results without reinterpreting them or rereading the baseline", async (questionVersion) => {
    const nativeAnswer = { type: "score", score: 2 };
    const evaluation = { ok: true, questionVersion, model: "jev-1.13.0", usage: { inputTokens: 500, outputTokens: 30 },
      attributes: { companyRelationship: "direct", companyRelevance: .96, concreteEvent: .9, operationalComplexity: .5,
        signalType: "new_entity", evidenceSectionId: "s1" }, criteria: {}, metadata: { rawAnswers: { operationalComplexity: nativeAnswer } } };
    const savedContext = buildPublicScaleContext("company", []);
    const savedResult = { parts: [{ start: 0, end: (observation.evidence_text as string).length, evaluation }],
      ...(questionVersion === "stanley-public-scale-v1" ? { publicScaleContext: savedContext } : {}) };
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_claim"
      ? [{ id: "job", observation_id: "obs", kind: "interpret", lease_token: "lease", attempts: 2, result: savedResult }] : true, error: null }));
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { complete: 1 } });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.filter(([table]) => table === "intelligence_observations")).toHaveLength(1);
    const completed = mocks.rpc.mock.calls.find(([name]) => name === "intelligence_finish")![1];
    expect(completed.p_result.parts).toEqual(savedResult.parts);
    expect(completed.p_attributes.rawAnswers.operationalComplexity).toEqual(nativeAnswer);
    expect(completed.p_result.publicScaleContext).toEqual(questionVersion === "stanley-public-scale-v1" ? savedContext : undefined);
  });
});
