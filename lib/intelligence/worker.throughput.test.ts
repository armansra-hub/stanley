import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), durable: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }), withServiceDeadline: (_: unknown, run: () => unknown) => run() }));
vi.mock("./observations", () => ({ intelligenceEnabled: mocks.enabled, INTELLIGENCE_VERSION: "test" }));
vi.mock("./feedback", () => ({ loadFeedbackExamples: async () => [] }));
vi.mock("@/lib/companyIdentity", () => ({ loadCompanyIdentityContext: async () => ({ context: "Authorized identity" }) }));
vi.mock("./publicContext", () => ({ loadPublicScaleObservations: async () => [], buildPublicScaleContext: () => ({ text: "No public scale baseline is available." }) }));
vi.mock("./jevRequests", () => ({ durableJevRequest: mocks.durable, reconcileJevReceipts: async () => {} }));
vi.mock("./budget", async importOriginal => ({ ...await importOriginal<typeof import("./budget")>(), secondsUntilNextMonth: () => 86400 }));
vi.mock("./publish", () => ({ publishJevFinding: async () => ({ status: "not_eligible", reason: "unknown_event_date" }), jevSignalType: () => null }));
vi.mock("./events", () => ({ reconcileObservationEvent: async () => null, EventReconciliationDeferred: class extends Error {}, bindEventTrigger: vi.fn() }));
vi.mock("./narratives", () => ({ queueAccountStory: async () => true }));
import { runIntelligenceWorker } from "./worker";

const job = (id: number) => ({ id: `job-${id}`, observation_id: `obs-${id}`, kind: "interpret", lease_token: `lease-${id}`, attempts: 1, result: null });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let available: number;
let nextId: number;
let current: boolean | ((id: string) => boolean);
let read: (id: string) => Promise<void>;
let finishes: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TYPESAFE_MODEL", "jev-1.13.0");
  available = 0; nextId = 0; current = false; read = async () => {}; finishes = [];
  mocks.enabled.mockReturnValue(true);
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
    if (name === "intelligence_claim") {
      const size = Math.min(available, args.p_limit);
      available -= size;
      return { data: Array.from({ length: size }, () => job(nextId++)), error: null };
    }
    if (name === "intelligence_finish" || name === "intelligence_job_budget_defer") finishes.push(args.p_id);
    return { data: true, error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    const query: any = {};
    let id = "";
    for (const method of ["select", "gt", "limit", "update"]) query[method] = () => query;
    query.eq = (key: string, value: string) => { if (key === "id") id = value; return query; };
    const result = async () => {
      if (table === "intelligence_observations") await read(id);
      return { data: table === "intelligence_config" ? { enabled: true } : table === "intelligence_views" ? []
        : table === "intelligence_observations" ? { id, company_id: `company-${id}`, is_current: typeof current === "function" ? current(id) : current, metadata: {},
          evidence_text: "Acme opened a facility.", source_kind: "company_news", source_url: "https://acme.test/news",
          title: "New facility", event_date: null, observed_at: "2026-09-18T23:00:00Z" }
          : { id, name: "Acme", domain: "acme.test" }, error: null };
    };
    query.single = query.maybeSingle = result;
    query.then = (resolve: (value: unknown) => unknown) => result().then(resolve);
    return query;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("runtime-bounded rolling intelligence throughput", () => {
  it("drains more than 192 jobs without issuing any paid call for already superseded work", async () => {
    available = 401;
    const result = await runIntelligenceWorker({ mode: "drain" });
    expect(result).toMatchObject({ processed: 401, claimed: 401, concurrency: 6, peakInFlight: 6,
      stoppedBy: "queue_empty_or_capacity", stopReason: "queue_empty_or_capacity", outcomes: { superseded: 401 } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(finishes).toHaveLength(401);
    expect(new Set(finishes).size).toBe(401);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_claim").every(([, args]) => args.p_limit <= 6)).toBe(true);
    expect(mocks.durable).not.toHaveBeenCalled();
  });

  it("refills a finished slot while five slower jobs remain owned, with serialized claims and at most six in flight", async () => {
    available = 9;
    const slow = deferred(), refilled = deferred();
    let activeReads = 0, peakReads = 0, claimActive = 0, peakClaims = 0;
    read = async id => {
      activeReads++;
      peakReads = Math.max(peakReads, activeReads);
      if (Number(id.slice(4)) < 5) await slow.promise;
      if (id === "obs-6") refilled.resolve();
      activeReads--;
    };
    const baseClaim = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name !== "intelligence_claim") return baseClaim(name, args);
      claimActive++; peakClaims = Math.max(peakClaims, claimActive);
      await Promise.resolve();
      const result = await baseClaim(name, args);
      claimActive--;
      return result;
    });
    const run = runIntelligenceWorker({ mode: "drain", concurrency: 99 });
    await refilled.promise;
    expect(finishes).toContain("job-5");
    expect(finishes).not.toContain("job-0");
    expect(activeReads).toBe(5);
    slow.resolve();
    expect(await run).toMatchObject({ processed: 9, claimed: 9, concurrency: 6, peakInFlight: 6 });
    expect(peakReads).toBe(6);
    expect(peakClaims).toBe(1);
  });

  it("preserves finite number callers and their existing upper bound", async () => {
    available = 500;
    expect(await runIntelligenceWorker(500)).toMatchObject({ processed: 192, claimed: 192, concurrency: 3, stoppedBy: "batch_limit" });
    expect(available).toBe(308);
  });

  it("stops claiming 30 seconds before the deadline and waits for already owned jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    available = 30;
    const first = deferred(), remaining = deferred(), allStarted = deferred();
    let started = 0;
    read = async id => {
      if (++started === 6) allStarted.resolve();
      await (id === "obs-0" ? first.promise : remaining.promise);
    };
    let settled = false;
    const run = runIntelligenceWorker({ mode: "drain" }, 1_060_000).then(result => { settled = true; return result; });
    await allStarted.promise;
    vi.setSystemTime(1_030_000);
    first.resolve();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_claim")).toHaveLength(1);
    remaining.resolve();
    expect(await run).toMatchObject({ processed: 6, claimed: 6, stoppedBy: "deadline", durationMs: 30_000 });
    expect(finishes).toHaveLength(6);
  });

  it("does not poll an empty or globally capacity-limited claim", async () => {
    expect(await runIntelligenceWorker({ mode: "drain" })).toMatchObject({ processed: 0, claimed: 0, peakInFlight: 0, stoppedBy: "queue_empty_or_capacity" });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_claim")).toHaveLength(1);
  });

  it("checkpoints a short job lease even when the invocation has a longer runtime remaining", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    available = 6; current = true;
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      const result = await base(name, args);
      if (name === "intelligence_claim") result.data = result.data.map((value: ReturnType<typeof job>) => ({
        ...value, lease_until: new Date(Date.now() + 30_000).toISOString(),
      }));
      return result;
    });
    expect(await runIntelligenceWorker({ mode: "drain" }, Date.now() + 280_000)).toMatchObject({
      processed: 6, claimed: 6, outcomes: { continued: 6 }, stoppedBy: "queue_empty_or_capacity",
    });
    expect(mocks.durable).not.toHaveBeenCalled();
    const checkpoints = mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_finish");
    expect(checkpoints).toHaveLength(6);
    expect(checkpoints.every(([, args]) => args.p_status === "queued" && args.p_error === "continuation" && args.p_retry_seconds === 30)).toBe(true);
  });

  it.each([
    ["budget_deferred", "budget"], ["rate_limit", "provider_pressure"], ["authentication", "provider_pressure"], ["billing", "provider_pressure"],
  ])("stops refilling after %s and preserves every already-owned completion", async (failure, stoppedBy) => {
    available = 30; current = true;
    const retryAt = "2026-09-25T07:00:00.000Z";
    mocks.durable.mockResolvedValue(failure === "budget_deferred" ? { status: failure, reason: "daily_allowance", retryAt }
      : { status: "complete", evaluation: { ok: false, error: { kind: failure, retryable: true, retryAfterMs: 120_000 } } });
    expect(await runIntelligenceWorker({ mode: "drain" })).toMatchObject({ processed: 6, claimed: 6, stoppedBy });
    expect(mocks.durable).toHaveBeenCalledTimes(6);
    expect(finishes).toHaveLength(6);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_claim")).toHaveLength(1);
    if (failure === "budget_deferred") {
      const deferrals = mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_job_budget_defer");
      expect(deferrals).toHaveLength(6);
      expect(deferrals.every(([, args]) => args.p_retry_at === retryAt && args.p_reason === "daily_allowance")).toBe(true);
      expect(mocks.rpc.mock.calls.some(([name]) => name === "intelligence_finish")).toBe(false);
    }
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_finish").every(([, args]) => args.p_status === "queued" && args.p_retry_seconds >= 30)).toBe(true);
  });

  it.each(["provider_unavailable", "timeout", "invalid_response", "invalid_request"])("continues draining after one %s and an unrelated busy cached request", async failure => {
    available = 40;
    current = id => id === "obs-0" || id === "obs-1";
    mocks.durable.mockImplementation(async ({ context }: { context: { observationId: string } }) => context.observationId === "obs-1"
      ? { status: "busy" }
      : { status: "complete", evaluation: { ok: false, error: { kind: failure, retryable: true, retryAfterMs: 120_000 } } });
    expect(await runIntelligenceWorker({ mode: "drain" })).toMatchObject({ processed: 40, claimed: 40,
      stoppedBy: "queue_empty_or_capacity", outcomes: { [failure]: 1, request_in_progress: 1, superseded: 38 } });
    expect(mocks.durable).toHaveBeenCalledTimes(2);
    expect(finishes).toHaveLength(40);
  });

  it("continues after one uncertain item while leaving that exact lease available for recovery", async () => {
    available = 40;
    read = async id => { if (id === "obs-0") throw new Error("One observation read failed"); };
    expect(await runIntelligenceWorker({ mode: "drain" })).toMatchObject({ processed: 40, claimed: 40,
      stoppedBy: "queue_empty_or_capacity", outcomes: { checkpoint_or_service_error: 1, superseded: 39 } });
    expect(finishes).toHaveLength(39);
    expect(finishes).not.toContain("job-0");
  });

  it.each(["provider", "service"])("stops after three concentrated %s failures while preserving each item's recovery", async kind => {
    available = 30;
    if (kind === "service") read = async () => { throw new Error("Service unavailable"); };
    else {
      current = true;
      mocks.durable.mockResolvedValue({ status: "complete", evaluation: { ok: false,
        error: { kind: "provider_unavailable", retryable: true, retryAfterMs: 120_000 } } });
    }
    expect(await runIntelligenceWorker({ mode: "drain", concurrency: 1 })).toMatchObject({ processed: 3, claimed: 3,
      stoppedBy: `${kind}_pressure`, outcomes: { [kind === "service" ? "checkpoint_or_service_error" : "provider_unavailable"]: 3 } });
    expect(finishes).toHaveLength(kind === "service" ? 0 : 3);
    expect(available).toBe(27);
  });

  it("forgets isolated failures outside the twelve-result pressure window", async () => {
    available = 30;
    read = async id => { if (["obs-0", "obs-12", "obs-24"].includes(id)) throw new Error("Isolated observation failure"); };
    expect(await runIntelligenceWorker({ mode: "drain", concurrency: 1 })).toMatchObject({ processed: 30, claimed: 30,
      stoppedBy: "queue_empty_or_capacity", outcomes: { checkpoint_or_service_error: 3, superseded: 27 } });
    expect(finishes).toHaveLength(27);
  });

  it("awaits owned jobs if a later claim fails, without clearing or retrying any lease", async () => {
    available = 20;
    const slow = deferred(), claimFailed = deferred();
    read = async id => { if (id !== "obs-0") await slow.promise; };
    let claims = 0;
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
      if (name === "intelligence_claim" && ++claims > 1) { claimFailed.resolve(); return { data: null, error: { message: "Unavailable" } }; }
      return base(name, args);
    });
    let settled = false;
    const run = runIntelligenceWorker({ mode: "drain" }).then(result => { settled = true; return result; });
    await claimFailed.promise;
    expect(settled).toBe(false);
    slow.resolve();
    expect(await run).toMatchObject({ processed: 6, claimed: 6, stoppedBy: "service_pressure", outcomes: { superseded: 6, claim_error: 1 } });
    expect(finishes).toHaveLength(6);
    expect(claims).toBe(2);
  });
});
