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
  it("retains a meaningful feed headline/date alongside a conflicting page publication date", async () => {
    fetch.mockResolvedValue({ body: `<title>Publisher headline</title><meta property="article:published_time" content="2026-09-16"><main>${"Acme announced a new services contract. ".repeat(6)}</main>`, status: 200, finalUrl: "https://publisher.com/news/acme", contentType: "text/html" });
    const result = await readNewsEvidence({ ...item, signal_date: "2026-09-17" });
    expect(result).toMatchObject({ sourceUrl: "https://publisher.com/news/acme", title: item.raw_excerpt, eventDate: "2026-09-17",
      metadata: { eventDateBasis: "feed_publication", sourceDates: [{ kind: "published", value: "2026-09-16T00:00:00.000Z", source: "article:published_time" }],
        discovery: { collector: "news", url: item.source_url, title: item.raw_excerpt, eventDate: "2026-09-17" } } });
  });
  it("does not select unrelated or ambiguous publisher navigation", () => {
    expect(publisherArticleLinks('<a href="https://other.com/news/acme">Story</a>', item.publisher_url)).toEqual([]);
    expect(publisherArticleLinks('<a href="https://publisher.com/news/one">One</a><a href="https://publisher.com/news/two">Two</a>', item.publisher_url)).toEqual([]);
  });
  it("labels article-host structured identity as publisher context, never the prospect", async () => {
    fetch.mockResolvedValue({ body: `<script type="application/ld+json">{"@type":"Organization","name":"Publisher","url":"https://publisher.com","address":{"addressLocality":"Boston"}}</script><article>${"Acme announced a services contract. ".repeat(6)}</article>`, status: 200, finalUrl: "https://publisher.com/news/acme", contentType: "text/html" });
    const result = await readNewsEvidence({ ...item, source_url: "https://publisher.com/news/acme" });
    expect(result.metadata).toMatchObject({ publisherIdentity: { names: ["Publisher"], addresses: [{ city: "Boston" }], sourceUrl: "https://publisher.com/news/acme" } });
    expect(result.metadata).not.toHaveProperty("companyIdentity");
  });
});
