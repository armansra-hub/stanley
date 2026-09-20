import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSharedAccountIndex, feedbackSourceOrder, parseSharedFeed, rankSharedSources, runSharedSources, type SharedAccount, type SharedItem, type SharedSource, type SharedSourceStore } from "./sharedSources";

const now = Date.parse("2026-09-18T12:00:00Z");
const account = (id: string, name = "Blue River Services", state = "WA"): SharedAccount => ({ id, name, state, city: "Seattle", domain: "blueriver.com", netsuite_internal_id: id });
const source = (id = "state", extra: Partial<SharedSource> = {}): SharedSource => ({ id, name: "State business announcements", url: "https://commerce.wa.gov/feed/", enabled: true, format: "rss", scope: "state_local", states: ["WA"], cities: [], free_access: true,
  verified_at: "2026-09-18T00:00:00Z", verification_url: "https://commerce.wa.gov/news/", poll_minutes: 60, next_fetch_at: "2026-09-18T00:00:00Z", lease_token: "lease", ...extra });
const article = "Blue River Services opened a new facility in Tacoma to consolidate three acquired operating businesses. Its expanded service organization will coordinate multiple sites, contracts and project delivery teams. ";
const item: SharedItem = { item_key: "a".repeat(64), payload: { url: "https://commerce.wa.gov/news/expansion", title: "Business investment expands local operations", text: "Short excerpt", eventDate: "2026-09-17T00:00:00Z" } };
const feed = `<rss version="2.0"><channel><title>Agency</title><item><title>Business investment expands local operations</title><link>https://commerce.wa.gov/news/expansion</link><description>Short excerpt</description><pubDate>Thu, 17 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;

function fixture(extra: Partial<SharedSourceStore> = {}) {
  const store: SharedSourceStore = {
    enabled: vi.fn().mockResolvedValue(true), sources: vi.fn().mockResolvedValue([source()]), accounts: vi.fn().mockResolvedValue([account("1")]),
    claim: vi.fn().mockResolvedValue(source()), snapshot: vi.fn().mockResolvedValue(undefined), pending: vi.fn().mockResolvedValue([structuredClone(item)]),
    item: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined), ...extra,
  };
  const fetchText = vi.fn(async (url: string) => ({ status: 200, body: url.includes("/feed") ? feed : `<main>${article}</main>`, finalUrl: url, contentType: "text/html" }));
  const enqueue = vi.fn().mockResolvedValue({ id: "observation", queued: true });
  return { store, fetchText, enqueue, now: () => now };
}

beforeEach(() => vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("shared source parsing and account retrieval", () => {
  it("repairs GSA-style XML ampersands and excludes dated archive rows before enforcing the fresh intake cap", async () => {
    const old = '<item><title>Archive</title><link>https://gsa.gov/old</link><pubDate>Thu, 03 Jan 2019 00:00:00 GMT</pubDate></item>';
    const recent = '<item><title>Research & consulting contract</title><link>https://gsa.gov/new?a=1&b=2</link><description><![CDATA[A & B operations]]></description><pubDate>Fri, 18 Sep 2026 00:00:00 GMT</pubDate></item>';
    const items = await parseSharedFeed(`<rss version="2.0"><channel>${old.repeat(555)}${recent}</channel></rss>`, "https://gsa.gov/feed", { nowMs: now });
    expect(items).toHaveLength(1);
    expect(items[0].payload).toMatchObject({ title: "Research & consulting contract", text: "A & B operations", url: "https://gsa.gov/new?a=1&b=2" });
  });
  it("preserves the oldest quiet source while recorded outcomes order remaining capacity", () => {
    const ranked = rankSharedSources([source("quiet", { states: ["VA"], next_fetch_at: "2026-09-16" }), source("useful"), source("not_now")], [account("1")]);
    const ordered = feedbackSourceOrder(ranked, { quiet: .9, useful: 1.02, not_now: .98 });
    expect(ordered.map(entry => entry.source.id)).toEqual(["quiet", "useful", "not_now"]);
    expect(feedbackSourceOrder(ranked, { quiet: 100, useful: -100, not_now: 100 })[0].source.id).toBe("quiet");
  });
  it("distinguishes valid empty feeds from HTML, malformed feeds and unsafe article links", async () => {
    expect(await parseSharedFeed('<rss version="2.0"><channel><title>Empty</title></channel></rss>', source().url)).toEqual([]);
    await expect(parseSharedFeed("<html>blocked</html>", source().url)).rejects.toThrow("not_rss");
    await expect(parseSharedFeed("<rss>", source().url)).rejects.toThrow();
    await expect(parseSharedFeed(feed.replace("https://commerce.wa.gov/news/expansion", "http://127.0.0.1/private"), source().url)).rejects.toThrow();
  });
  it("coalesces tracking URLs but gives a changed excerpt a new durable identity", async () => {
    const original = await parseSharedFeed(feed, source().url);
    const tracked = await parseSharedFeed(feed.replace("/news/expansion", "/news/expansion?utm_source=feed"), source().url);
    expect(original[0].item_key).toBe(tracked[0].item_key);
    expect(original[0].payload.eventDate).toBe("2026-09-17T00:00:00.000Z");
    expect((await parseSharedFeed(feed.replace("Short excerpt", "Changed excerpt"), source().url))[0].item_key).not.toBe(original[0].item_key);
  });
  it("retrieves exact legal-name spans and domains without substring or short acronym matches", () => {
    const find = buildSharedAccountIndex([account("1", "Blue River Services LLC"), { ...account("2", "ABC"), domain: "abc.com" }]);
    expect(find("Blue River Services acquires an operator").map((x) => x.account.id)).toEqual(["1"]);
    expect(find("Blue River Servicestown and ABC show growth")).toEqual([]);
    expect(find("Read at https://abc.com/news")[0].basis).toBe("domain");
    expect(find("Read at https://abc.com.evil.com/news")).toEqual([]);
  });
  it("ranks only verified free supported candidates ahead of unsupported sources using actual account locations", () => {
    const sources = [source("va", { states: ["Virginia"] }), source("wa"), source("paid", { free_access: false, states: [] }), source("pdf", { format: "pdf" })];
    const ranked = rankSharedSources(sources, [account("1"), account("2", "Other Services", "Washington"), account("3", "Virginia Services", "VA")]);
    expect(ranked.slice(0, 2).map((r) => [r.source.id, r.accountCount])).toEqual([["wa", 2], ["va", 1]]);
    expect(ranked.slice(2).every((r) => !r.supported)).toBe(true);
  });
});

describe("durable shared collection", () => {
  it("reuses a retained feed on 304 while continuing its durable pending article work", async () => {
    const retained = source("state", { last_success_at: "2026-09-18T00:00:00Z", http_validators: { url: source().url, etag: '"feed-v1"' } });
    const deps = fixture({ sources: vi.fn().mockResolvedValue([retained]), claim: vi.fn().mockResolvedValue(retained) });
    deps.fetchText.mockImplementation(async url => url === retained.url ? { status: 304, body: "", finalUrl: url, contentType: "application/rss+xml" }
      : { status: 200, body: `<article>${article}</article>`, finalUrl: url, contentType: "text/html" });
    const result = await runSharedSources(deps);
    expect(result).toMatchObject({ notModified: 1, empty: 0, processed: 1, observations: 1, failed: 0 });
    expect(deps.store.snapshot).toHaveBeenCalledWith(retained, null, null, { validators: retained.http_validators, unchanged: true });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.store.item).toHaveBeenCalledWith(retained, item.item_key, { done: true });
  });
  it("requires both deployment and database gates before any feed or account access", async () => {
    const deps = fixture();
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    expect((await runSharedSources(deps)).enabled).toBe(false);
    expect(deps.store.enabled).not.toHaveBeenCalled();
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
    vi.mocked(deps.store.enabled).mockResolvedValue(false);
    await runSharedSources(deps);
    expect(deps.store.accounts).not.toHaveBeenCalled();
    expect(deps.fetchText).not.toHaveBeenCalled();
  });
  it("fetches a feed once and an article once, then shares the body with exact candidate accounts", async () => {
    const deps = fixture({ accounts: vi.fn().mockResolvedValue([account("1"), account("2", "Tacoma Operations")]) });
    deps.fetchText.mockImplementation(async (url) => ({ status: 200, body: url.includes("/feed") ? feed : `<main>${article} Tacoma Operations has joined the network.</main>`, finalUrl: url, contentType: "text/html" }));
    const result = await runSharedSources(deps);
    expect(deps.fetchText).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ fetched: 1, processed: 1, observations: 2, failed: 0 });
    expect(result.matchedAccounts).toBe(2);
    expect(result.sourceYield).toEqual([expect.objectContaining({ matchedAccounts: 2, observations: 2, processedItems: 1 })]);
    expect(deps.store.snapshot).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.objectContaining({ item_key: expect.any(String) })]), null, expect.objectContaining({ entityRepairs: 0 }));
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "news", text: expect.stringContaining("Tacoma Operations"),
      metadata: expect.objectContaining({ sourceRole: "announcement_context", identityVerified: false, governmentAwardVerified: false, candidateMatch: "exact_name" }) }));
    expect(deps.store.item).toHaveBeenLastCalledWith(expect.anything(), item.item_key, { done: true });
  });
  it("caches the article before enqueuing and leaves failed observation storage pending", async () => {
    const deps = fixture();
    deps.enqueue.mockRejectedValue(new Error("storage down"));
    const result = await runSharedSources(deps);
    expect(result).toMatchObject({ processed: 0, failed: 1 });
    expect(deps.store.item).toHaveBeenNthCalledWith(1, expect.anything(), item.item_key, { payload: expect.objectContaining({ bodyFetched: true, text: article.trim() }) });
    expect(deps.store.item).toHaveBeenLastCalledWith(expect.anything(), item.item_key, { error: "article_or_observation_pending" });
    expect(deps.store.release).toHaveBeenCalledWith(expect.anything(), "article_or_observation_pending");
  });
  it("uses the fetched publisher URL while retaining the original feed headline and date", async () => {
    const deps = fixture();
    const publisherUrl = "https://publisher.example/news/expansion";
    deps.fetchText.mockImplementation(async url => ({ status: 200, body: url.includes("/feed") ? feed
      : `<title>Publisher's operating announcement</title><meta property="article:published_time" content="2026-09-16"><main>${article}</main>`,
      finalUrl: url.includes("/feed") ? url : publisherUrl, contentType: "text/html" }));
    expect((await runSharedSources(deps)).observations).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: publisherUrl, title: item.payload.title, eventDate: item.payload.eventDate,
      metadata: expect.objectContaining({ eventDateBasis: "feed_publication", sourceDates: [{ kind: "published", value: "2026-09-16T00:00:00.000Z", source: "article:published_time" }],
        discovery: { collector: "shared_feed", url: item.payload.url, title: item.payload.title, eventDate: item.payload.eventDate } }) }));
    expect(deps.store.item).toHaveBeenNthCalledWith(1, expect.anything(), item.item_key, { payload: expect.objectContaining({ url: publisherUrl, bodyFetched: true,
      discovery: { url: item.payload.url, title: item.payload.title, eventDate: item.payload.eventDate } }) });
  });
  it("does not complete an item when the queue is disabled during the run", async () => {
    const deps = fixture();
    deps.enqueue.mockResolvedValue(null);
    expect((await runSharedSources(deps)).processed).toBe(0);
    expect(vi.mocked(deps.store.item).mock.calls.some((call) => call[2].done)).toBe(false);
  });
  it("resumes cached backlog without fetching either a not-due feed or its article", async () => {
    const deps = fixture({ claim: vi.fn().mockResolvedValue(source("state", { next_fetch_at: "2026-09-19T00:00:00Z" })),
      pending: vi.fn().mockResolvedValue([{ ...item, payload: { ...item.payload, bodyFetched: true, text: article } }]) });
    expect((await runSharedSources(deps)).observations).toBe(1);
    expect(deps.fetchText).not.toHaveBeenCalled();
  });
  it("marks source failure separately and still processes already persisted backlog", async () => {
    const deps = fixture({ pending: vi.fn().mockResolvedValue([{ ...item, payload: { ...item.payload, bodyFetched: true, text: article } }]) });
    deps.fetchText.mockRejectedValue(new Error("offline"));
    expect(await runSharedSources(deps)).toMatchObject({ fetched: 0, empty: 0, failed: 1, processed: 1 });
    expect(deps.store.snapshot).toHaveBeenCalledWith(expect.anything(), null, "feed_fetch_or_persistence_failed");
  });
  it("records a genuine empty success with no fabricated coverage or observation", async () => {
    const deps = fixture({ pending: vi.fn().mockResolvedValue([]) });
    deps.fetchText.mockResolvedValue({ status: 200, body: '<rss version="2.0"><channel><title>Empty</title></channel></rss>', finalUrl: source().url, contentType: "application/rss+xml" });
    expect(await runSharedSources(deps)).toMatchObject({ fetched: 1, empty: 1, failed: 0, observations: 0 });
    expect(deps.store.snapshot).toHaveBeenCalledWith(expect.anything(), [], null, expect.objectContaining({ entityRepairs: 0 }));
  });
  it("retains unreadable article bodies instead of substituting the headline", async () => {
    const deps = fixture();
    deps.fetchText.mockImplementation(async (url) => ({ status: 200, body: url.includes("/feed") ? feed : "blocked", finalUrl: url, contentType: "text/html" }));
    expect((await runSharedSources(deps)).failed).toBe(1);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it("leases oldest due sources first so concentration never starves a small source", async () => {
    const newer = source("large", { next_fetch_at: "2026-09-18T10:00:00Z" });
    const older = source("small", { states: ["VA"], next_fetch_at: "2026-09-17T10:00:00Z" });
    const deps = fixture({ sources: vi.fn().mockResolvedValue([newer, older]), claim: vi.fn().mockResolvedValue(null) });
    await runSharedSources(deps);
    expect(deps.store.claim).toHaveBeenNthCalledWith(1, "small");
    expect(deps.fetchText).not.toHaveBeenCalled();
  });
});
