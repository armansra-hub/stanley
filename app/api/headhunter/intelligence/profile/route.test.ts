import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), pdf: vi.fn(), enqueue: vi.fn(), rank: vi.fn(), log: vi.fn(), discover: vi.fn(), sourceState: vi.fn(), external: vi.fn(), newsEvidence: vi.fn(), researchSources: [] as Record<string, unknown>[], calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }), withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("@/lib/intelligence/worker", () => ({ runIntelligenceWorker: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => true, enqueueObservation: m.enqueue }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: () => true, sameOriginMutation: () => true,
  isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value), smallJson: (request: Request) => request.json() }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: m.sourceState }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: m.fetch }));
vi.mock("@/lib/intelligence/researchExternal", () => ({ discoverExternalResearch: m.external }));
vi.mock("@/lib/sources/newsEvidence", () => ({ readNewsEvidence: m.newsEvidence }));
vi.mock("@/lib/sources/publicPdf", () => ({ fetchPublicPdfEvidence: m.pdf }));
vi.mock("@/lib/sources/siteDiscovery", async original => ({ ...await original<typeof import("@/lib/sources/siteDiscovery")>(),
  sameCompanySite: (url: string) => url.startsWith("https://example.test/"), sitePageKind: () => "services",
  discoverSiteLinks: m.discover,
  sitePageEvidence: () => ({ url: "https://example.test/locations", text: "Public business operations.", title: "Locations", sourceDates: [], truncated: false }) }));
vi.mock("@/lib/db/events", () => ({ logEvent: m.log }));
vi.mock("@/lib/intelligence/researchRanking", () => ({ rankResearchCandidates: m.rank }));
vi.mock("@/lib/intelligence/atsLifecycle", () => ({ readAtsHiringContext: async () => ({ boards: [], scans: [], basis: "Synthetic complete-scan context" }) }));
import { GET, POST } from "./route";
import { refreshAccountResearch, runDirectedResearchWorker } from "@/lib/intelligence/researchRunner";
const company = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  m.calls.length = 0; m.rpc.mockReset();
  m.researchSources.length = 0;
  m.external.mockReset().mockResolvedValue({ queries: 0, sources: 0, outcome: "not_due", nextAttemptAt: "2999-01-01T00:00:00Z" });
  m.newsEvidence.mockReset();
  m.sourceState.mockReset().mockResolvedValue({ cursor: { verifiedUrls: ["https://example.test/services", "https://example.test/locations"] } });
  m.discover.mockReset().mockReturnValue([]);
  m.pdf.mockReset();
  m.log.mockReset().mockResolvedValue(undefined);
  m.rank.mockReset().mockImplementation(async ({ candidates }) => ({ candidates, providerUsed: true, outcome: "ranked", rankingVersion: "next-source-v1",
    scores: [{ url: candidates[0], optionId: "source_1", score: .86, rawAnswer: { type: "noul", noul: .86, confidence: .57 } }] }));
  m.fetch.mockReset().mockResolvedValue({ status: 200, finalUrl: "https://example.test/locations", body: "synthetic" });
  m.enqueue.mockReset().mockResolvedValue({ id: "observation", queued: false });
  m.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    let inserted: unknown[] | null = null;
    for (const method of ["select", "eq", "neq", "order", "limit", "range", "in", "single", "upsert"]) chain[method] = (...args: unknown[]) => {
      m.calls.push({ table, method, args });
      if (method === "upsert") inserted = args[0] as unknown[];
      return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: inserted ?? (table === "companies" ? { id: company, name: "Synthetic", domain: "example.test", netsuite_internal_id: "1" }
      : table === "intelligence_research_attempts" ? [{ source_url: "https://example.test/services", next_attempt_at: "2999-01-01", last_attempt_at: "2026-09-18" }]
      : table === "intelligence_research_sources" ? m.researchSources
      : table === "intelligence_jobs" ? ["pending-1", "pending-2"].map(id => ({ id, observation_id: id, status: "queued", kind: "interpret",
        intelligence_observations: { company_id: company, is_current: true, feedback_excluded: false } })) : []), error: null }).then(resolve);
    return chain;
  });
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_research_claim" ? [{ source_url: "https://example.test/locations", lease_token: "lease" }] : true, error: null }));
});
describe("focused research state and receipts", () => {
  it("reloads durably discovered external candidates, reads their publisher evidence and preserves query attribution", async () => {
    const wrapper = "https://news.google.com/rss/articles/synthetic";
    const item = { source_name: "Google News", source_url: wrapper, raw_excerpt: "Synthetic awarded services contract", signal_date: "2026-09-19" };
    m.external.mockImplementation(async () => {
      m.researchSources.push({ source_url: wrapper, title: item.raw_excerpt, metadata: {
        researchOrigin: "external_search", researchPurpose: "event_followup", query: '"Synthetic" contract', queryHash: "query-hash", newsItem: item,
      } });
      return { queries: 1, sources: 1, outcome: "searched", nextAttemptAt: "2999-01-01T00:00:00Z" };
    });
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_research_claim"
      ? [{ source_url: wrapper, lease_token: "external-source-lease" }] : true, error: null }));
    m.newsEvidence.mockResolvedValue({ sourceUrl: "https://publisher.test/synthetic-contract", title: item.raw_excerpt,
      text: "Synthetic will deliver project services for the agency.", eventDate: item.signal_date,
      metadata: { evidenceKind: "publisher_body", bodyAvailable: true }, bodyAvailable: true });
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    expect(await response.json()).toMatchObject({ sources: 1, outcomes: ["unchanged"] });
    expect(m.external).toHaveBeenCalledOnce();
    expect(m.external.mock.invocationCallOrder[0]).toBeLessThan(m.rank.mock.invocationCallOrder[0]);
    expect(m.rank).toHaveBeenCalledWith(expect.objectContaining({ candidates: expect.arrayContaining([wrapper]) }));
    expect(m.newsEvidence).toHaveBeenCalledWith(item, expect.objectContaining({ deadlineMs: expect.any(Number) }));
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "news", sourceUrl: "https://publisher.test/synthetic-contract",
      metadata: expect.objectContaining({ externalResearch: true, researchPurpose: "event_followup", researchQuery: '"Synthetic" contract', researchQueryHash: "query-hash" }) }));
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", { p_company: company, p_url: wrapper, p_lease: "external-source-lease", p_outcome: "unchanged" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("reads selected public PDFs only in deep research and retains limits without inventing a date", async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_research_claim"
      ? [{ source_url: "https://example.test/capabilities.pdf", lease_token: "pdf-lease" }] : true, error: null }));
    m.pdf.mockResolvedValue({ status: "extracted", url: "https://example.test/capabilities.pdf", text: "[PDF page 1]\nContract operations",
      pagesRead: 12, totalPages: 15, bytes: 12000, truncated: true, truncationReasons: ["page_limit"], evidenceKind: "public_pdf_text" });
    expect(await refreshAccountResearch(company, { deadlineMs: Date.now() + 90000 })).toMatchObject({ outcomes: ["unchanged"] });
    expect(m.pdf).toHaveBeenCalledWith("https://example.test/capabilities.pdf", expect.objectContaining({ mode: "deep" }));
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ eventDate: null, metadata: expect.objectContaining({
      evidenceKind: "public_pdf_text", sourceTruncated: true, truncationReasons: ["page_limit"], pdfPagesRead: 12, pdfTotalPages: 15,
    }) }));
    m.enqueue.mockClear(); m.pdf.mockResolvedValue({ status: "no_readable_text", url: "https://example.test/capabilities.pdf" });
    expect(await refreshAccountResearch(company, { deadlineMs: Date.now() + 90000 })).toMatchObject({ outcomes: ["source_empty"] });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("offers discovered but unread sources before already captured pages, excluding outside hosts", async () => {
    m.sourceState.mockResolvedValue({ cursor: { verifiedUrls: ["https://example.test/locations"],
      knownUrls: ["https://example.test/services/project-costing", "https://outside.test/services"],
      pendingUrls: ["https://example.test/services/project-costing", "https://example.test/careers/controller"] } });
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/profile?companyId=${company}`));
    const result = await response.json();
    expect(result.nextSources[0]).toBe("https://example.test/services/project-costing");
    expect(result.newSourceCount).toBe(2);
    expect(result.discoveredSourceCount).toBe(3);
    expect(result.nextSources).not.toContain("https://outside.test/services");
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("persists newly found company links for a later separately leased research pass", async () => {
    m.discover.mockReturnValue([{ url: "https://example.test/services/contracts", label: "Contracts", kind: "services" }]);
    const result = await refreshAccountResearch(company, { deadlineMs: Date.now() + 90000 });
    expect(result).toMatchObject({ outcomes: ["unchanged"], remainingSources: 1 });
    expect(m.calls).toContainEqual({ table: "intelligence_research_sources", method: "upsert", args: [[{
      company_id: company, source_url: "https://example.test/services/contracts", title: "Contracts", discovered_from: "https://example.test/locations",
    }], { onConflict: "company_id,source_url", ignoreDuplicates: true }] });
    expect(m.enqueue).toHaveBeenCalledOnce();
  });
  it("returns pending work for profile polling and excludes recently completed/corrected evidence", async () => {
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/profile?companyId=${company}`));
    expect(await response.json()).toMatchObject({ nextSources: ["https://example.test/locations"], pendingJobs: 2,
      hiring: { boards: [], scans: [], basis: "Synthetic complete-scan context" }, hiringCoverage: "available" });
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "eq", args: ["feedback_excluded", false] });
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "select", args: [
      "id,observation_id,status,intelligence_observations:intelligence_observations!intelligence_jobs_observation_id_fkey!inner(company_id,is_current,feedback_excluded)",
    ] });
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "eq", args: ["intelligence_observations.is_current", true] });
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "eq", args: ["intelligence_observations.feedback_excluded", false] });
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "eq", args: ["kind", "interpret"] });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.rank).not.toHaveBeenCalled();
    expect(m.external).not.toHaveBeenCalled();
  });
  it("uses a stored lease and records successful unchanged reads so the next request advances", async () => {
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    expect(await response.json()).toMatchObject({ sources: 1, outcomes: ["unchanged"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_claim", { p_company: company, p_urls: ["https://example.test/locations"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", { p_company: company, p_url: "https://example.test/locations", p_lease: "lease", p_outcome: "unchanged" });
    expect(m.rank.mock.invocationCallOrder[0]).toBeLessThan(m.rpc.mock.invocationCallOrder[0]);
    expect(m.external).toHaveBeenCalledWith(expect.objectContaining({ id: company }), expect.arrayContaining(["multi_location"]), [], expect.any(Number));
    expect(m.rank).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Synthetic", missingTopics: expect.arrayContaining(["multi_location"]) }));
  });
  it("does not call a lost observation an unchanged success", async () => {
    m.enqueue.mockResolvedValue(null);
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    expect(await response.json()).toMatchObject({ outcomes: ["source_failed"] });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", expect.objectContaining({ p_outcome: "source_failed" }));
  });
  it("returns and logs the native ranking answer without recalibration", async () => {
    const response = await POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/profile", { method: "POST", body: JSON.stringify({ companyId: company }) }));
    const result = await response.json();
    expect(result.ranking.scores[0].rawAnswer).toEqual({ type: "noul", noul: .86, confidence: .57 });
    expect(m.log).toHaveBeenCalledWith("headhunter", "intelligence.focused_research", expect.objectContaining({ meta: expect.objectContaining({ ranking: result.ranking }) }));
  });
  it("does not acquire or fetch work when insufficient deadline remains", async () => {
    expect(await refreshAccountResearch(company, { deadlineMs: Date.now() + 20000 })).toMatchObject({ outcome: "deadline_deferred", sources: 0 });
    expect(await runDirectedResearchWorker(1, Date.now() + 20000)).toMatchObject({ processed: 0 });
    expect(m.rpc).not.toHaveBeenCalled(); expect(m.rank).not.toHaveBeenCalled(); expect(m.fetch).not.toHaveBeenCalled();
    expect(m.external).not.toHaveBeenCalled();
  });
  it("automatic account work shares the manual source lease and saves a deferred account receipt", async () => {
    let claimed = false;
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_directed_claim"
      ? claimed ? [] : (claimed = true, [{ company_id: company, desired_hash: "hash", lease_token: "account-lease", attempts: 1 }])
      : name === "intelligence_research_claim" ? [{ source_url: "https://example.test/locations", lease_token: "source-lease" }] : true, error: null }));
    expect(await runDirectedResearchWorker(1)).toMatchObject({ processed: 1, outcomes: { refreshed: 1 } });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", expect.objectContaining({ p_lease: "source-lease", p_outcome: "unchanged" }));
    expect(m.rpc).toHaveBeenCalledWith("intelligence_directed_finish", expect.objectContaining({ p_lease: "account-lease", p_hash: "hash", p_status: "queued",
      p_result: expect.objectContaining({ outcomes: ["unchanged"], ranking: expect.objectContaining({ scores: expect.any(Array) }) }) }));
    expect(m.log).toHaveBeenCalledWith("headhunter", "intelligence.focused_research", expect.objectContaining({ meta: expect.objectContaining({ automatic: true }) }));
  });
  it("records provider/redirect failures separately from unchanged or empty source success", async () => {
    m.fetch.mockResolvedValue({ status: 200, finalUrl: "https://outside.test/fake", body: "wrong company" });
    const result = await refreshAccountResearch(company, { deadlineMs: Date.now() + 90000 });
    expect(result.outcomes).toEqual(["source_failed"]); expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("leaves a superseded account receipt untouched while completing its separately owned source", async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "intelligence_directed_claim"
      ? [{ company_id: company, desired_hash: "hash", lease_token: "old-account-lease", attempts: 1 }]
      : name === "intelligence_research_claim" ? [{ source_url: "https://example.test/locations", lease_token: "source-lease" }]
      : name === "intelligence_directed_finish" ? false : true, error: null }));
    expect(await runDirectedResearchWorker(1)).toMatchObject({ outcomes: { superseded: 1 } });
    expect(m.rpc).toHaveBeenCalledWith("intelligence_research_finish", expect.objectContaining({ p_lease: "source-lease" }));
  });
});
