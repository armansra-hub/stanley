import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
import { collectCustomerReferenceSources, type CustomerSourceInput, type CustomerSourceCapture } from "./customerReferenceCollector";
const input: CustomerSourceInput = { id: "acme", name: "Acme", domain: "acme.com", website: "https://acme.com/", candidateUrls: [], sources: [] };
const page = (url: string, body: string, status = 200) => ({ finalUrl: url, body, status, contentType: "text/html" });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function harness(pages: Record<string, ReturnType<typeof page>>) {
  const writes: CustomerSourceCapture[] = [];
  const save = vi.fn(async (state: CustomerSourceCapture) => { writes.push(structuredClone(state)); return true; });
  const fetchText = vi.fn(async (url: string) => {
    expect(writes.at(-1)?.checkpoint.pendingUrl).toBe(url);
    return pages[url] ?? page(url, "missing", 404);
  });
  return { writes, save, fetchText };
}
afterEach(() => vi.restoreAllMocks());

describe("full-cohort official website collection", () => {
  it("uses real homepage/observed operating links and verified URLs, never invented paths or third-party pages", async () => {
    const h = harness({
      "https://acme.com/": page("https://acme.com/", '<title>Acme</title><main>We install and maintain equipment.</main><a href="/our-services">Services</a><a href="/team/about">About</a><a href="https://other-company.com/services">Services</a><a href="/blog/news">News</a>'),
      "https://acme.com/our-services": page("https://acme.com/our-services", '<main>Managed service and hardware installation.</main><a href="/our-services/more">More services</a>'),
      "https://acme.com/team/about": page("https://acme.com/team/about", "<main>Our own experienced operating team.</main>"),
      "https://acme.com/capabilities": page("https://acme.com/capabilities", "<main>National field services.</main>"),
    });
    const result = await collectCustomerReferenceSources({ ...input, candidateUrls: ["https://acme.com/capabilities", "https://other-company.com/"] }, null, Date.now() + 100_000, h);
    expect(result.outcome).toBe("ready");
    expect(h.fetchText.mock.calls.map(([url]) => url)).toEqual(["https://acme.com/", "https://acme.com/capabilities", "https://acme.com/our-services", "https://acme.com/team/about"]);
    expect(result.sources).toHaveLength(4);
    for (const source of result.sources) expect(source.contentHash).toBe(digest(source.text));
    expect(result.checkpoint.pendingUrl).toBeUndefined();
  });

  it("retains the whole extracted source beyond the ordinary 24k page preview", async () => {
    const text = "Our operating service description. ".repeat(1_000).trim();
    const h = harness({ "https://acme.com/": page("https://acme.com/", `<main>${text}</main>`) });
    const result = await collectCustomerReferenceSources(input, null, Date.now() + 100_000, h);
    expect(result.sources[0].text).toBe(text);
    expect(result.sources[0].text.length).toBeGreaterThan(24_000);
    expect(result.sources[0].contentHash).toBe(digest(text));
  });

  it("does not mistake legal footer terms for services, but keeps explicitly selected legal evidence", async () => {
    const h = harness({
      "https://acme.com/": page("https://acme.com/", '<main>Legal services and privacy consulting.</main><a href="/terms-of-use">Terms of Service</a><a href="/privacy-policy">Privacy Policy</a><a href="/legal-services">Legal services</a><a href="/commercial-terms">Terms of Service</a>'),
      "https://acme.com/legal-services": page("https://acme.com/legal-services", '<main>Our legal operations consulting services.</main>'),
      "https://acme.com/commercial-terms": page("https://acme.com/commercial-terms", '<main>Published charging and commercial terms.</main>'),
    });
    const result = await collectCustomerReferenceSources({ ...input, candidateUrls: ["https://acme.com/commercial-terms"] }, null, Date.now() + 100_000, h);
    expect(h.fetchText.mock.calls.map(([url]) => url)).toEqual(["https://acme.com/", "https://acme.com/commercial-terms", "https://acme.com/legal-services"]);
    expect(result.sources.map(source => source.url)).toContain("https://acme.com/commercial-terms");
    expect(result.outcome).toBe("ready");
  });

  it("resumes the exact remaining URL while preserving already captured text and not redownloading it", async () => {
    let now = Date.now(); const start = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = harness({ "https://acme.com/": page("https://acme.com/", '<main>Our own services.</main><a href="/about">About</a>'),
      "https://acme.com/about": page("https://acme.com/about", "<main>Our operating team.</main>") });
    const original = h.fetchText.getMockImplementation()!;
    h.fetchText.mockImplementation(async url => { const result = await original(url); now = start + 25_000; return result; });
    const first = await collectCustomerReferenceSources(input, null, start + 30_000, h);
    expect(first.outcome).toBe("continued"); expect(first.sources).toHaveLength(1);
    now = start;
    const second = await collectCustomerReferenceSources({ ...input, sources: first.sources }, first.checkpoint, start + 100_000, h);
    expect(second.outcome).toBe("ready");
    expect(h.fetchText.mock.calls.map(([url]) => url)).toEqual(["https://acme.com/", "https://acme.com/about"]);
    expect(second.sources[0]).toEqual(first.sources[0]);
  });

  it("keeps an actual privacy service page while excluding the generic privacy footer", async () => {
    const h = harness({
      "https://acme.com/": page("https://acme.com/", '<main>Privacy consulting.</main><a href="/services/privacy">Data privacy</a><a href="/privacy-policy">Privacy Policy</a>'),
      "https://acme.com/services/privacy": page("https://acme.com/services/privacy", '<main>We provide managed privacy operations and compliance services.</main>'),
    });
    const result = await collectCustomerReferenceSources(input, null, Date.now() + 100_000, h);
    expect(h.fetchText.mock.calls.map(([url]) => url)).toEqual(["https://acme.com/", "https://acme.com/services/privacy"]);
    expect(result.sources[1].text).toBe("We provide managed privacy operations and compliance services.");
    expect(result.outcome).toBe("ready");
  });

  it("checkpoints anti-bot failures once and does not repeatedly download a blocked site", async () => {
    const h = harness({ "https://acme.com/": page("https://acme.com/", "Access denied", 403) });
    const first = await collectCustomerReferenceSources(input, null, Date.now() + 100_000, h);
    expect(first.outcome).toBe("blocked");
    expect(first.sources).toEqual([]);
    expect(first.checkpoint.attempts["https://acme.com/"]).toMatchObject({ outcome: "unavailable", code: "blocked", status: 403 });
    const second = await collectCustomerReferenceSources(input, first.checkpoint, Date.now() + 100_000, h);
    expect(second.outcome).toBe("blocked"); expect(h.fetchText).toHaveBeenCalledTimes(1);
  });

  it("retains successful evidence when a separate official URL has a gap", async () => {
    const h = harness({ "https://acme.com/": page("https://acme.com/", "<main>Installation and support.</main>") });
    const result = await collectCustomerReferenceSources({ ...input, candidateUrls: ["https://acme.com/known-page"] }, null, Date.now() + 100_000, h);
    expect(result.outcome).toBe("ready"); expect(result.sources).toHaveLength(1);
    expect(result.checkpoint.sourceGaps).toEqual(["https://acme.com/known-page: missing"]);
  });

  it.each([
    page("https://other-company.com/", "<main>Other company's operations.</main>"),
    page("https://acme.com/", "<main>Only part of the document.</main>", 206),
  ])("refuses cross-company redirects and partial responses as customer facts", async response => {
    const h = harness({ "https://acme.com/": response });
    const result = await collectCustomerReferenceSources(input, null, Date.now() + 100_000, h);
    expect(result.outcome).toBe("blocked"); expect(result.sources).toEqual([]);
    expect(result.checkpoint.sourceGaps).toHaveLength(1);
  });

  it("never fetches a company whose official website identity is unresolved", async () => {
    const h = harness({});
    const result = await collectCustomerReferenceSources({ ...input, domain: null }, null, Date.now() + 100_000, h);
    expect(result.outcome).toBe("blocked"); expect(h.fetchText).not.toHaveBeenCalled();
  });

  it("stops on uncertain checkpoint storage without replaying the write or starting another source", async () => {
    const h = harness({ "https://acme.com/": page("https://acme.com/", "<main>Service delivery.</main>") });
    h.save.mockImplementationOnce(async state => { h.writes.push(structuredClone(state)); return true; }).mockRejectedValueOnce(new Error("database_timeout"));
    await expect(collectCustomerReferenceSources(input, null, Date.now() + 100_000, h)).rejects.toThrow("database_timeout");
    expect(h.save).toHaveBeenCalledTimes(2); expect(h.fetchText).toHaveBeenCalledTimes(1);
  });
});
