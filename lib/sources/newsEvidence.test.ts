import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { publisherArticleLinks, readNewsEvidence } from "./newsEvidence";
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: vi.fn() }));
const fetch = vi.mocked(fetchPublicHttpText);
const item = { source_url: "https://news.google.com/rss/articles/token", publisher_url: "https://publisher.com", raw_excerpt: "Acme wins a new services contract" };
beforeEach(() => { fetch.mockReset(); });
describe("public publisher resolution", () => {
  it("follows one unambiguous publisher link and saves real article text", async () => {
    fetch.mockResolvedValueOnce({ body: '<a href="https://publisher.com/news/acme">Read article</a>', status: 200, finalUrl: item.source_url, contentType: "text/html" });
    fetch.mockResolvedValueOnce({ body: `<main>${"Acme announced a new services contract. ".repeat(6)}</main>`, status: 200, finalUrl: "https://publisher.com/news/acme", contentType: "text/html" });
    const result = await readNewsEvidence(item);
    expect(result.bodyAvailable).toBe(true);
    expect(result.sourceUrl).toBe("https://publisher.com/news/acme");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retains exactly the feed headline when the publisher is blocked", async () => {
    fetch.mockResolvedValue({ body: "Forbidden", status: 403, finalUrl: item.source_url, contentType: "text/html" });
    const result = await readNewsEvidence(item);
    expect(result.text).toBe(item.raw_excerpt);
    expect(result.metadata).toMatchObject({ evidenceKind: "headline_only", articleFetchError: "blocked", articleBodyAvailable: false });
  });
  it("does not select unrelated or ambiguous publisher navigation", () => {
    expect(publisherArticleLinks('<a href="https://other.com/news/acme">Story</a>', item.publisher_url)).toEqual([]);
    expect(publisherArticleLinks('<a href="https://publisher.com/news/one">One</a><a href="https://publisher.com/news/two">Two</a>', item.publisher_url)).toEqual([]);
  });
});
