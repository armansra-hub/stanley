import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { fetchSiteSignals } from "./website";

vi.mock("@/lib/triggers/urlSafety", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(),
  fetchPublicHttpText: vi.fn(),
}));

const guardedFetch = vi.mocked(fetchPublicHttpText);

afterEach(() => vi.clearAllMocks());

const posting = `
  <html><body><h1>Join our team</h1><p>We are hiring. Current openings.</p>
  <h2>Controller</h2><p>Full-time job description. Apply now.</p>
  <p>Responsibilities include close and reporting. Qualifications include seven years of experience.</p>
  <p>Benefits include medical, dental, and retirement. Submit your application today.</p>
  </body></html>
`;

function response(body: string, finalUrl: string) {
  return { body, finalUrl, status: 200, contentType: "text/html" };
}

describe("website career evidence redirects", () => {
  it("uses a verified final careers URL", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.com/careers");
      return response("<html><body>Acme operating company.</body></html>", url);
    });

    const scan = await fetchSiteSignals("acme.com", "Acme");
    expect(scan.financeRoles).toEqual([expect.objectContaining({ role: "Controller", url: "https://acme.com/careers" })]);
  });

  it("fails closed when /careers redirects to an unrelated page", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/careers")) return response(posting, "https://acme.com/solutions/");
      return response("<html><body>Acme operating company.</body></html>", url);
    });

    const scan = await fetchSiteSignals("acme.com", "Acme");
    expect(scan.financeRoles).toEqual([]);
  });

  it("routes every company-derived page through the DNS-pinned public fetch", async () => {
    guardedFetch.mockResolvedValue(response("<html><body>Acme</body></html>", "https://acme.com/"));

    await fetchSiteSignals("acme.com", "Acme");

    expect(guardedFetch).toHaveBeenCalledTimes(6);
    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      "https://acme.com",
      "https://acme.com/sitemap.xml",
      "https://acme.com/about",
      "https://acme.com/news",
      "https://acme.com/careers",
      "https://acme.com/jobs",
    ]));
  });

  it("fails closed when the public-target guard rejects a company-derived URL", async () => {
    guardedFetch.mockRejectedValue(new Error("unsafe HTTP target"));
    const scan = await fetchSiteSignals("user:pass@127.0.0.1:8080", "Unsafe");

    expect(scan).toMatchObject({ growth: [], parent: null, feedUrl: null, financeRoles: [], pages: [] });
    expect(guardedFetch).toHaveBeenCalled();
  });

  it("discovers real links, child sitemaps and newsroom feeds with exact source dates", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      const pages: Record<string, string> = {
        "https://acme.com": '<a href="/company/our-team">About</a><a href="/insights">Newsroom</a><a href="/careers/openings">Careers</a><a href="https://unrelated.com/news">News</a>',
        "https://acme.com/sitemap.xml": '<sitemapindex><sitemap><loc>https://acme.com/news-sitemap.xml</loc></sitemap></sitemapindex>',
        "https://acme.com/news-sitemap.xml": '<urlset><url><loc>https://acme.com/news/acquisition</loc></url><url><loc>https://acme.com/locations/new-branch</loc></url></urlset>',
        "https://acme.com/insights": '<link href="/insights/feed.xml" type="application/rss+xml"><a href="/news/acquisition">Acquisition announcement</a>',
        "https://acme.com/news/acquisition": '<title>Acme acquires Target</title><meta content="2026-09-17T10:00:00Z" property="article:published_time"><main>Acme announced the acquisition of Target Services.</main>',
        "https://acme.com/careers/openings": posting,
      };
      return response(pages[url] ?? "<main>Company information.</main>", url);
    });
    const scan = await fetchSiteSignals("acme.com", "Acme");
    expect(scan.discoveredUrls).toContain("https://acme.com/locations/new-branch");
    expect(scan.feedUrl).toBe("https://acme.com/insights/feed.xml");
    expect(scan.pages).toContainEqual(expect.objectContaining({ url: "https://acme.com/news/acquisition", sourceDates: [{ value: "2026-09-17T10:00:00Z", kind: "published", source: "article:published_time" }] }));
    expect(guardedFetch.mock.calls.some(([url]) => String(url).includes("unrelated.com"))).toBe(false);
    expect(scan.financeRoles[0]?.url).toBe("https://acme.com/careers/openings");
  });

  it("retains unfetched candidates and never adopts a cross-company redirect", async () => {
    guardedFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://acme.com") return response(Array.from({ length: 20 }, (_, i) => `<a href="/news/story-${i}">News ${i}</a>`).join(""), url);
      if (url.includes("story")) return response("Unrelated company acquisition", "https://other.com/news");
      return response("", url);
    });
    const scan = await fetchSiteSignals("acme.com", "Acme", { maxPages: 3 });
    expect(scan.coverage.attemptedUrls).toHaveLength(3);
    expect(scan.coverage.remainingUrls.length).toBeGreaterThan(0);
    expect(scan.coverage.failedUrls).toHaveLength(2);
    expect(scan.pages.every((page) => page.url.startsWith("https://acme.com"))).toBe(true);
  });

  it("reports failed request URLs separately from successful redirected pages", async () => {
    guardedFetch.mockImplementation(async input => {
      const url = String(input);
      if (url === "https://acme.com") return response('<a href="/news">News</a><a href="/about">About</a>', "https://www.acme.com/");
      if (url.endsWith("/news")) return { ...response("unavailable", url), status: 503 };
      if (url.endsWith("/about")) return response("<main>About the business.</main>", "https://acme.com/company/about-us");
      return response("<main>Company information.</main>", url);
    });
    const scan = await fetchSiteSignals("acme.com", "Acme", { maxPages: 4 });
    expect(scan.coverage.failedUrls).toEqual(["https://www.acme.com/news"]);
    expect(scan.coverage.succeededUrls).toContain("https://acme.com/company/about-us");
    expect(scan.coverage.failedUrls).not.toContain("https://www.acme.com/about");
  });

  it("does not turn confirmed missing fallback paths into a permanent failure backlog", async () => {
    guardedFetch.mockImplementation(async input => {
      const url = String(input);
      return url === "https://acme.com" ? response("<main>Acme business website.</main>", url)
        : { ...response("Not found", url), status: 404 };
    });
    const scan = await fetchSiteSignals("acme.com", "Acme");
    expect(scan.coverage.failedUrls).toEqual([]);
    expect(scan.discoveredUrls).toEqual([]);
    expect(scan.pages).toHaveLength(1);
  });
});
