import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), priority: vi.fn(), reheat: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/agent/auth", async () => ({ agentAuthOk: (req: Request) => req.headers.get("authorization") === "Bearer synthetic-test-token",
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.priority }));
vi.mock("@/lib/db/reheat", () => ({ reheatCompanyForFreshSignal: mocks.reheat }));
import { GET, POST } from "./route";

const id = "10000000-0000-4000-8000-000000000001", lease = "20000000-0000-4000-8000-000000000001";
const originalHash = "a".repeat(64), decisionHash = "b".repeat(64);
const reviewer = { taskId: "/root/reviewer", model: "gpt-6-astra", snapshotHash: originalHash, readStart: 0, readEnd: 10, fullTextRead: true };
const review = { reviewer, decisionHash, approved: true, rationale: "I independently read the complete source and validated identity, date and exact event evidence.",
  identityConfirmed: true, dateChecked: true, sourceLimitationsChecked: true };
const finish = { action: "finish", jobId: id, lease, snapshotHash: originalHash, review };
const request = (body: unknown, headers = { authorization: "Bearer synthetic-test-token", "x-agent-name": "codex" }) => new Request("https://stanley.test/api/agent/intelligence/news", { method: "POST", headers, body: JSON.stringify(body) });
function completed() {
  const receipt = { jobId: id, decisionHash, snapshotHash: originalHash, eventId: "event", triggerId: "trigger", disposition: "publish" };
  return { jobId: id, status: "complete", lease: null, leaseUntil: null, snapshotHash: "c".repeat(64),
    review: { actor: "/root/reader", requestId: id, snapshotHash: originalHash, decisionHash, receipt, independentReview: review },
    snapshot: { observation: { id: "observation", company_id: "company", evidence_text: "Whole text", source_kind: "news", is_current: true, feedback_excluded: false, source_url: "https://acme.com/news/office",
      event_date: "2026-09-20T00:00:00Z", observed_at: "2026-09-29T00:00:00Z", metadata: { articleBodyAvailable: true, evidenceKind: "article_body" } },
      company: { id: "company", name: "Acme", domain: "acme.com", subindustry: null, status: "new" }, identity: {} },
    publication: { event: { id: "event", meta: { jobId: id, decisionHash, snapshotHash: originalHash } },
      trigger: { id: "trigger", company_id: "company", type: "press", source_url: "https://acme.com/news/office", signal_date: "2026-09-20T00:00:00Z",
        metadata: { codexNewsFindings: { [id]: { decisionHash, snapshotHash: originalHash } } } } } };
}
beforeEach(() => { vi.clearAllMocks(); mocks.priority.mockResolvedValue(undefined); mocks.reheat.mockResolvedValue(false); });
describe("exact Codex news bridge", () => {
  it("requires existing header authentication and explicit Codex identity", async () => {
    expect((await POST(request({ action: "claim" }, { authorization: "Bearer wrong", "x-agent-name": "codex" }))).status).toBe(401);
    expect((await POST(request({ action: "claim" }, { authorization: "Bearer synthetic-test-token", "x-agent-name": "claude" }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("claims exactly once with the caller's durable request ID; uncertainty does not auto-retry", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "connection_lost" } });
    expect((await POST(request({ action: "claim", requestId: id, taskId: "/root/reader" }))).status).toBe(409);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_codex_news", { p_action: "claim", p_payload: { action: "claim", requestId: id, taskId: "/root/reader" } });
  });
  it("offers read-only exact request recovery and rejects unbounded reads", async () => {
    mocks.rpc.mockResolvedValue({ data: completed(), error: null });
    const headers = { authorization: "Bearer synthetic-test-token", "x-agent-name": "codex" };
    expect((await GET(new Request(`https://stanley.test/api/agent/intelligence/news?requestId=${id}`, { headers }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_codex_news", { p_action: "status", p_payload: { requestId: id } });
    expect((await GET(new Request("https://stanley.test/api/agent/intelligence/news", { headers }))).status).toBe(400);
  });
  it("recovers after reheat changed the snapshot and priority failed, without reanalysis or publication", async () => {
    mocks.rpc.mockResolvedValue({ data: completed(), error: null });
    mocks.priority.mockRejectedValueOnce(new Error("transient write"));
    expect((await POST(request(finish))).status).toBe(409);
    expect((await POST(request(finish))).status).toBe(200);
    expect(mocks.rpc.mock.calls.every(([, args]) => args.p_action === "read")).toBe(true);
    expect(mocks.priority).toHaveBeenCalledTimes(2);
    expect(mocks.reheat).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed review or missing exact event on a completed-job retry", async () => {
    mocks.rpc.mockResolvedValue({ data: completed(), error: null });
    expect((await POST(request({ ...finish, review: { ...review, rationale: "A different review must not silently replace the original saved independent judgment." } }))).status).toBe(409);
    const p = completed(); p.publication.event.meta.decisionHash = "d".repeat(64);
    mocks.rpc.mockResolvedValue({ data: p, error: null });
    expect((await POST(request(finish))).status).toBe(409);
    expect(mocks.priority).not.toHaveBeenCalled();
  });
  it("retains a historical receipt without reheating evidence that was later excluded", async () => {
    const p = completed(); p.snapshot.observation.feedback_excluded = true;
    mocks.rpc.mockResolvedValue({ data: p, error: null });
    expect((await POST(request(finish))).status).toBe(200);
    expect(mocks.reheat).not.toHaveBeenCalled();
    expect(mocks.priority).not.toHaveBeenCalled();
  });
});
