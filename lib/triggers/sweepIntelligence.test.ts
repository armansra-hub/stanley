import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCompanyNews, classifyAndRecordHeadline, sweepBase } from "./sweep";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(), read: vi.fn(), write: vi.fn(), fetch: vi.fn(), news: vi.fn(), newsResult: vi.fn(), newsItems: vi.fn(), newsItemsResult: vi.fn(),
  queue: vi.fn(), seen: vi.fn(), flags: vi.fn(), classifier: vi.fn(), pick: vi.fn(), checked: vi.fn(),
}));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue, intelligenceEnabled: () => process.env.STANLEY_INTELLIGENCE_ENABLED === "true" }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: mocks.read, writeSourceState: mocks.write }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/googleNews", () => ({ fetchNewsForCompany: mocks.news, fetchNewsForCompanyResult: mocks.newsResult, fetchNewsItems: mocks.newsItems, fetchNewsItemsResult: mocks.newsItemsResult }));
vi.mock("@/lib/db/triggers", () => ({ pickForRotation: mocks.pick, recordTrigger: vi.fn(), recomputePriority: vi.fn(), markChecked: mocks.checked, setErpFlags: mocks.flags, queueCandidate: mocks.queue, headlineCandidateSeen: mocks.seen }));
vi.mock("@/lib/db/companies", () => ({ normalizeCompanyName: (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() }));
vi.mock("@/lib/db/settings", () => ({ claimClassifierCall: vi.fn(async () => false) }));
vi.mock("@/lib/triggers/config", () => ({ classifyHeadline: mocks.classifier }));
vi.mock("@/lib/triggers/classify", () => ({ classifyEventLLM: vi.fn(), HEADLINE_CLASSIFIER_BATCH_BUDGET_MS: 30_000 }));
vi.mock("@/lib/apify/run", () => ({ runActor: vi.fn() }));
vi.mock("./rotationBatches", () => ({ rotationBatches: async function* (load: (size: number) => Promise<unknown[]>) { yield await load(20); } }));

const company = { id: "account-1", name: "Acme Logistics", domain: "acme.com", record_dead: false };
const item = { raw_excerpt: "Acme Logistics changes its operating model", source_url: "https://publisher.com/news/acme", source_name: "Google News", signal_date: new Date(Date.now() - 1000).toISOString() };
const article = "Acme Logistics announced a new recurring service and customer billing model for its regional distribution business. The company described changes to project accounting, invoicing, and consolidated reporting across its branches.";

beforeEach(() => {
  vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.enqueue.mockResolvedValue({ id: "observation", queued: true });
  mocks.read.mockResolvedValue({ cursor: null, lastSuccessAt: null });
  mocks.write.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue({ status: 200, finalUrl: item.source_url, body: `<nav>Menu</nav><main>${article}</main>`, contentType: "text/html" });
  mocks.news.mockResolvedValue([item]);
  mocks.newsResult.mockResolvedValue({ items: [item], status: "success" });
  mocks.newsItems.mockResolvedValue([]);
  mocks.newsItemsResult.mockImplementation(async () => ({ items: await mocks.newsItems(), status: "success" }));
  mocks.queue.mockResolvedValue(true);
  mocks.seen.mockResolvedValue(false);
  mocks.flags.mockResolvedValue(undefined);
  mocks.classifier.mockReturnValue("news");
  mocks.pick.mockResolvedValue([company]);
  mocks.checked.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("broader news observation intake", () => {
  it("accounts for exact source-only news IDs and completion-stamp failures without claiming unreserved work", async () => {
    const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"];
    const collection = { companyIds: ids, runCutoff: "2026-01-01T00:00:00Z" };
    mocks.pick.mockResolvedValue([{ ...company, id: ids[0] }]);
    mocks.newsResult.mockResolvedValue({ items: [], status: "empty" });
    mocks.checked.mockRejectedValue(new Error("checkpoint failed"));
    expect(await sweepBase(2, { sourceOnly: true, collection })).toMatchObject({ attempted: 1, succeeded: 0, failed: 1,
      collection: { runCutoff: collection.runCutoff, analysisCompleted: false, outcomes: [
        { companyId: ids[0], admission: "attempted", collectorOutcome: "failed" },
        { companyId: ids[1], admission: "not_reserved", reason: "unknown" },
      ] } });
    expect(mocks.pick).toHaveBeenCalledWith(20, undefined, collection);
    expect(mocks.classifier).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("captures broad and executive TAM news without legacy candidates in source-only mode", async () => {
    mocks.pick.mockResolvedValue([{ ...company, claimable: true }]);
    mocks.newsItems.mockResolvedValue([{ ...item, raw_excerpt: "Acme Logistics appoints chief financial officer" }]);
    mocks.classifier.mockReturnValue("press");
    expect(await sweepBase(1, { sourceOnly: true })).toMatchObject({ sourceOnly: true, succeeded: 1, news_triggers: 0, companies_triggered: 0 });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.newsItemsResult).toHaveBeenCalled();
    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.flags).not.toHaveBeenCalled();
  });

  it("rejects disabled source-only capture or a paid-finance combination before reserving TAM rows", async () => {
    await expect(sweepBase(1, { sourceOnly: true, finance: true })).rejects.toThrow("legacy paid finance");
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(sweepBase(1, { sourceOnly: true })).rejects.toThrow("requires evidence capture");
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("does not count an unavailable executive-search body as completed source-only news", async () => {
    mocks.pick.mockResolvedValue([{ ...company, claimable: true }]);
    mocks.newsResult.mockResolvedValue({ items: [], status: "empty" });
    mocks.newsItems.mockResolvedValue([item]);
    mocks.fetch.mockResolvedValue({ status: 403, finalUrl: item.source_url, body: "Forbidden" });
    expect(await sweepBase(1, { sourceOnly: true })).toMatchObject({ succeeded: 0, partial: 1 });
    expect(mocks.checked).toHaveBeenLastCalledWith([]);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("captures source-only TAL evidence without any legacy classification, flags or candidates", async () => {
    mocks.classifier.mockReturnValue("press");
    const options = { sourceOnly: true, llm: true };
    expect(await checkCompanyNews(company, options)).toBe(0);
    expect(mocks.enqueue).toHaveBeenCalled();
    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.flags).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(await classifyAndRecordHeadline(company, item, options)).toBe(false);
    expect(mocks.classifier).not.toHaveBeenCalled();
  });

  it("fails closed for source-only collection when capture is disabled or a feed body is unavailable", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(checkCompanyNews(company, { sourceOnly: true })).rejects.toThrow("requires evidence capture");
    await expect(classifyAndRecordHeadline(company, item, { sourceOnly: true })).rejects.toThrow("requires evidence capture");
    expect(mocks.newsResult).not.toHaveBeenCalled();
    expect(mocks.classifier).not.toHaveBeenCalled();
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
    mocks.fetch.mockResolvedValue({ status: 403, finalUrl: item.source_url, body: "Forbidden" });
    await expect(classifyAndRecordHeadline(company, item, { sourceOnly: true })).rejects.toThrow("article body unavailable");
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ articleBodyAvailable: false }) }));
  });
  it("partitions successful, partial, unavailable, and failed attempts from computed collection results", async () => {
    mocks.newsResult.mockResolvedValue({ items: [], status: "empty" });
    expect(await sweepBase(1)).toMatchObject({ checked: 1, attempted: 1, succeeded: 1, partial: 0, unavailable: 0, failed: 0 });
    mocks.newsResult.mockResolvedValue({ items: [item], status: "success" });
    mocks.fetch.mockResolvedValue({ status: 403, finalUrl: item.source_url, body: "Forbidden" });
    expect(await sweepBase(1)).toMatchObject({ attempted: 1, succeeded: 0, partial: 1, unavailable: 0, failed: 0 });
    expect(mocks.checked).toHaveBeenLastCalledWith([]);
    mocks.newsResult.mockResolvedValue({ items: [], status: "unavailable", error: "timeout" });
    expect(await sweepBase(1)).toMatchObject({ attempted: 1, succeeded: 0, partial: 0, unavailable: 1, failed: 0 });
    mocks.newsResult.mockResolvedValue({ items: [item], status: "success" });
    mocks.enqueue.mockResolvedValue(null);
    expect(await sweepBase(1)).toMatchObject({ attempted: 1, succeeded: 0, partial: 0, unavailable: 0, failed: 1 });
  });

  it("reports state-read failures without fetching or overwriting an unknown news cursor", async () => {
    mocks.read.mockRejectedValue(new Error("Source state read failed: database_error"));
    const result = await sweepBase(1);
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(result.errors).toContainEqual(expect.objectContaining({ source: "news", code: "storage_failure" }));
    expect(mocks.newsResult).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("does not report swallowed executive-feed or disabled-lane provider failures as success", async () => {
    mocks.pick.mockResolvedValue([{ ...company, claimable: true }]);
    mocks.newsResult.mockResolvedValue({ items: [], status: "empty" });
    mocks.newsItemsResult.mockResolvedValue({ items: [], status: "unavailable", error: "timeout" });
    expect(await sweepBase(1)).toMatchObject({ attempted: 1, succeeded: 0, partial: 1 });
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    mocks.pick.mockResolvedValue([company]);
    mocks.newsResult.mockResolvedValue({ items: [], status: "unavailable", error: "timeout" });
    expect(await sweepBase(1)).toMatchObject({ attempted: 1, succeeded: 0, unavailable: 1 });
    expect(mocks.newsResult).toHaveBeenLastCalledWith(company.name, 6);
    expect(mocks.checked).toHaveBeenLastCalledWith([]);
  });

  it("bounds and sanitizes failures when the whole source-state store is unavailable", async () => {
    mocks.pick.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ ...company, id: `account-${index}` })));
    mocks.read.mockRejectedValue(new Error("Database failure at https://example.com?token=secret"));
    const result = await sweepBase(25);
    expect(result).toMatchObject({ attempted: 25, succeeded: 0, failed: 25, error_count: 25 });
    expect(result.errors).toHaveLength(10);
    expect(JSON.stringify(result.errors)).not.toContain("secret");
  });

  it("records a quiet valid feed as empty coverage rather than a failure", async () => {
    mocks.newsResult.mockResolvedValue({ items: [], status: "empty" });
    await checkCompanyNews(company);
    expect(mocks.write).toHaveBeenCalledWith(company.id, "news:google", expect.objectContaining({ status: "empty", complete: true, successful: true }));
  });
  it("saves headlines immediately and delays body retries without repeated Jev jobs", async () => {
    mocks.fetch.mockResolvedValue({ status: 403, finalUrl: item.source_url, body: "Forbidden" });
    await checkCompanyNews(company);
    const saved = mocks.write.mock.calls[0][2];
    expect(saved).toMatchObject({ status: "partial", complete: false, successful: true });
    mocks.read.mockResolvedValue({ cursor: saved.cursor, lastSuccessAt: new Date().toISOString() });
    mocks.fetch.mockClear(); mocks.enqueue.mockClear();
    await checkCompanyNews(company);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "news:google", expect.objectContaining({ status: "partial", cursor: expect.objectContaining({ pending: [item] }) }));
  });
  it("captures actual article text before generic-news rejection without publishing a legacy trigger", async () => {
    await expect(classifyAndRecordHeadline({ ...company, subindustry: "Freight & Logistics" }, item)).resolves.toBe(false);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: company.id, companySubindustry: "Freight & Logistics", sourceKind: "news", sourceUrl: item.source_url, text: article, eventDate: item.signal_date, metadata: expect.objectContaining({ articleBodyAvailable: true }) }));
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(item.source_url, expect.objectContaining({ maxBytes: 1_000_000, timeoutMs: 5000 }));
  });

  it("lets semantic evidence resolve identity even when the old title gate rejects it", async () => {
    await expect(classifyAndRecordHeadline(company, { ...item, raw_excerpt: "Regional operator changes its billing model" })).resolves.toBe(false);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Acme Logistics", companyDomain: "acme.com", text: article }));
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("preserves legacy candidate effects but propagates observation persistence failure", async () => {
    mocks.classifier.mockReturnValue("press");
    mocks.enqueue.mockRejectedValue(new Error("database unavailable"));
    await expect(classifyAndRecordHeadline(company, item)).rejects.toThrow("capture incomplete");
    expect(mocks.queue).toHaveBeenCalledOnce();
  });

  it("does not mistake Google gateway UI for publisher evidence", async () => {
    mocks.classifier.mockReturnValue("press");
    mocks.fetch.mockResolvedValue({ status: 200, finalUrl: "https://news.google.com/rss/articles/token", body: `<main>${"Generic Google navigation ".repeat(20)}</main>`, contentType: "text/html" });
    await expect(classifyAndRecordHeadline(company, item)).resolves.toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ text: item.raw_excerpt, metadata: expect.objectContaining({ evidenceKind: "headline_only", articleBodyAvailable: false }) }));
    expect(mocks.queue).toHaveBeenCalledOnce();
  });

  it("leaves the disabled legacy path free of new fetches or storage calls", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    mocks.classifier.mockReturnValue("press");
    await expect(classifyAndRecordHeadline(company, item)).resolves.toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.queue).toHaveBeenCalledOnce();
  });

  it("retains failed items and never marks their news coverage complete", async () => {
    mocks.enqueue.mockRejectedValue(new Error("storage unavailable"));
    await expect(checkCompanyNews(company)).rejects.toThrow("capture incomplete");
    expect(mocks.write).toHaveBeenCalledWith(company.id, "news:google", expect.objectContaining({ complete: false, error: expect.any(String), cursor: expect.objectContaining({ pending: [item], seen: [] }) }));
  });

  it("reuses captured unchanged items on the next pass and still executes legacy checks", async () => {
    await checkCompanyNews(company);
    const saved = mocks.write.mock.calls[0][2];
    mocks.read.mockResolvedValue({ cursor: saved.cursor, lastSuccessAt: new Date().toISOString() });
    mocks.fetch.mockClear(); mocks.enqueue.mockClear(); mocks.classifier.mockClear();
    await checkCompanyNews(company);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.classifier).toHaveBeenCalled();
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "news:google", expect.objectContaining({ complete: true }));
  });

  it("does not completion-stamp a failed account in the broader sweep", async () => {
    mocks.enqueue.mockRejectedValue(new Error("storage unavailable"));
    await sweepBase(1);
    expect(mocks.checked).toHaveBeenCalledWith([]);
    expect(mocks.write).toHaveBeenCalledWith(company.id, "news:google", expect.objectContaining({ complete: false }));
  });

  it("preserves the separate executive-change check after a new-lane storage failure", async () => {
    mocks.pick.mockResolvedValue([{ ...company, claimable: true }]);
    mocks.enqueue.mockRejectedValue(new Error("storage unavailable"));
    mocks.newsItems.mockResolvedValue([{ ...item, raw_excerpt: "Acme Logistics names CFO" }]);
    await sweepBase(1);
    expect(mocks.newsItems).toHaveBeenCalled();
    expect(mocks.queue).toHaveBeenCalledWith(expect.objectContaining({ id: company.id }), expect.objectContaining({ type: "finance_hire" }));
    expect(mocks.checked).toHaveBeenCalledWith([]);
  });
});
