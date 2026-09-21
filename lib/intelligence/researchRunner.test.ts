import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), sourceState: vi.fn(), external: vi.fn(), rank: vi.fn(), fetch: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
  withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("./researchRanking", () => ({ rankResearchCandidates: mocks.rank }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: mocks.enqueue }));
vi.mock("./sourceState", () => ({ readSourceState: mocks.sourceState }));
vi.mock("./atsLifecycle", () => ({ readAtsHiringContext: async () => null }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/publicPdf", () => ({ fetchPublicPdfEvidence: vi.fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
vi.mock("./researchExternal", () => ({ discoverExternalResearch: mocks.external }));
import { loadResearchProfile, refreshAccountResearch, researchSweepState, runDirectedResearchWorker, type ResearchProfile } from "./researchRunner";

const candidates = ["https://example.com/about", "https://example.com/team", "https://example.com/services", "https://example.com/billing"];
const profile = { company: { id: "company", name: "Synthetic Consulting", domain: "example.com" },
  missingTopics: ["project_billing"], candidates, candidateTitles: {}, researchFocus: "Investigate explicit project billing processes.",
  sweep: { knownSources: 4, dueSources: 4, unreadSources: 4, leasedSources: 0, retrySources: 0 }, pendingJobs: 0, unresolvedInterpretations: 0,
  nextAttemptAt: "2026-09-20T00:00:00Z" } as unknown as ResearchProfile;
let tables: Record<string, Record<string, unknown>[]>;
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
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: head ? null : rows, count: head ? pendingJobs : undefined, error: null }).then(resolve);
  return builder;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.external.mockResolvedValue({ sources: 0 });
  mocks.sourceState.mockResolvedValue({ cursor: null, lastSuccessAt: null });
  tables = { companies: [{ id: "company", name: "Synthetic Consulting", domain: "example.com" }] };
  pendingJobs = 0; inserted = [];
  mocks.from.mockImplementation(mockTable);
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
