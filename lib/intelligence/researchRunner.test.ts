import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), sourceState: vi.fn(), external: vi.fn(), rank: vi.fn(), fetch: vi.fn(), enqueue: vi.fn(), coverage: vi.fn(), budget: vi.fn() }));
vi.mock("./operatingCoverage", () => ({ runOperatingCoverage: mocks.coverage }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
  withServiceDeadline: vi.fn((_deadline: number, run: () => unknown) => run()) }));
vi.mock("./researchRanking", () => ({ rankResearchCandidates: mocks.rank }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: mocks.enqueue }));
vi.mock("./sourceState", () => ({ readSourceState: mocks.sourceState }));
vi.mock("./atsLifecycle", () => ({ readAtsHiringContext: async () => null }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/publicPdf", () => ({ fetchPublicPdfEvidence: vi.fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
vi.mock("./researchExternal", () => ({ discoverExternalResearch: mocks.external }));
vi.mock("./budget", async original => ({ ...await original<typeof import("./budget")>(), readJevBudgetPolicy: mocks.budget }));
import { loadResearchProfile, refreshAccountResearch, researchSweepState, runDirectedResearchWorker, type ResearchProfile } from "./researchRunner";
import { withServiceDeadline } from "@/lib/supabase/server";

const candidates = ["https://example.com/about", "https://example.com/team", "https://example.com/services", "https://example.com/billing"];
const profile = { company: { id: "company", name: "Synthetic Consulting", domain: "example.com" },
  missingTopics: ["project_billing"], candidates, candidateTitles: {}, researchFocus: "Investigate explicit project billing processes.",
  sweep: { knownSources: 4, dueSources: 4, unreadSources: 4, leasedSources: 0, retrySources: 0 }, pendingJobs: 0, unresolvedInterpretations: 0,
  nextAttemptAt: "2026-09-20T00:00:00Z" } as unknown as ResearchProfile;
let tables: Record<string, Record<string, unknown>[]>;
let tableErrors: Record<string, { code?: string; message?: string }>;
let pendingJobs = 0;
let inserted: { source_url: string }[] = [];
const future = () => new Date(Date.now() + 7 * 86400_000).toISOString();
function mockTable(table: string) {
  let rows = tables[table] ?? (table === "intelligence_jobs" ? Array.from({ length: pendingJobs }, (_, index) => ({
    id: `job-${index}`, observation_id: `observation-${index}`, status: "queued", kind: "interpret",
    intelligence_observations: { company_id: "company", is_current: true, feedback_excluded: false },
  })) : []), head = false;
  const builder: Record<string, unknown> = {};
  const field = (row: Record<string, unknown>, key: string) => key.split(".").reduce<unknown>((value, part) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, row);
  builder.eq = (key: string, value: unknown) => { rows = rows.filter(row => field(row, key) === undefined || field(row, key) === value); return builder; };
  builder.neq = (key: string, value: unknown) => { rows = rows.filter(row => field(row, key) !== value); return builder; };
  builder.in = (key: string, values: unknown[]) => { rows = rows.filter(row => field(row, key) === undefined || values.includes(field(row, key))); return builder; };
  builder.order = () => builder;
  builder.select = (_columns: string, options?: { head?: boolean }) => { head = options?.head === true; return builder; };
  builder.range = (from: number, through: number) => { rows = rows.slice(from, through + 1); return builder; };
  builder.single = () => Promise.resolve({ data: rows[0], error: null });
  builder.upsert = () => { rows = inserted; return builder; };
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: head ? null : rows, count: head ? pendingJobs : undefined, error: tableErrors[table] ?? null }).then(resolve);
  return builder;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.budget.mockResolvedValue({ available: true, enabled: true, phase: "maintenance" });
  mocks.external.mockResolvedValue({ sources: 0 });
  mocks.coverage.mockResolvedValue({ outcome: "catalog_complete", answered: 47 });
  mocks.sourceState.mockResolvedValue({ cursor: null, lastSuccessAt: null });
  tables = { companies: [{ id: "company", name: "Synthetic Consulting", domain: "example.com" }] };
  tableErrors = {};
  pendingJobs = 0; inserted = [];
  mocks.from.mockImplementation(mockTable);
});
afterEach(() => vi.restoreAllMocks());

describe("catalog account lease integration", () => {
  it.each([
    ["rollout", { available: true, enabled: true, phase: "ongoing" }, true],
    ["rollout", { available: true, enabled: true, phase: "maintenance" }, true],
    ["rollout", { available: true, enabled: true, phase: "initial" }, false],
    ["rollout", { available: true, enabled: true, phase: "expired" }, false],
    ["rollout", { available: false }, false],
    ["rollout", { available: true, enabled: false, phase: "ongoing", blockedReason: "policy_disabled" }, false],
    ["rollout", { available: true, enabled: false, phase: "ongoing", blockedReason: "provider_balance_exhausted" }, false],
    ["pilot", { available: true, enabled: true, phase: "ongoing" }, false],
  ])("admits ordinary prospecting research only in an authorized phase (%s,%j)", async (mode, budget, allowed) => {
    tables.intelligence_config = [{ id: 1, catalog_mode: mode }]; mocks.budget.mockResolvedValue(budget);
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000,
      profile: { ...profile, candidates: [], sweep: { knownSources: 0, dueSources: 0, unreadSources: 0, leasedSources: 0, retrySources: 0 } } });
    expect(result.outcome === "catalog_only").toBe(!allowed);
    expect(mocks.external).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(mocks.rank).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  function catalogJob(overrides: { attempts?: number; last_error?: string | null } = {}) {
    let claimed = false;
    const job = { company_id: "company", desired_hash: "hash", lease_token: "lease", attempts: 1,
      lease_until: new Date(Date.now() + 180000).toISOString(), catalog_requested_version: "catalog", ...overrides };
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_directed_claim" ? (claimed ? [] : (claimed = true, [job])) : true, error: null }));
    return job;
  }
  it("uses the same lease and does not also run the historical research path", async () => {
    const job = catalogJob();
    expect(await runDirectedResearchWorker(1)).toMatchObject({ processed: 1, outcomes: { catalog_complete: 1 } });
    expect(mocks.coverage).toHaveBeenCalledWith(job, expect.any(Number));
    expect(mocks.external).not.toHaveBeenCalled(); expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "intelligence_directed_finish")).toBe(false);
  });
  it("performs one bounded gap pass only when coverage requests it", async () => {
    catalogJob(); mocks.coverage.mockResolvedValue({ outcome: "catalog_needs_research", answered: 47, researchFacets: ["rr_c09"] });
    expect(await runDirectedResearchWorker(1)).toMatchObject({ processed: 1, outcomes: { catalog_researched: 1 } });
    expect(mocks.external).toHaveBeenCalledTimes(1);
    expect(mocks.external.mock.calls[0][4].join(" ")).toMatch(/usage|transaction/i);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_catalog_research_finish", expect.objectContaining({ p_company: "company", p_lease: "lease" }));
  });
  it("passes the exact unresolved facets into full-context catalog ranking", async () => {
    mocks.rank.mockResolvedValueOnce({ candidates, providerUsed: false, scores: [], outcome: "busy", rankingVersion: "current" });
    await refreshAccountResearch("company", { deadlineMs: Date.now() + 90000, automatic: true, profile,
      catalogGap: { facetIds: ["rr_c09", "rr_c02"] } });
    expect(mocks.rank).toHaveBeenCalledWith(expect.objectContaining({ catalogOwned: true, catalogFacetIds: ["rr_c09", "rr_c02"] }));
    expect(mocks.rank.mock.calls[0][0].researchContext).toBeUndefined();
  });
  it("keeps source leases and retry state while catalog research ignores the held legacy backlog", async () => {
    const source = "https://example.com/services";
    tables.intelligence_observations = [{ id: "evidence", company_id: "company", source_url: source,
      source_kind: "website", title: "Services", event_date: null, observed_at: new Date().toISOString(),
      evidence_text: "We perform client projects", attributes: null, is_current: true, feedback_excluded: false }];
    tables.intelligence_research_attempts = [{ source_url: source, next_attempt_at: future(),
      last_attempt_at: new Date().toISOString(), last_success_at: null, lease_until: future(), outcome: "source_failed" }];
    pendingJobs = 1000;
    tableErrors.intelligence_jobs = { code: "57014", message: "Sensitive legacy query detail must not be logged" };
    // Exercise the profile reload after external discovery as well as its initial load.
    mocks.external.mockResolvedValue({ sources: 1 });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true,
      catalogGap: { facetIds: ["rr_c02"] } });
    expect(result).toMatchObject({ outcome: "sources_leased", sources: 0, unresolvedInterpretations: 0,
      sweep: { knownSources: 1, dueSources: 0, leasedSources: 1, retrySources: 1 } });
    expect(mocks.from.mock.calls.filter(([table]) => table === "intelligence_research_attempts")).toHaveLength(2);
    expect(mocks.from.mock.calls.some(([table]) => table === "intelligence_jobs")).toBe(false);
    expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    // The same unavailable legacy query remains a real error for ordinary research.
    await expect(loadResearchProfile("company")).rejects.toThrow("research_interpretation_jobs_unavailable:57014");
  });
  it("does not hide a catalog source-attempt read failure or leak its raw error", async () => {
    mocks.sourceState.mockResolvedValue({ cursor: { knownUrls: ["https://example.com/services"] } });
    tableErrors.intelligence_research_attempts = { code: "42P01", message: "Sensitive database query detail" };
    await expect(refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true,
      catalogGap: { facetIds: ["rr_c02"] } })).rejects.toThrow("research_source_attempts_unavailable:42P01");
    tableErrors.intelligence_research_attempts.code = "malformed:private-query-data";
    await expect(loadResearchProfile("company", Infinity, { catalogGap: true })).rejects.toThrow(/^research_source_attempts_unavailable$/);
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("retries known pre-dispatch read deadlines but holds uncertain dispatch failures", async () => {
    catalogJob(); mocks.coverage.mockRejectedValue(new Error("catalog_loading_deadline"));
    await runDirectedResearchWorker(1);
    let deferred = mocks.rpc.mock.calls.find(([name]) => name === "intelligence_catalog_defer")![1];
    expect(Date.parse(deferred.p_retry_at)).toBeGreaterThan(Date.now());
    mocks.rpc.mockClear(); catalogJob(); mocks.coverage.mockRejectedValue(new Error("Jev paid answer could not be checkpointed"));
    await runDirectedResearchWorker(1);
    deferred = mocks.rpc.mock.calls.find(([name]) => name === "intelligence_catalog_defer")![1];
    expect(deferred.p_retry_at).toBeNull();
  });
  it("retries a transient source-attempt read after many healthy catalog claims without repeating research writes", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    catalogJob({ attempts: 120 });
    mocks.coverage.mockResolvedValue({ outcome: "catalog_needs_research", answered: 47, researchFacets: ["rr_c02"] });
    mocks.sourceState.mockResolvedValue({ cursor: { knownUrls: ["https://example.com/services"] } });
    tableErrors.intelligence_research_attempts = { code: "57014", message: "Private query details" };
    await runDirectedResearchWorker(1);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_catalog_defer", {
      p_company: "company", p_lease: "lease", p_reason: "research_source_attempts_unavailable:57014|read_retry=1",
      p_retry_at: new Date(now + 60_000).toISOString(),
    });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "intelligence_catalog_research_finish")).toBe(false);
  });
  it("bounds consecutive read failures with durable backoff independent of lifetime attempts", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let previous: string | null = null;
    for (const [index, delay] of [60_000, 120_000, 240_000, 480_000, null].entries()) {
      mocks.rpc.mockClear();
      catalogJob({ attempts: 200 + index, last_error: previous });
      // A failing read at another stage is still the same uninterrupted failure streak.
      const reason = index % 2 ? "catalog_sources_unavailable" : "research_discovery_unavailable";
      mocks.coverage.mockRejectedValue(new Error(reason));
      await runDirectedResearchWorker(1);
      const deferred = mocks.rpc.mock.calls.find(([name]) => name === "intelligence_catalog_defer")![1];
      expect(deferred.p_reason).toBe(`${reason}|read_retry=${index + 1}`);
      expect(deferred.p_retry_at).toBe(delay === null ? null : new Date(now + delay).toISOString());
      previous = deferred.p_reason;
    }
    mocks.rpc.mockClear();
    // A durable successful checkpoint clears last_error; a later new incident gets a fresh budget.
    catalogJob({ attempts: 300, last_error: null });
    mocks.coverage.mockRejectedValue(new Error("catalog_answers_unavailable"));
    await runDirectedResearchWorker(1);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_catalog_defer", expect.objectContaining({
      p_reason: "catalog_answers_unavailable|read_retry=1", p_retry_at: new Date(now + 60_000).toISOString(),
    }));
  });
  it.each([
    "research_source_attempts_unavailable:42P01", "research_source_attempts_unavailable:42501",
    "catalog_checkpoint_unavailable", "catalog_research_finish_failed", "external_research_sources_failed",
    "external_research_finish_failed", "external_research_claim_failed", "dispatch_ticket_expired",
  ])("keeps nontransient reads or uncertain actions held: %s", async reason => {
    catalogJob({ attempts: 1 });
    mocks.coverage.mockRejectedValue(new Error(reason));
    await runDirectedResearchWorker(1);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_catalog_defer", expect.objectContaining({
      p_reason: reason, p_retry_at: null,
    }));
  });
});

describe("concurrent next-source research", () => {
  it("defers a duplicate refresh until its active native ranking is ready, then claims in the cached order", async () => {
    mocks.rank.mockResolvedValueOnce({ candidates, providerUsed: false, scores: [], outcome: "busy", rankingVersion: "current" });
    const started = Date.now();
    const waiting = await refreshAccountResearch("company", { deadlineMs: started + 90_000, automatic: true, profile });
    expect(waiting).toMatchObject({ sources: 0, outcome: "ranking_pending", remainingSources: candidates.length,
      ranking: { outcome: "busy" } });
    expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThanOrEqual(started + 60_000);
    expect(Date.parse(waiting.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();

    const ranked = [candidates[3], candidates[2], candidates[0], candidates[1]];
    mocks.rank.mockResolvedValueOnce({ candidates: ranked, providerUsed: false, reused: true, scores: [], outcome: "ranked", rankingVersion: "current" });
    const resumed = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(resumed.outcome).toBe("sources_leased");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: "company", p_urls: ranked });
    expect(mocks.rank).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: "company", automaticResearch: true }));
  });

  it.each(["provider_unavailable", "budget_deferred"])("preserves existing source coverage fallback on %s", async outcome => {
    mocks.rank.mockResolvedValue({ candidates, providerUsed: false, scores: [], outcome, rankingVersion: "current" });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(result.outcome).toBe("sources_leased");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: "company", p_urls: candidates });
  });

  it.each([
    ['<meta property="article:published_time" content="2026-09-17">', "2026-09-17T00:00:00.000Z", "page_publication"],
    ['<meta property="article:published_time" content="2026-09-17"><meta name="datePublished" content="2026-09-18">', null, "unknown"],
    ["", null, "unknown"],
  ])("uses the ordinary website date contract for identical deep-page evidence", async (dates, eventDate, basis) => {
    mocks.rank.mockResolvedValue({ candidates, providerUsed: false, scores: [], outcome: "ranked", rankingVersion: "current" });
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_research_claim"
      ? [{ source_url: candidates[0], lease_token: "lease" }] : true, error: null }));
    mocks.fetch.mockResolvedValue({ status: 200, finalUrl: candidates[0], body: `${dates}<main>The company delivers project services.</main>` });
    mocks.enqueue.mockResolvedValue({ id: "observation", queued: false });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile });
    expect(result).toMatchObject({ sources: 1, outcomes: ["unchanged"] });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ title: "Synthetic Consulting company website", eventDate,
      metadata: expect.objectContaining({ eventDateBasis: basis,
        researchCriteria: expect.arrayContaining(["project_delivery", "multi_entity", "multi_location", "project_billing"]) }) }));
  });
});

describe("deadline-driven account research", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  function jobs(count: number) {
    const queue = Array.from({ length: count }, (_, index) => ({ company_id: `company-${index}`, desired_hash: `hash-${index}`,
      lease_token: `lease-${index}`, attempts: 1 }));
    tables.companies = queue.map(job => ({ id: job.company_id, name: job.company_id, domain: "example.com" }));
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_directed_claim" ? queue.splice(0, 1) : true, error: null }));
    return queue;
  }

  it("drains more than eight distinct accounts while retaining the same caught-up decisions and paid-call reuse", async () => {
    jobs(13);
    const result = await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000);
    expect(result).toMatchObject({ mode: "drain", concurrency: 2, claimed: 13, processed: 13, peakInFlight: 2,
      stoppedBy: "queue_empty_or_capacity", outcomes: { caught_up: 13 } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_directed_finish")).toHaveLength(13);
    expect(new Set(mocks.external.mock.calls.map(([company]) => company.id)).size).toBe(13);
    expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refills a free slot before a slower account completes, and awaits the slower account before returning", async () => {
    jobs(3);
    const slow = deferred<{ sources: number }>(), thirdStarted = deferred<void>();
    mocks.external.mockImplementation((company: { id: string }) => {
      if (company.id === "company-0") return slow.promise;
      if (company.id === "company-2") thirdStarted.resolve();
      return Promise.resolve({ sources: 0 });
    });
    let settled = false;
    const running = runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000)
      .then(result => { settled = true; return result; });
    await thirdStarted.promise;
    expect(settled).toBe(false);
    expect(mocks.rpc.mock.calls.some(([name, args]) => name === "intelligence_directed_finish" && args.p_company === "company-0")).toBe(false);
    slow.resolve({ sources: 0 });
    expect(await running).toMatchObject({ processed: 3, peakInFlight: 2, stoppedBy: "queue_empty_or_capacity" });
  });

  it("preserves finite sequential callers and their eight-account maximum", async () => {
    const queue = jobs(10);
    expect(await runDirectedResearchWorker(100, Date.now() + 275_000)).toMatchObject({ mode: "bounded", processed: 8, claimed: 8,
      concurrency: 1, peakInFlight: 1, stoppedBy: "batch_limit" });
    expect(queue).toHaveLength(2);
  });

  it.each([
    [150_000, 140_000, 150_000],
    [null, 170_000, 180_000],
    [500_000, 275_000, 275_000],
  ])("bounds each account to its lease with a completion reserve: lease offset %s", async (leaseOffset, researchOffset, finishOffset) => {
    const initial = Date.now(), queue = jobs(1);
    vi.spyOn(Date, "now").mockReturnValue(initial);
    Object.assign(queue[0], { lease_until: leaseOffset === null ? null : new Date(initial + leaseOffset).toISOString() });
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, initial + 275_000))
      .toMatchObject({ processed: 1, outcomes: { caught_up: 1 } });
    expect(mocks.external).toHaveBeenCalledWith(expect.objectContaining({ id: "company-0" }), expect.any(Array), expect.any(Array), initial + researchOffset);
    expect(withServiceDeadline).toHaveBeenCalledWith(initial + finishOffset, expect.any(Function));
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_status: "complete" }));
  });

  it("defers an account whose returned lease has insufficient research time instead of outliving that lease", async () => {
    const initial = Date.now(), queue = jobs(1);
    vi.spyOn(Date, "now").mockReturnValue(initial);
    Object.assign(queue[0], { lease_until: new Date(initial + 40_000).toISOString() });
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, initial + 275_000))
      .toMatchObject({ processed: 1, outcomes: { deadline_deferred: 1 } });
    expect(mocks.external).not.toHaveBeenCalled(); expect(mocks.rank).not.toHaveBeenCalled();
    expect(withServiceDeadline).toHaveBeenCalledWith(initial + 40_000, expect.any(Function));
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_status: "queued" }));
  });

  it("does not reserve new work inside the minimum useful runtime", async () => {
    jobs(2);
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 39_000))
      .toMatchObject({ processed: 0, claimed: 0, peakInFlight: 0, stoppedBy: "deadline" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stops refilling at the deadline and durably defers a claim that arrives late", async () => {
    const queue = jobs(3), initial = Date.now();
    let now = initial;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.rpc.mockImplementation(async name => {
      if (name === "intelligence_directed_claim") { now = initial + 70_000; return { data: queue.splice(0, 1), error: null }; }
      return { data: true, error: null };
    });
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, initial + 100_000))
      .toMatchObject({ processed: 1, claimed: 1, stoppedBy: "deadline", outcomes: { deadline_deferred: 1 }, durationMs: 70_000 });
    expect(queue).toHaveLength(2);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_status: "queued",
      p_result: expect.objectContaining({ outcome: "deadline_deferred" }) }));
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("exits an empty queue without polling, ranking or source reads", async () => {
    jobs(0);
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000))
      .toMatchObject({ processed: 0, claimed: 0, peakInFlight: 0, stoppedBy: "queue_empty_or_capacity" });
    expect(mocks.rpc).toHaveBeenCalledOnce(); expect(mocks.from).not.toHaveBeenCalled();
  });

  it("retains failure backoff and continues independent accounts", async () => {
    const queue = jobs(3);
    queue[0].attempts = 6;
    tables.companies = tables.companies.filter(row => row.id !== "company-0");
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000))
      .toMatchObject({ processed: 3, outcomes: { service_error: 1, caught_up: 2 }, stoppedBy: "queue_empty_or_capacity" });
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_company: "company-0",
      p_status: "failed", p_error: "research_service_error", p_result: null, p_retry_seconds: 19_200 }));
  });

  it("awaits healthy owned work after a later claim fails and reports that stop", async () => {
    const queue = jobs(2), slow = deferred<{ sources: number }>(), sourceStarted = deferred<void>();
    let claims = 0, settled = false;
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_directed_claim" ? (++claims === 1 ? queue.splice(0, 1) : null) : true,
      error: name === "intelligence_directed_claim" && claims > 1 ? { message: "database unavailable" } : null }));
    mocks.external.mockImplementation(() => { sourceStarted.resolve(); return slow.promise; });
    const running = runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000)
      .then(result => { settled = true; return result; });
    await sourceStarted.promise;
    expect(settled).toBe(false);
    slow.resolve({ sources: 0 });
    expect(await running).toMatchObject({ processed: 1, claimed: 1, stoppedBy: "claim_error", outcomes: { claim_error: 1, caught_up: 1 } });
    expect(claims).toBe(2);
  });

  it("refuses an unexpected duplicate account claim without racing or finishing its active lease", async () => {
    const queue = jobs(2);
    queue[1] = { ...queue[0], lease_token: "unexpected-second-lease" };
    expect(await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 275_000))
      .toMatchObject({ processed: 1, claimed: 2, peakInFlight: 1, stoppedBy: "duplicate_claim", outcomes: { duplicate_claim: 1, caught_up: 1 } });
    expect(mocks.external).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_directed_finish")).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_lease: "lease-0" }));
  });

  it("waits for every healthy source read before reporting one source's failed durable finish", async () => {
    const slowSource = deferred<{ status: number; finalUrl: string; body: string }>(), failedFinish = deferred<void>();
    mocks.rank.mockResolvedValue({ candidates: candidates.slice(0, 2), providerUsed: false, scores: [], outcome: "not_needed", rankingVersion: "current" });
    mocks.rpc.mockImplementation(async (name, args) => {
      if (name === "intelligence_research_claim") return { data: candidates.slice(0, 2).map(source_url => ({ source_url, lease_token: source_url })), error: null };
      if (name === "intelligence_research_finish" && args.p_url === candidates[0]) {
        failedFinish.resolve(); return { data: false, error: null };
      }
      return { data: true, error: null };
    });
    mocks.fetch.mockImplementation((url: string) => url === candidates[1] ? slowSource.promise
      : Promise.resolve({ status: 200, finalUrl: url, body: "<main>Project services</main>" }));
    mocks.enqueue.mockResolvedValue({ id: "observation", queued: false });
    let settled = false;
    const running = refreshAccountResearch("company", { profile, deadlineMs: Date.now() + 275_000, automatic: true })
      .then(() => { settled = true; return "unexpected_success"; }, error => { settled = true; return error.message; });
    await failedFinish.promise;
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(settled).toBe(false);
    slowSource.resolve({ status: 200, finalUrl: candidates[1], body: "<main>Project services</main>" });
    expect(await running).toBe("research_completion_failed");
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_finish", expect.objectContaining({ p_url: candidates[1], p_outcome: "unchanged" }));
  });
});

describe("known-source research lifecycle", () => {
  const idle = () => ({ ...profile, candidates: [], nextAttemptAt: future(),
    sweep: { knownSources: 4, dueSources: 0, unreadSources: 0, leasedSources: 0, retrySources: 0 } });

  it("marks a processed source set caught up despite unknown topics, preserving periodic discovery without paid ranking", async () => {
    const loaded = idle();
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile: loaded });
    expect(result).toMatchObject({ outcome: "caught_up", sources: 0, nextAttemptAt: loaded.nextAttemptAt, sweep: loaded.sweep });
    expect(mocks.external).toHaveBeenCalledOnce();
    expect(mocks.rank).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [{ leasedSources: 1 }, 0, "sources_leased"],
    [{}, 1, "waiting_interpretation"],
    [{ retrySources: 1, unreadSources: 1 }, 0, "waiting_retry"],
  ])("does not call unfinished work caught up: %j", async (sweep, pending, outcome) => {
    const loaded = idle();
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true,
      profile: { ...loaded, pendingJobs: pending, sweep: { ...loaded.sweep, ...sweep } } });
    expect(result.outcome).toBe(outcome);
    expect(mocks.rank).not.toHaveBeenCalled();
    if (outcome === "waiting_interpretation") expect(Date.parse(result.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 600_000);
    else expect(result.nextAttemptAt).toBe(loaded.nextAttemptAt);
  });

  it("uses the existing earlier discovery deadline while caught up", async () => {
    const nextAttemptAt = new Date(Date.now() + 86400_000).toISOString();
    mocks.external.mockResolvedValue({ sources: 0, nextAttemptAt });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true, profile: idle() });
    expect(result).toMatchObject({ outcome: "caught_up", nextAttemptAt });
  });

  it("reports unresolved failed or missing interpretations instead of caught up without retrying paid work", async () => {
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true,
      profile: { ...idle(), unresolvedInterpretations: 2 } });
    expect(result).toMatchObject({ outcome: "interpretation_failed", unresolvedInterpretations: 2, sources: 0 });
    expect(mocks.rank).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("counts only current nonexcluded interpretation work, including evidence with no runnable job", async () => {
    const observation = (id: string, is_current = true, feedback_excluded = false) => ({ id, company_id: "company", source_url: `https://example.com/${id}`,
      source_kind: "website", title: "Company source", event_date: null, observed_at: new Date().toISOString(), evidence_text: "Company services", attributes: null,
      is_current, feedback_excluded });
    tables.intelligence_observations = [observation("failed"), observation("missing"), observation("pending"), observation("old", false), observation("excluded", true, true)];
    const job = (id: string, status: string, is_current = true, feedback_excluded = false, kind = "interpret") => ({
      id, observation_id: id, status, kind, intelligence_observations: { company_id: "company", is_current, feedback_excluded },
    });
    tables.intelligence_jobs = [job("failed", "failed"), job("pending", "queued"), job("old", "failed", false),
      job("excluded", "running", true, true), job("view", "queued", true, false, "view")];
    const loaded = await loadResearchProfile("company");
    expect(loaded.pendingJobs).toBe(1); expect(loaded.unresolvedInterpretations).toBe(2);
  });

  it("counts work outside the old 200-source window and keeps the candidate batch bounded", async () => {
    const urls = Array.from({ length: 205 }, (_, index) => `https://example.com/page-${String(index).padStart(3, "0")}`);
    tables.intelligence_research_sources = urls.map(source_url => ({ source_url, title: source_url, metadata: {} }));
    tables.intelligence_research_attempts = urls.slice(0, 204).map(source_url => ({ source_url, next_attempt_at: future(),
      last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(), lease_until: null, outcome: "unchanged" }));
    const loaded = await loadResearchProfile("company");
    expect(loaded.sweep).toEqual({ knownSources: 205, dueSources: 1, unreadSources: 1, leasedSources: 0, retrySources: 0 });
    expect(loaded.candidates).toEqual([urls[204]]);
    expect(loaded.discoveredSourceCount).toBe(205);
  });

  it("distinguishes source retries and active leases from successful known sources", () => {
    const now = Date.now(), next = new Date(now + 86400_000).toISOString();
    const attempt = { next_attempt_at: next, last_attempt_at: new Date(now).toISOString(), last_success_at: null, lease_until: null };
    expect(researchSweepState(["good", "failed", "empty", "leased", "new"], [
      { ...attempt, source_url: "good", outcome: "unchanged", last_success_at: new Date(now).toISOString() },
      { ...attempt, source_url: "failed", outcome: "source_failed" },
      { ...attempt, source_url: "empty", outcome: "source_empty" },
      { ...attempt, source_url: "leased", outcome: null, lease_until: next },
    ], new Set(), now)).toEqual({ knownSources: 5, dueSources: 1, unreadSources: 4, leasedSources: 1, retrySources: 2 });
  });

  it("wakes a caught-up profile for newly discovered sources without changing manual source selection", async () => {
    mocks.external.mockResolvedValue({ sources: 1 });
    tables.intelligence_research_sources = [{ source_url: candidates[0], title: "About", metadata: {} }];
    mocks.rank.mockResolvedValue({ candidates: [candidates[0]], providerUsed: false, scores: [], outcome: "not_needed", rankingVersion: "current" });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: false, profile: idle() });
    expect(result.outcome).toBe("sources_leased");
    expect(mocks.rank).toHaveBeenCalledWith(expect.objectContaining({ automaticResearch: false, candidates: [candidates[0]] }));
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: "company", p_urls: [candidates[0]] });
  });

  it.each([false, true])("does not invent a new backlog from stored links, preserving pending interpretation=%s", async queued => {
    const source = candidates[0], existing = candidates[1];
    tables.intelligence_research_sources = [source, existing].map(source_url => ({ source_url, title: "Existing source", metadata: {} }));
    tables.intelligence_research_attempts = [source, existing].map(source_url => ({ source_url, next_attempt_at: future(),
      last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(), outcome: "unchanged", lease_until: null }));
    mocks.rank.mockResolvedValue({ candidates: [source], providerUsed: false, scores: [], outcome: "not_needed", rankingVersion: "current" });
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_research_claim" ? [{ source_url: source, lease_token: "lease" }] : true, error: null }));
    mocks.fetch.mockResolvedValue({ status: 200, finalUrl: source, body: `<main>Project services <a href="${existing}">Team</a></main>` });
    pendingJobs = queued ? 1 : 0;
    mocks.enqueue.mockResolvedValue({ id: "observation", queued });
    const result = await refreshAccountResearch("company", { deadlineMs: Date.now() + 90_000, automatic: true,
      profile: { ...profile, candidates: [source], nextAttemptAt: future(), sweep: { knownSources: 2, dueSources: 1, unreadSources: 0, leasedSources: 0, retrySources: 0 } } });
    expect(result).toMatchObject({ sources: 1, outcomes: [queued ? "queued" : "unchanged"], remainingSources: 0,
      outcome: queued ? "waiting_interpretation" : "caught_up" });
    if (queued) expect(Date.parse(result.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it.each([[0, "complete", "caught_up"], [1, "queued", "waiting_interpretation"]])("finishes directed work with truthful status when %s interpretations remain", async (pending, status, outcome) => {
    pendingJobs = pending as number;
    mocks.rpc.mockImplementation(async name => ({ data: name === "intelligence_directed_claim"
      ? [{ company_id: "company", desired_hash: "hash", lease_token: "lease", attempts: 1 }] : true, error: null }));
    const result = await runDirectedResearchWorker(1, Date.now() + 90_000);
    expect(result.outcomes).toEqual({ [outcome]: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_status: status,
      p_result: expect.objectContaining({ outcome }) }));
    expect(mocks.rank).not.toHaveBeenCalled();
  });
});
