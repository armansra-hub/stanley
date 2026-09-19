import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), enqueue: vi.fn(), calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/lib/intelligence/worker", () => ({ runIntelligenceWorker: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: m.enqueue }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: () => true, sameOriginMutation: () => true,
  isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value), smallJson: (request: Request) => request.json() }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: async () => ({ cursor: { verifiedUrls: ["https://example.test/services", "https://example.test/locations"] } }) }));
vi.mock("@/lib/triggers/urlSafety", () => ({ fetchPublicHttpText: m.fetch }));
vi.mock("@/lib/sources/siteDiscovery", () => ({ sameCompanySite: (url: string) => url.startsWith("https://example.test/"), sitePageKind: () => "services",
  sitePageEvidence: () => ({ url: "https://example.test/locations", text: "Public business operations.", title: "Locations", sourceDates: [], truncated: false }) }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
import { GET, POST } from "./route";
const company = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  m.calls.length = 0; m.rpc.mockReset();
  m.fetch.mockReset().mockResolvedValue({ status: 200, finalUrl: "https://example.test/locations", body: "synthetic" });
  m.enqueue.mockReset().mockResolvedValue({ id: "observation", queued: false });
  m.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "order", "limit", "range", "in", "single"]) chain[method] = (...args: unknown[]) => { m.calls.push({ table, method, args }); return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "companies" ? { id: company, name: "Synthetic", domain: "example.test", netsuite_internal_id: "1" }
      : table === "intelligence_research_attempts" ? [{ source_url: "https://example.test/services", next_attempt_at: "2999-01-01", last_attempt_at: "2026-09-18" }] : [], count: table === "intelligence_jobs" ? 2 : null, error: null }).then(resolve);
    return chain;
  });
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_research_claim" ? [{ source_url: "https://example.test/locations", lease_token: "lease" }] : true, error: null }));
});
describe("focused research state and receipts", () => {
  it("returns pending work for profile polling and excludes recently completed/corrected evidence", async () => {
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/profile?companyId=${company}`));
    expect(await response.json()).toMatchObject({ nextSources: ["https://example.test/locations"], pendingJobs: 2 });
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "eq", args: ["feedback_excluded", false] });
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("uses a stored lease and records successful unchanged reads so the next request advances", async () => {
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    expect(await response.json()).toMatchObject({ sources: 1, outcomes: ["unchanged"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: company, p_urls: ["https://example.test/locations"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", { p_company: company, p_url: "https://example.test/locations", p_lease: "lease", p_outcome: "unchanged" });
  });
  it("does not call a lost observation an unchanged success", async () => {
    m.enqueue.mockResolvedValue(null);
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    expect(await response.json()).toMatchObject({ outcomes: ["source_failed"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", expect.objectContaining({ p_outcome: "source_failed" }));
  });
});
