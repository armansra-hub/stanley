import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), reserve: vi.fn(), settle: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true }));
vi.mock("./budget", () => ({ reserveGeneration: mocks.reserve, settleGeneration: mocks.settle, secondsUntilNextMonth: () => 9999 }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.generate }; } }));
import { ACCOUNT_WRITER_MODEL, runAccountStoryWorker, storyEvidenceHash, type StoryEvidence } from "./narratives";
const company = { id: "company", name: "Synthetic Services", domain: "example.test", subindustry: null, ns_industry: null };
const source: StoryEvidence = { id: "source", company_id: company.id, content_hash: "changed-source", is_current: true,
  source_url: "https://example.test/news", title: "New distribution center", source_kind: "news", event_date: "2026-09-18",
  observed_at: "2026-09-18", evidence_text: "Synthetic Services opened a distribution center in Austin.",
  attributes: { companyRelationship: "direct", companyRelevance: .9, concreteEvent: .9, signalType: "press" } };
const story = { overview: [{ text: "The company opened an Austin distribution center.", citations: [source.id] }],
  developments: [], hypotheses: [], contradictions: [], unknowns: ["Current systems"] };
type Call = { table: string; filters: unknown[][]; patch?: Record<string, unknown> };
let job: Record<string, unknown>, calls: Call[], stale: boolean;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key"); calls = []; stale = false;
  job = { company_id: company.id, desired_hash: storyEvidenceHash(company, [source]), lease_token: "lease", attempts: 1,
    force_requested: true, checkpoint: null };
  let claimed = false;
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_story_claim"
    ? claimed ? [] : (claimed = true, [job]) : true, error: null }));
  mocks.from.mockImplementation((table: string) => {
    const call: Call = { table, filters: [] }; calls.push(call);
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gt", "not", "order", "limit"]) query[method] = (...args: unknown[]) => { call.filters.push([method, ...args]); return query; };
    query.update = (patch: Record<string, unknown>) => { call.patch = patch; return query; };
    const result = () => ({ data: table === "companies" ? company : table === "intelligence_observations"
      ? call.filters.some(filter => filter[0] === "eq" && filter[1] === "is_current" && filter[2] === false) ? [] : [source]
      : call.patch ? stale ? null : { company_id: company.id } : null, error: null });
    query.single = query.maybeSingle = async () => result();
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  });
  mocks.reserve.mockResolvedValue("reservation"); mocks.settle.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(story) }],
    usage: { input_tokens: 1100, output_tokens: 230 } });
});
afterEach(() => vi.unstubAllEnvs());
describe("budgeted resumable account writing", () => {
  it("reserves before one writing call and checkpoints cited output under the exact lease", async () => {
    expect(await runAccountStoryWorker(1)).toMatchObject({ processed: 1, outcomes: { complete: 1 } });
    expect(mocks.reserve).toHaveBeenCalledWith(ACCOUNT_WRITER_MODEL);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]);
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledWith("reservation", { inputTokens: 1100, outputTokens: 230,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    const checkpoint = calls.find(call => call.patch?.checkpoint)!;
    expect(checkpoint.filters).toContainEqual(["eq", "lease_token", "lease"]);
    expect(checkpoint.filters).toContainEqual(["eq", "desired_hash", job.desired_hash]);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_story_finish", expect.objectContaining({ p_status: "complete", p_story: story }));
  });
  it("defers when generation budget is exhausted without calling the provider", async () => {
    mocks.reserve.mockResolvedValue(null);
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { budget_deferred: 1 } });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_story_finish", expect.objectContaining({ p_status: "queued", p_retry_seconds: 9999 }));
  });
  it("reuses a paid checkpoint after interruption without another reservation or call", async () => {
    job.checkpoint = { hash: job.desired_hash, story, observationIds: [source.id], coverage: {}, model: ACCOUNT_WRITER_MODEL };
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { complete: 1 } });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("never publishes a generated result after its account evidence lease is superseded", async () => {
    stale = true;
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { superseded: 1 } });
    expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "intelligence_story_finish")).toEqual([]);
  });
  it("retains unknown provider spend and backs off transient writing failures", async () => {
    mocks.generate.mockRejectedValue(new Error("synthetic timeout"));
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { writer_unavailable: 1 } });
    expect(mocks.settle).toHaveBeenCalledWith("reservation", null);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_story_finish", expect.objectContaining({ p_status: "queued", p_error: "writer_unavailable" }));
  });
  it("dirty wakeups compute the actual evidence hash before spending", async () => {
    job.desired_hash = "0".repeat(64);
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { superseded: 1 } });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_story_enqueue", expect.objectContaining({ p_hash: storyEvidenceHash(company, [source]) }));
  });
  it("does not retry malformed writing automatically or run a semantic reviewer", async () => {
    mocks.generate.mockResolvedValue({ content: [{ type: "text", text: "{" }], usage: { input_tokens: 1000, output_tokens: 1 } });
    expect(await runAccountStoryWorker(1)).toMatchObject({ outcomes: { writer_response_format: 1 } });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_story_finish", expect.objectContaining({ p_status: "failed", p_error: "writer_response_format" }));
  });
});
