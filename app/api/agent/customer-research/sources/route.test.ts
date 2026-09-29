import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: vi.fn(), unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: (_deadline: number, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/intelligence/customerResearchServer", () => ({
  CustomerResearchError: class extends Error { constructor(readonly code: string, readonly status = 503) { super(code); } }, loadCustomerResearchSavedSources: vi.fn(),
}));
import { agentAuthOk } from "@/lib/agent/auth";
import { loadCustomerResearchSavedSources } from "@/lib/intelligence/customerResearchServer";
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); vi.mocked(agentAuthOk).mockReturnValue(true); });
describe("private saved customer source export", () => {
  it("rejects unauthenticated reads without loading sources", async () => {
    vi.mocked(agentAuthOk).mockReturnValue(false);
    expect((await GET(new Request("https://stanley.example/api/agent/customer-research/sources?customerId=reference-1"))).status).toBe(401);
    expect(loadCustomerResearchSavedSources).not.toHaveBeenCalled();
  });
  it("requires an exact customer, not an unrestricted source dump", async () => {
    expect((await GET(new Request("https://stanley.example/api/agent/customer-research/sources"))).status).toBe(400);
    expect((await GET(new Request("https://stanley.example/api/agent/customer-research/sources?customerId=reference-1&runJev=1"))).status).toBe(400);
    expect(loadCustomerResearchSavedSources).not.toHaveBeenCalled();
  });
  it("forwards a stable continuation and returns no-store source evidence", async () => {
    vi.mocked(loadCustomerResearchSavedSources).mockResolvedValue({ sources: [], providerCalls: 0 } as unknown as Awaited<ReturnType<typeof loadCustomerResearchSavedSources>>);
    const response = await GET(new Request("https://stanley.example/api/agent/customer-research/sources?customerId=reference-1&offset=10&limit=10&registryUpdatedAt=2026-09-29T12:00:00Z"));
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.json()).toMatchObject({ providerCalls: 0 });
    expect(loadCustomerResearchSavedSources).toHaveBeenCalledWith({ customerId: "reference-1", offset: 10, limit: 10, registryUpdatedAt: "2026-09-29T12:00:00Z" });
  });
});
