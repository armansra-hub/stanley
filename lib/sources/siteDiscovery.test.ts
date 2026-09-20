import { describe, expect, it } from "vitest";
import { companyPageUrl, discoverSiteLinks, sitePageEvidence, sitemapLocations } from "./siteDiscovery";

describe("company source discovery and evidence", () => {
  it("does not trust canonical tags to collapse unrelated or distinct documents", () => {
    for (const canonical of ["https://foreign.example/story", "https://acme.com/"]) {
      const page = sitePageEvidence(`<title>New office</title><link rel="canonical" href="${canonical}"><main>Office announcement.</main>`, "https://acme.com/news/office");
      expect(page.url).toBe("https://acme.com/news/office");
    }
  });
  it("discovers relevant same-company PDFs only when deeper research requests them", () => {
    const html = '<a href="/capabilities.pdf">Capability statement</a><a href="https://foreign.com/annual.pdf">Annual report</a>';
    expect(discoverSiteLinks(html, "https://acme.com")).toEqual([]);
    expect(discoverSiteLinks(html, "https://acme.com", { includePdf: true })).toEqual([
      { url: "https://acme.com/capabilities.pdf", label: "Capability statement", kind: "services" },
    ]);
  });
  it("keeps publication, update and generic time distinct while normalizing equal dates", () => {
    const page = sitePageEvidence('<meta itemprop="datePublished" content="2026-09-17T00:00:00Z"><time itemprop="datePublished" datetime="2026-09-17">September 17, 2026</time><main>Published on September 17, 2026. Updated on September 18, 2026. Our company was founded in 1995.</main><footer>Copyright 2026</footer>', "https://acme.com/news/story");
    expect(page.sourceDates).toHaveLength(2);
    expect(page.sourceDates.map(date => [date.kind, date.value])).toEqual([["published", "2026-09-17T00:00:00.000Z"], ["modified", "2026-09-18T00:00:00.000Z"]]);
  });
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
    expect(first.sourceDates).toEqual([{ value: "2026-09-17T00:00:00.000Z", kind: "published", source: "date" }, { value: "2026-09-18T00:00:00.000Z", kind: "time", source: "time[datetime]" }]);
    expect(second.sourceDates).toEqual([]);
  });

  it("keeps the complete article, its paragraphs and an editorial closing footnote", () => {
    const page = sitePageEvidence(`<title>A holiday message</title><header>Site menu</header><main>
      <article class="post no-comments"><header><h1>A holiday message</h1></header>
        <p>We celebrate the holiday\nwith our readers.</p>
        <div><p>Our newsletter and subscription business will change.</p></div>
        <aside><p>Editor's note: the publication will close after this issue.</p></aside>
        <footer><p>Our final edition will be published next month.</p></footer>
      </article></main><footer>Site copyright</footer>`, "https://publisher.com/news/final-edition");
    expect(page.text).toBe("A holiday message\n\nWe celebrate the holiday with our readers.\n\nOur newsletter and subscription business will change.\n\nEditor's note: the publication will close after this issue.\n\nOur final edition will be published next month.");
    expect(page.truncated).toBe(false);
  });

  it("removes structurally marked widgets without filtering the article's business language", () => {
    const page = sitePageEvidence(`<article><p>We acquired a newsletter publisher and are closing two offices.</p>
      <div class="related-posts"><article>Unrelated company's major acquisition.</article></div>
      <div class="newsletter-signup"><p>Sign up for our newsletter.</p></div>
      <div id="comments"><p>Anonymous commenter claims a contract win.</p></div>
      <div class="cookie-consent">Accept our cookies.</div>
      <div class="social-share">Share this post.</div>
      <aside class="sidebar"><p>Popular stories elsewhere.</p></aside>
      <p>Our final paragraph is part of the operating announcement.</p></article>`, "https://acme.com/news");
    expect(page.text).toBe("We acquired a newsletter publisher and are closing two offices.\n\nOur final paragraph is part of the operating announcement.");
  });

  it("does not stop a main container at the first nested article's closing tag", () => {
    const page = sitePageEvidence('<main><h1>Newsroom</h1><article><p>First news item.</p></article><article><p>Second news item.</p></article><p>Office closure notice at the end.</p></main>', "https://acme.com/news");
    expect(page.text).toBe("Newsroom\n\nFirst news item.\n\nSecond news item.\n\nOffice closure notice at the end.");
  });

  it("keeps text and hashes stable when widgets or HTML formatting change", () => {
    const first = sitePageEvidence('<main><p>Our <strong>new</strong> office\nopens soon.</p><div class="related-posts">Old unrelated story.</div></main>', "https://acme.com/news");
    const second = sitePageEvidence('<main><p>Our <strong>new</strong> office opens soon.</p><div class="related-posts">An entirely different story.</div></main>', "https://acme.com/news");
    expect(first.text).toBe("Our new office opens soon.");
    expect(first.contentHash).toBe(second.contentHash);
  });

  it("does not version an unchanged article for rotating related-post timestamps or JSON payloads", () => {
    const html = (widgetDate: string) => `<head><meta property="article:published_time" content="2026-09-17"></head>
      <script type="application/ld+json">${JSON.stringify({ "@graph": [
        { "@type": "BlogPosting", "@id": "https://acme.com/news/service#article", datePublished: "2026-09-17", dateModified: "2026-09-18" },
        { "@type": "BlogPosting", url: "https://acme.com/news/unrelated", datePublished: widgetDate },
        { "@type": "Organization", url: "https://acme.com", dateModified: widgetDate },
      ] })}</script><script>window.related = {"dateModified":"${widgetDate}"}</script>
      <article><p>Our company added a new service.</p><time itemprop="datePublished" datetime="2026-09-17"></time>
      <div class="related-posts"><meta itemprop="datePublished" content="${widgetDate}"><time itemprop="datePublished" datetime="${widgetDate}">Read another story</time></div></article>`;
    const first = sitePageEvidence(html("2026-09-19"), "https://acme.com/news/service");
    const second = sitePageEvidence(html("2026-09-20"), "https://acme.com/news/service");
    expect(first.text).toBe(second.text);
    expect(first.sourceDates).toEqual(second.sourceDates);
    expect(first.sourceDates.map(({ kind, value }) => [kind, value])).toEqual([
      ["published", "2026-09-17T00:00:00.000Z"], ["modified", "2026-09-18T00:00:00.000Z"],
    ]);
  });

  it("retains genuine article publication and modification changes, including a sole URL-less schema", () => {
    const page = (modified: string) => sitePageEvidence(`<script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle", datePublished: "2026-09-17", dateModified: modified,
    })}</script><article>Same retained announcement.</article>`, "https://acme.com/news/service");
    expect(page("2026-09-18").sourceDates).not.toEqual(page("2026-09-19").sourceDates);
    expect(page("2026-09-18").sourceDates).toHaveLength(2);
    const unrelated = sitePageEvidence(`<script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle", url: "https://acme.com/another-article", datePublished: "2026-09-20",
    })}</script><article>Undated announcement.</article>`, "https://acme.com/news/service");
    expect(unrelated.sourceDates).toEqual([]);
  });

  it("keeps related articles discoverable without treating their rotating dates as this article's dates", () => {
    const url = "https://acme.com/news/older-article";
    const html = (date: string) => `<head><meta property="article:published_time" content="2015-10-23"></head>
      <article><p>The original dated company announcement.</p><time datetime="2015-10-23"></time></article>
      <aside><a href="/news/new-company-announcement">Company news</a><time datetime="${date}"></time></aside>`;
    const first = sitePageEvidence(html("2016-10-20"), url);
    const second = sitePageEvidence(html("2021-09-04"), url);
    expect(first.sourceDates).toEqual(second.sourceDates);
    expect(discoverSiteLinks(html("2021-09-04"), url)).toContainEqual({ url: "https://acme.com/news/new-company-announcement", kind: "news", label: "Company news" });
  });

  it("accepts only addresses directly attached to named same-site organizations", () => {
    const schema = { "@graph": [
      { "@type": "Organization", "@id": "https://acme.com/#organization", name: "Acme Services", alternateName: "Acme", url: "https://www.acme.com", address: { "@type": "PostalAddress", streetAddress: "100 Main Street", addressLocality: "Denver", addressRegion: "CO", postalCode: "80202", addressCountry: "United States" } },
      { "@type": "Organization", "@id": "https://acme.com/#customer", name: "Customer Incorporated", url: "https://customer.com", address: { streetAddress: "999 Customer Way" } },
      { "@type": "LocalBusiness", name: "Different subsidiary", url: "https://acme.com/subsidiary", address: { streetAddress: "500 Subsidiary Avenue" } },
      { "@type": "Event", name: "Industry event", location: { "@type": "Place", address: { streetAddress: "123 Convention Drive" } } },
      { "@type": "PostalAddress", streetAddress: "Unscoped address" },
    ] };
    const page = sitePageEvidence(`<script type="application/ld+json">${JSON.stringify(schema)}</script><main>Our company.</main>`, "https://acme.com/about");
    expect(page.companyIdentity).toEqual({ names: ["Acme Services", "Acme"], addresses: [{ addressLine1: "100 Main Street", city: "Denver", state: "CO", postalCode: "80202", countryCode: "US" }], sourceUrl: "https://acme.com/about" });
    expect(page.text).toBe("Our company.");
  });

  it("supports an explicit article publisher but does not walk customers, events or arbitrary JSON", () => {
    const publisher = { "@type": "NewsMediaOrganization", name: "Publisher", url: "https://publisher.com", address: { addressLocality: "Minneapolis", addressRegion: "MN" } };
    const page = sitePageEvidence(`<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", publisher, about: { ...publisher, name: "Unrelated subject" } })}</script><article>Article body.</article>`, "https://publisher.com/story");
    expect(page.companyIdentity?.names).toEqual(["Publisher"]);
    for (const value of [
      { "@type": "Organization", name: "No domain", address: { addressLocality: "Unknown" } },
      { "@type": "Event", organizer: publisher },
      { customers: [publisher] },
    ]) {
      expect(sitePageEvidence(`<script type="application/ld+json">${JSON.stringify(value)}</script>`, "https://publisher.com").companyIdentity).toBeUndefined();
    }
  });
});
