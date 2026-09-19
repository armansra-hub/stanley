import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCompanyNews, classifyAndRecordHeadline, sweepBase } from "./sweep";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(), read: vi.fn(), write: vi.fn(), fetch: vi.fn(), news: vi.fn(), newsResult: vi.fn(), newsItems: vi.fn(),
  queue: vi.fn(), seen: vi.fn(), flags: vi.fn(), classifier: vi.fn(), pick: vi.fn(), checked: vi.fn(),
}));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue, intelligenceEnabled: () => process.env.STANLEY_INTELLIGENCE_ENABLED === "true" }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: mocks.read, writeSourceState: mocks.write }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("@/lib/sources/googleNews", () => ({ fetchNewsForCompany: mocks.news, fetchNewsForCompanyResult: mocks.newsResult, fetchNewsItems: mocks.newsItems }));
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
  mocks.queue.mockResolvedValue(true);
  mocks.seen.mockResolvedValue(false);
  mocks.flags.mockResolvedValue(undefined);
  mocks.classifier.mockReturnValue("news");
  mocks.pick.mockResolvedValue([company]);
  mocks.checked.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("broader news observation intake", () => {
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
    await expect(classifyAndRecordHeadline(company, item)).resolves.toBe(false);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: company.id, sourceKind: "news", sourceUrl: item.source_url, text: article, eventDate: item.signal_date, metadata: expect.objectContaining({ articleBodyAvailable: true }) }));
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
