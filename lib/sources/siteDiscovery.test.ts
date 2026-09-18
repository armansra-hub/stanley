import { describe, expect, it } from "vitest";
import { companyPageUrl, discoverSiteLinks, sitePageEvidence, sitemapLocations } from "./siteDiscovery";

describe("company source discovery and evidence", () => {
  it("keeps source identity and rejects unsafe or unrelated links", () => {
    expect(companyPageUrl("/news?a=1&amp;utm_source=email#story", "https://acme.com")).toBe("https://acme.com/news?a=1");
    expect(companyPageUrl("https://news.acme.com/updates", "https://acme.com")).toBe("https://news.acme.com/updates");
    for (const url of ["javascript:alert(1)", "http://127.0.0.1/a", "https://acme.com.evil.test/news", "https://user:pass@acme.com/news", "/manual.pdf"]) {
      expect(companyPageUrl(url, "https://acme.com")).toBeNull();
    }
  });

  it("uses meaningful link labels and XML locations without leaving the company", () => {
    expect(discoverSiteLinks('<a href="/company/story">Who we are</a>', "https://acme.com")).toEqual([{ url: "https://acme.com/company/story", kind: "about", label: "Who we are" }]);
    expect(sitemapLocations('<loc><![CDATA[https://acme.com/news]]></loc><loc>https://foreign.com/news</loc>', "https://acme.com")).toEqual(["https://acme.com/news"]);
  });

  it("ignores navigation-only changes and retains explicit date provenance", () => {
    const first = sitePageEvidence('<title>Acme</title><nav>Old navigation</nav><main>New branch in Denver.</main><footer>Copyright 2025</footer><meta name="date" content="2026-09-17"><time datetime="2026-09-18">Updated</time>', "https://acme.com/news");
    const second = sitePageEvidence('<title>Acme</title><nav>Entirely different menu</nav><main>New branch in Denver.</main><footer>Copyright 2026</footer>', "https://acme.com/news");
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.text).toBe("New branch in Denver.");
    expect(first.sourceDates).toEqual([{ value: "2026-09-17", kind: "published", source: "date" }, { value: "2026-09-18", kind: "time", source: "time[datetime]" }]);
    expect(second.sourceDates).toEqual([]);
  });
});
