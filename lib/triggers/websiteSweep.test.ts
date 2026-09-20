import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepWebsites } from "./websiteSweep";
import type { SiteScan } from "@/lib/sources/website";
import { websiteChangeHistory } from "./adaptiveRevisit";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(), checked: vi.fn(), attempted: vi.fn(), parent: vi.fn(), trigger: vi.fn(), priority: vi.fn(), status: vi.fn(), config: vi.fn(),
  site: vi.fn(), feed: vi.fn(), headline: vi.fn(), enqueue: vi.fn(), read: vi.fn(), write: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/db/triggers", () => ({ pickSitesForRotation: mocks.pick, setSiteChecked: mocks.checked, markSiteAttempted: mocks.attempted, setParent: mocks.parent, recordTrigger: mocks.trigger, recomputePriority: mocks.priority }));
vi.mock("@/lib/db/companies", () => ({ setCompaniesStatus: mocks.status }));
vi.mock("@/lib/db/settings", () => ({ getAppConfig: mocks.config }));
vi.mock("@/lib/sources/website", async original => ({ ...await original<typeof import("@/lib/sources/website")>(), fetchSiteSignals: mocks.site }));
vi.mock("@/lib/sources/googleNews", async original => ({ ...await original<typeof import("@/lib/sources/googleNews")>(), fetchFeed: mocks.feed,
  fetchFeedResult: async () => ({ items: await mocks.feed(), status: "success" }) }));
vi.mock("@/lib/triggers/sweep", () => ({ classifyAndRecordHeadline: mocks.headline }));
vi.mock("@/lib/triggers/classify", () => ({ HEADLINE_CLASSIFIER_BATCH_BUDGET_MS: 30_000 }));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue, intelligenceEnabled: () => process.env.STANLEY_INTELLIGENCE_ENABLED === "true" }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: mocks.read, writeSourceState: mocks.write }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: mocks.fetch }));
vi.mock("./rotationBatches", () => ({ rotationBatches: async function* (load: (size: number) => Promise<unknown[]>) { yield await load(12); } }));

const company = { id: "account-1", name: "Acme Logistics", domain: "acme.com", site_hash: null, record_dead: false };
const articleUrl = "https://acme.com/news/update";
function scan(): SiteScan {
  return { growth: [], parent: null, feedUrl: null, financeRoles: [],
    pages: [{ url: articleUrl, title: "New operating model", text: "Acme is introducing recurring billing.", contentHash: "meaningful-hash", sourceDates: [{ kind: "published", value: "2026-09-17", source: "article:published_time" }], truncated: false }],
    discoveredUrls: [articleUrl], coverage: { attemptedUrls: [articleUrl], succeededUrls: [articleUrl], remainingUrls: [] } };
}

beforeEach(() => {
  vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.pick.mockResolvedValue([company]); mocks.checked.mockResolvedValue(undefined); mocks.attempted.mockResolvedValue(undefined);
  mocks.config.mockResolvedValue({ parent_autodismiss: false }); mocks.site.mockImplementation(async () => scan());
  mocks.feed.mockResolvedValue([]); mocks.headline.mockResolvedValue(false); mocks.trigger.mockResolvedValue(true);
  mocks.enqueue.mockResolvedValue({ id: "observation", queued: true });
  mocks.read.mockResolvedValue({ cursor: null, lastSuccessAt: null }); mocks.write.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async url => ({ status: 200, finalUrl: String(url), body: "<main>Additional company operations evidence.</main>", contentType: "text/html" }));
});
afterEach(() => vi.unstubAllEnvs());

describe("website evidence collection integration", () => {
  it("preserves a captured page and advances its pending checkpoint on 304 without a fabricated capture", async () => {
    const cached = { finalUrl: articleUrl, retained: true, validators: { url: articleUrl, etag: '"saved"' }, discoveredUrls: [], feedUrl: null };
    mocks.read.mockResolvedValue({ cursor: { baselineCapturedAt: "2026-09-18", knownUrls: [articleUrl], verifiedUrls: [articleUrl], pendingUrls: [articleUrl], httpCache: { [articleUrl]: cached } }, lastSuccessAt: "2026-09-18" });
    mocks.site.mockResolvedValue({ ...scan(), pages: [], httpCache: { [articleUrl]: cached }, coverage: { ...scan().coverage, notModifiedUrls: [articleUrl], urlOutcomes: [{ url: articleUrl, outcome: "success", status: 304 }] } });
    await sweepWebsites(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ status: "complete", successful: true,
      cursor: expect.objectContaining({ pendingUrls: [], verifiedUrls: [articleUrl], httpCache: { [articleUrl]: cached } }), details: expect.objectContaining({ notModifiedPages: 1 }) }));
  });
  it("stores source pages and their date provenance before successful checkpointing", async () => {
    await sweepWebsites(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "website", sourceUrl: articleUrl, text: "Acme is introducing recurring billing.", eventDate: "2026-09-17", metadata: expect.objectContaining({ meaningfulContentHash: "meaningful-hash" }) }));
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ complete: true, cursor: expect.objectContaining({ knownUrls: [articleUrl], verifiedUrls: [articleUrl], pendingUrls: [] }) }));
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.checked.mock.invocationCallOrder[0]);
  });

  it("spends bounded slots on the prior backlog and retains unfetched URLs fairly", async () => {
    const pending = Array.from({ length: 5 }, (_, index) => `https://acme.com/news/older-${index}`);
    mocks.read.mockResolvedValue({ cursor: { baselineCapturedAt: "2026-09-18T00:00:00Z", knownUrls: [articleUrl, ...pending], pendingUrls: pending }, lastSuccessAt: null });
    await sweepWebsites(1);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(pending.slice(0, 3));
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ complete: false, cursor: expect.objectContaining({ pendingUrls: pending.slice(3) }) }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
  });

  it("retains retry work after storage failure while preserving legacy finance effects", async () => {
    mocks.enqueue.mockRejectedValue(new Error("storage unavailable"));
    mocks.site.mockResolvedValue({ ...scan(), financeRoles: [{ role: "Controller", snippet: "Controller vacancy", url: "https://acme.com/careers" }] });
    await sweepWebsites(1);
    expect(mocks.checked).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ complete: false, error: expect.any(String), cursor: expect.objectContaining({ pendingUrls: [articleUrl] }) }));
    expect(mocks.trigger).toHaveBeenCalled();
    expect(mocks.attempted).toHaveBeenCalledWith(company.id);
  });

  it("does not turn an observation disabled response or empty site into successful coverage", async () => {
    mocks.enqueue.mockResolvedValue(null);
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ complete: false, error: expect.any(String) }));
    expect(mocks.checked).not.toHaveBeenCalled();
  });

  it("records pending-page failures without following cross-company evidence", async () => {
    mocks.read.mockResolvedValue({ cursor: { baselineCapturedAt: "2026-09-18T00:00:00Z", knownUrls: ["https://acme.com/news/later"], pendingUrls: ["https://acme.com/news/later"] }, lastSuccessAt: null });
    mocks.fetch.mockResolvedValue({ status: 200, finalUrl: "https://foreign.com/news/story", body: "Foreign content", contentType: "text/html" });
    await sweepWebsites(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith(company.id, "website", expect.objectContaining({ complete: false, error: expect.any(String), cursor: expect.objectContaining({ pendingUrls: ["https://acme.com/news/later"] }) }));
  });

  it("does not use the new source-state or observation lane when disabled", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await sweepWebsites(1);
    expect(mocks.site).toHaveBeenCalledWith("acme.com", "Acme Logistics");
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.checked).toHaveBeenCalledWith(company.id, "");
  });

  it("does not overwrite an unread cursor or skip legacy actions after a new-state failure", async () => {
    mocks.read.mockRejectedValue(new Error("state unavailable"));
    mocks.site.mockResolvedValue({ ...scan(), financeRoles: [{ role: "Controller", snippet: "Controller vacancy", url: "https://acme.com/careers" }] });
    await sweepWebsites(1);
    expect(mocks.trigger).toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.checked).not.toHaveBeenCalled();
  });

  it("extends quiet revisits only after successful capture and returns changed pages to hourly", async () => {
    const previousHashes = websiteChangeHistory(null, scan().pages).hashes;
    mocks.read.mockResolvedValue({ cursor: { pageHashes: previousHashes, revisit: { version: 1, quietRuns: 2 } }, lastSuccessAt: null });
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({ complete: true,
      cursor: expect.objectContaining({ revisit: expect.objectContaining({ outcome: "quiet", intervalHours: 8, quietRuns: 3 }) }) }));
    mocks.site.mockResolvedValue({ ...scan(), pages: [{ ...scan().pages[0], contentHash: "changed-model" }] });
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({
      cursor: expect.objectContaining({ revisit: expect.objectContaining({ outcome: "changed", intervalHours: 1, quietRuns: 0 }) }) }));
  });

  it("keeps failed or unfinished capture hourly and remembers changes across its backlog", async () => {
    mocks.read.mockResolvedValue({ cursor: { pageHashes: websiteChangeHistory(null, scan().pages).hashes,
      changedSinceComplete: true, revisit: { version: 1, quietRuns: 4 } }, lastSuccessAt: null });
    mocks.enqueue.mockRejectedValueOnce(new Error("storage unavailable"));
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({ complete: false,
      cursor: expect.objectContaining({ changedSinceComplete: true, revisit: expect.objectContaining({ outcome: "incomplete", intervalHours: 1, quietRuns: 4 }) }) }));
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({ complete: true,
      cursor: expect.objectContaining({ changedSinceComplete: false, revisit: expect.objectContaining({ outcome: "changed", intervalHours: 1, quietRuns: 0 }) }) }));
  });

  it("retains a failed discovered page in the source cursor even when another page succeeds", async () => {
    const missing = "https://acme.com/news/temporarily-unavailable";
    mocks.site.mockResolvedValue({ ...scan(), discoveredUrls: [articleUrl, missing],
      coverage: { ...scan().coverage, attemptedUrls: [articleUrl, missing], failedUrls: [missing] } });
    await sweepWebsites(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({ complete: false,
      cursor: expect.objectContaining({ pendingUrls: [missing], revisit: expect.objectContaining({ outcome: "incomplete", intervalHours: 1 }) }) }));
  });

  it("clears a confirmed absent backlog URL without storing an invented evidence page", async () => {
    const missing = "https://acme.com/news/removed-page";
    mocks.read.mockResolvedValue({ cursor: { baselineCapturedAt: "2026-09-18T00:00:00Z", knownUrls: [missing], pendingUrls: [missing] }, lastSuccessAt: null });
    mocks.fetch.mockResolvedValue({ status: 410, finalUrl: missing, body: "Gone", contentType: "text/html" });
    await sweepWebsites(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenLastCalledWith(company.id, "website", expect.objectContaining({ complete: true,
      cursor: expect.objectContaining({ pendingUrls: [], verifiedUrls: [articleUrl] }) }));
  });
});
