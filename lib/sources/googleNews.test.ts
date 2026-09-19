import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { fetchNewsItemsResult, fetchFeed, fetchGoogleNewsCandidates, fetchNewsItems } from "./googleNews";
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: vi.fn() }));
const fetch = vi.mocked(fetchPublicHttpText);
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item>
  <title>Acme opens a new office</title><link>https://news.example/article</link>
  <pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate>
</item></channel></rss>`;
const response = (body: string, status = 200) => ({ body, status, finalUrl: "https://news.google.com/rss/search", contentType: "application/rss+xml" });
beforeEach(() => { fetch.mockReset(); });
describe("RSS outcome semantics", () => {
  it("distinguishes a valid empty feed from a blocked or malformed response", async () => {
    fetch.mockResolvedValueOnce(response('<rss version="2.0"><channel><title>Search</title></channel></rss>'));
    expect(await fetchNewsItemsResult("Acme")).toMatchObject({ status: "empty", items: [] });
    fetch.mockResolvedValueOnce(response("Forbidden", 403));
    expect(await fetchNewsItemsResult("Acme")).toMatchObject({ status: "unavailable", error: "blocked" });
    fetch.mockResolvedValueOnce(response("<html>Not RSS</html>"));
    expect(await fetchNewsItemsResult("Acme")).toMatchObject({ status: "unavailable", error: "parse_error" });
  });
  it("retains the RSS publisher URL needed to resolve Google article gateways", async () => {
    fetch.mockResolvedValue(response('<rss version="2.0"><channel><title>News</title><item><title>Acme wins contract</title><link>https://news.google.com/rss/articles/test</link><source url="https://publisher.com">Publisher</source></item></channel></rss>'));
    expect((await fetchNewsItemsResult("Acme")).items[0]).toMatchObject({ publisher_url: "https://publisher.com" });
  });
});


describe("guarded news-source fetching", () => {
  it("uses the pinned public fetch for Google News discovery and per-company news", async () => {
    fetch.mockResolvedValue({
      body: RSS,
      finalUrl: "https://news.google.com/rss/search",
      status: 200,
      contentType: "application/rss+xml",
    });

    await expect(fetchNewsItems("Acme", 1)).resolves.toHaveLength(1);
    await expect(fetchGoogleNewsCandidates(["Acme"], 1, 1)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("https://news.google.com/rss/search?"))).toBe(true);
  });

  it("uses the same guard for arbitrary company newsroom feed URLs", async () => {
    fetch.mockResolvedValue({
      body: RSS,
      finalUrl: "https://acme.com/feed.xml",
      status: 200,
      contentType: "application/rss+xml",
    });
    await expect(fetchFeed("https://acme.com/feed.xml", 1)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("https://acme.com/feed.xml", expect.objectContaining({ timeoutMs: 12_000 }));
  });

  it("fails closed when the target guard rejects a feed", async () => {
    fetch.mockRejectedValue(new Error("unsafe HTTP target"));

    await expect(fetchFeed("http://169.254.169.254/latest/meta-data", 1)).resolves.toEqual([]);
  });
});
