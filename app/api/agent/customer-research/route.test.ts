import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: vi.fn(), unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: (_deadline: number, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/intelligence/customerResearchServer", () => ({
  CustomerResearchError: class extends Error { constructor(readonly code: string, readonly status = 503) { super(code); } },
  customerResearchProgress: vi.fn(), getCustomerResearchProof: vi.fn(), loadCustomerResearchPage: vi.fn(), saveCustomerResearchProfile: vi.fn(),
}));
import { agentAuthOk } from "@/lib/agent/auth";
import { customerResearchProgress, getCustomerResearchProof, loadCustomerResearchPage, saveCustomerResearchProfile } from "@/lib/intelligence/customerResearchServer";
import { GET, POST } from "./route";
const request = (body: unknown, headers = {}) => new Request("https://stanley.example/api/agent/customer-research", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(agentAuthOk).mockReturnValue(true); });
describe("customer research agent route", () => {
  it("authenticates before any source or state access", async () => {
    vi.mocked(agentAuthOk).mockReturnValue(false);
    expect((await GET(new Request("https://stanley.example/api/agent/customer-research"))).status).toBe(401);
    expect((await POST(request({ profile: {} }))).status).toBe(401);
    expect(loadCustomerResearchPage).not.toHaveBeenCalled(); expect(saveCustomerResearchProfile).not.toHaveBeenCalled();
  });
  it("returns compact cursor results and separately labeled authored research progress", async () => {
    vi.mocked(loadCustomerResearchPage).mockResolvedValue({ records: [], nextAfter: null });
    vi.mocked(customerResearchProgress).mockResolvedValue({ total: 823, started: 0, notStarted: 823, draft: 0, inProgress: 0, complete: 0,
      completeWithGaps: 0, unresolved: 0, facts: 0, readPages: 0, pendingPages: 0, unreadPages: 0, unavailablePages: 0, latestUpdatedAt: null, origin: "codex_research", providerCalls: 0 });
    const response = await GET(new Request("https://stanley.example/api/agent/customer-research?limit=25"));
    expect(await response.json()).toMatchObject({ records: [], progress: { complete: 0 }, providerCalls: 0 });
  });
  it("returns an exact missing profile without inventing one from native status", async () => {
    vi.mocked(getCustomerResearchProof).mockResolvedValue(null);
    expect((await GET(new Request("https://stanley.example/api/agent/customer-research?customerId=reference-1"))).status).toBe(404);
    expect(customerResearchProgress).not.toHaveBeenCalled();
  });
  it("rejects oversize full profiles explicitly and never truncates them", async () => {
    const response = await POST(request({ profile: {} }, { "content-length": String(4 * 1024 * 1024 + 1) }));
    expect(response.status).toBe(413); expect((await response.json()).error).toBe("customer_profile_exceeds_4mb");
    expect(saveCustomerResearchProfile).not.toHaveBeenCalled();
  });
  it("forwards only one profile and its exact previous hash", async () => {
    vi.mocked(saveCustomerResearchProfile).mockResolvedValue({ customerId: "reference-1", fullProfileSha256: "a".repeat(64), status: "draft", saved: true, providerCalls: 0,
      coverage: { discovered: 0, captured: 0, read: 0, pending: 0, unread: 0, unavailable: 0, excluded: 0, discoveryComplete: false } });
    const response = await POST(request({ profile: { id: "full-input" }, expectedPreviousHash: "a".repeat(64) }));
    expect(response.status).toBe(200); expect(saveCustomerResearchProfile).toHaveBeenCalledWith({ id: "full-input" }, "a".repeat(64));
    expect((await POST(request({ profile: {}, approveTaxonomy: true }))).status).toBe(400);
  });
});
