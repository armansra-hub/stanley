import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { fetchFeed, fetchGoogleNewsCandidates, fetchNewsItems } from "./googleNews";

vi.mock("@/lib/triggers/urlSafety", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(),
  fetchPublicHttpText: vi.fn(),
}));

const guardedFetch = vi.mocked(fetchPublicHttpText);
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item>
  <title>Acme opens a new office</title><link>https://news.example/article</link>
  <pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate>
</item></channel></rss>`;

afterEach(() => vi.clearAllMocks());

describe("guarded news-source fetching", () => {
  it("uses the pinned public fetch for Google News discovery and per-company news", async () => {
    guardedFetch.mockResolvedValue({
      body: RSS,
      finalUrl: "https://news.google.com/rss/search",
      status: 200,
      contentType: "application/rss+xml",
    });

    await expect(fetchNewsItems("Acme", 1)).resolves.toHaveLength(1);
    await expect(fetchGoogleNewsCandidates(["Acme"], 1, 1)).resolves.toHaveLength(1);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch.mock.calls.every(([url]) => String(url).startsWith("https://news.google.com/rss/search?"))).toBe(true);
  });

  it("uses the same guard for arbitrary company newsroom feed URLs", async () => {
    guardedFetch.mockResolvedValue({
      body: RSS,
      finalUrl: "https://acme.com/feed.xml",
      status: 200,
      contentType: "application/rss+xml",
    });
    await expect(fetchFeed("https://acme.com/feed.xml", 1)).resolves.toHaveLength(1);
    expect(guardedFetch).toHaveBeenCalledWith("https://acme.com/feed.xml", expect.objectContaining({ timeoutMs: 12_000 }));
  });

  it("fails closed when the target guard rejects a feed", async () => {
    guardedFetch.mockRejectedValue(new Error("unsafe HTTP target"));
    await expect(fetchFeed("http://169.254.169.254/latest/meta-data", 1)).resolves.toEqual([]);
  });
});
