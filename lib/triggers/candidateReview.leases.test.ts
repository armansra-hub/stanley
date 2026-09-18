import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), rpc: vi.fn(), from: vi.fn(), reserve: vi.fn(), settle: vi.fn(), verify: vi.fn(), fetch: vi.fn(), promote: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }), withServiceDeadline: (_n: number, fn: () => unknown) => fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("@/lib/intelligence/budget", () => ({ generationModelSupported: () => true, reserveGeneration: mocks.reserve, settleGeneration: mocks.settle, secondsUntilNextMonth: () => 1000 }));
vi.mock("@/lib/triggers/classify", () => ({ CANDIDATE_VERIFIER_MODEL: "claude-haiku-4-5", candidateVerifierConfigured: () => true, verifyCandidateEvidenceLLM: mocks.verify }));
vi.mock("@/lib/db/triggers", () => ({ promoteCandidate: mocks.promote }));
vi.mock("@/lib/triggers/urlSafety", () => ({ validatePublicHttpUrl: (url: string) => new URL(url), fetchPublicHttpText: mocks.fetch }));
import { candidateRetrySeconds, reviewPendingCandidates } from "./candidateReview";

type Call = { table: string; patch?: Record<string, unknown>; filters: unknown[][] };
let calls: Call[];
let stale: boolean;
const candidate = { id: "candidate-1", company_id: "company-1", company_name: "Example Engineering", type: "operating_change", summary: "Example adds project delivery", source_name: "Company website", source_url: "https://example.test/news/projects", review_lease_token: "lease-1", review_attempts: 1, verdict: null };
const verdict = { exact_company: true, concrete_event: true, event: "operating_change", is_acquirer: false, confidence: "high", reason: "The source announces the change." };

beforeEach(() => {
  vi.clearAllMocks(); calls = []; stale = false;
  mocks.enabled.mockReturnValue(true);
  mocks.reserve.mockResolvedValue("reservation"); mocks.settle.mockResolvedValue(undefined);
  mocks.promote.mockResolvedValue(true);
  mocks.verify.mockImplementation(async (_input, options) => { options.onUsage({ inputTokens: 1000, outputTokens: 80 }); return verdict; });
  mocks.fetch.mockResolvedValue({ status: 200, finalUrl: candidate.source_url, body: `<p>${"Example Engineering launched a project delivery and milestone billing program. ".repeat(3)}</p>` });
  mocks.rpc.mockResolvedValueOnce({ data: [candidate], error: null }).mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table: string) => {
    const call: Call = { table, filters: [] }; calls.push(call);
    const result = () => ({ data: table === "intelligence_config" ? { enabled: true } : table === "companies" ? [{ id: "company-1", name: "Example Engineering", domain: "example.test", status: "new" }] : call.patch ? (stale ? null : { id: candidate.id }) : [], error: null });
    const query: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gt", "is", "or", "in", "order", "limit"]) query[op] = (...args: unknown[]) => { call.filters.push([op, ...args]); return query; };
    query.update = (patch: Record<string, unknown>) => { call.patch = patch; return query; };
    query.single = query.maybeSingle = async () => result();
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  });
});

describe("leased final candidate review", () => {
  it("reserves, independently verifies, settles, and fences the decision before promotion", async () => {
    const result = await reviewPendingCandidates(2);
    expect(result).toMatchObject({ checked: 1, kept: 1, promoted: 1 });
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.verify.mock.invocationCallOrder[0]);
    expect(mocks.settle).toHaveBeenCalledWith("reservation", { inputTokens: 1000, outputTokens: 80 });
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ evidenceUrl: candidate.source_url }), expect.objectContaining({ singleAttempt: true }));
    expect(mocks.promote).toHaveBeenCalledWith(candidate.id, { leaseToken: candidate.review_lease_token });
    const write = calls.find(call => call.patch?.verdict === "keep")!;
    expect(write.filters).toContainEqual(["eq", "review_lease_token", "lease-1"]);
    expect(write.filters).toContainEqual(["gt", "review_lease_until", expect.any(String)]);
  });
  it("does not pay for or publish a candidate when the budget is full", async () => {
    mocks.reserve.mockResolvedValue(null);
    expect(await reviewPendingCandidates(2)).toMatchObject({ deferred_budget: 1, promoted: 0 });
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.promote).not.toHaveBeenCalled();
    expect(calls.find(call => call.patch?.review_last_error === "budget_deferred")?.patch?.review_due_at).toEqual(expect.any(String));
  });
  it("does not publish a paid result after losing the decision lease", async () => {
    stale = true;
    expect(await reviewPendingCandidates(2)).toMatchObject({ kept: 0, promoted: 0 });
    expect(mocks.settle).toHaveBeenCalled(); expect(mocks.promote).not.toHaveBeenCalled();
  });
  it("backs off ambiguous verifier failures and keeps unknown consumption reserved", async () => {
    mocks.verify.mockResolvedValue(null);
    expect(await reviewPendingCandidates(2)).toMatchObject({ deferred_verifier: 1, promoted: 0 });
    expect(mocks.settle).toHaveBeenCalledWith("reservation", null);
    const patch = calls.find(call => call.patch?.review_last_error === "verifier_unavailable")!.patch!;
    expect(Date.parse(String(patch.review_due_at))).toBeGreaterThan(Date.now() + 100_000);
    expect(patch.review_lease_token).toBeNull();
    expect(candidateRetrySeconds(50)).toBe(86_400);
  });
  it("recovers verified publication without fetching or purchasing another model call", async () => {
    mocks.rpc.mockReset().mockResolvedValueOnce({ data: [{ ...candidate, verdict: "keep" }], error: null }).mockResolvedValue({ data: [], error: null });
    expect(await reviewPendingCandidates(2)).toMatchObject({ promoted: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("keeps the legacy query path when the feature is disabled", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await reviewPendingCandidates(2)).toMatchObject({ checked: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    expect(calls.find(call => call.table === "trigger_candidates")?.filters).toContainEqual(["is", "verdict", null]);
  });
});
