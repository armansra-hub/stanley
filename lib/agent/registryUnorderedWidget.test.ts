import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { registryWebsiteQuoteOutsideWidget, registryWebsiteText } from "./registryWebsiteText";
import { parseRegistryFinding } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier } from "./registryWebsite";

const mode = "testimonials_widget_unordered_v1" as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const quote = "Acme Inc Headquarters 123 Main Street Suite 4 Austin, TX 78701";
const card = (id: number, position: number, content = `Customer ${id} service experience`) =>
  `<div class="testimonials-widget-testimonial post-${id} testimonials-widget type-testimonials-widget status-publish" style="${position ? "display: none;" : ""}"><!-- source:${id} --><div id="rating-${id}" class="ratings"></div><blockquote><span class="open-quote"></span>${content}<span class="close-quote"></span></blockquote><div class="credit"><span class="author">Author ${id}</span><a href="https://customer.example/${id}" title="customer">Customer</a></div></div>`;
const widget = (order = [20, 3, 11]) => `<div class="testimonials-widget-testimonials testimonials-widget-testimonials123">\n${order.map((id, i) => card(id, i)).join("\n")}\n</div>`;
const page = (order = [20, 3, 11]) => `<main>Company services</main>${widget(order)}<footer>${quote}</footer>`;
const normal = (html: string) => registryWebsiteText(html, mode);
const now = new Date("2026-10-05T01:00:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
function row() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity,
      facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(body = page()) {
  const { legalName: subject, ...address } = identity;
  const p = { sourceUrl: "https://acme.com/contact/", subject, address, quote, quoteSha256: sha(quote), normalization: mode, normalizedVisibleTextSha256: sha(normal(body)) };
  const evidenceSha256 = registryWebsiteEvidenceHash(row(), p);
  return { ...p, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const verify = (body: string, p = proof()) => {
  fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
  return registryWebsiteVerifier()(row(), p, { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now);
};
beforeEach(() => fetch.mockReset());

describe("lossless unordered testimonial-card representation", () => {
  it("accepts only card permutation with unchanged positional display vector", () => {
    expect(normal(page([3, 11, 20]))).toBe(normal(page()));
    for (const id of [3, 11, 20]) expect(normal(page())).toContain(`Customer ${id} service experience`);
    expect(normal(page())).toMatch(/\[registry:testimonials_widget_unordered_v1:sha256:[a-f0-9]{64}\]$/);
  });
  it("leaves every legacy mode unchanged and does not silently opt in", () => {
    for (const version of [undefined, "gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2", "gravity_forms_honeypot_v3", "everest_forms_honeypot_v1", "everest_forms_honeypot_v2", "everest_forms_honeypot_v3"] as const) {
      expect(registryWebsiteText(page(), version)).toBe(htmlToVisibleText(page()));
      expect(registryWebsiteText(page(), version)).not.toBe(registryWebsiteText(page([3, 11, 20]), version));
    }
  });
  it.each([
    ["testimonial text", (s: string) => s.replace("Customer 20 service", "Customer 20 different")],
    ["author", (s: string) => s.replace("Author 20", "Author Other")],
    ["link", (s: string) => s.replace("https://customer.example/20", "https://other.example/20")],
    ["non-style attribute", (s: string) => s.replace('title="customer"', 'title="different"')],
    ["inner style", (s: string) => s.replace('class="credit"', 'class="credit" style="display:none"')],
    ["comment provenance", (s: string) => s.replace("source:20", "source:21")],
    ["card ID", (s: string) => s.replace("post-20 ", "post-21 ")],
    ["container instance", (s: string) => s.replace("testimonials-widget-testimonials123", "testimonials-widget-testimonials124")],
    ["card spacing", (s: string) => s.replace('class="credit"', 'class = "credit"')],
    ["positional separator bytes", (s: string) => s.replace(">\n", ">\n\n")],
    ["outside identity", (s: string) => s.replace("123 Main Street", "124 Main Street")],
    ["other outside prose", (s: string) => s.replace("Company services", "Company ownership")],
  ])("binds %s without dropping content", (_label, mutate) => {
    expect(normal(mutate(page()))).not.toBe(normal(page()));
  });
  it("binds missing or additional unique cards", () => {
    expect(normal(page([20, 3]))).not.toBe(normal(page()));
    expect(normal(page([20, 3, 11, 30]))).not.toBe(normal(page()));
  });
  it("recognizes and binds only the adjacent empty matching-instance controls", () => {
    const control = '<div class="testimonials-widget-testimonials bx-controls testimonials-widget-testimonials123-control"></div>';
    const withControl = (order: number[]) => page(order).replace("<footer>", control + "<footer>");
    expect(normal(withControl([20, 3, 11]))).toBe(normal(withControl([3, 11, 20])));
    expect(normal(withControl([20, 3, 11]))).not.toBe(normal(page()));
    for (const malformed of [control.replace("123-control", "124-control"), control.replace("></div>", ">content</div>"),
      control.replace("></div>", "><span></span></div>"), control + control, control.replace('class="', 'id="unrecognized" class="')]) {
      expect(() => normal(page().replace("<footer>", malformed + "<footer>"))).toThrow("unordered testimonials widget");
    }
    expect(() => normal(page() + control)).toThrow("unordered testimonials widget");
  });
  it.each([
    ["absent widget", () => `<footer>${quote}</footer>`],
    ["second widget", (s: string) => s + widget()],
    ["duplicate card", () => page([20, 20, 11])],
    ["one card", () => page([20])],
    ["all hidden", (s: string) => s.replace('style=""', 'style="display: none;"')],
    ["two visible", (s: string) => s.replace('style="display: none;"', 'style=""')],
    ["style spelling", (s: string) => s.replace('style="display: none;"', 'style="display:none;"')],
    ["extra style", (s: string) => s.replace('style=""', 'style="color:red"')],
    ["outer new attribute", (s: string) => s.replace('post-20 testimonials-widget', 'post-20 testimonials-widget').replace('style=""', 'title="Operator" style=""')],
    ["duplicate attribute", (s: string) => s.replace('style=""', 'style="" style=""')],
    ["foreign direct text", (s: string) => s.replace(widget(), widget().replace(">\n", ">Other operator\n"))],
    ["foreign direct element", (s: string) => s.replace(widget(), widget().replace(">\n", "><p>Other operator</p>\n"))],
    ["direct comment", (s: string) => s.replace(">\n", "><!--other-->\n")],
    ["mismatched tag", (s: string) => s.replace("</blockquote>", "</span>")],
    ["missing closing tag", (s: string) => s.replace("</blockquote>", "")],
    ["missing container closure", (s: string) => s.replace("\n</div><footer>", "\n<footer>")],
    ["self-closing container", (s: string) => s.replace('testimonials-widget-testimonials123">', 'testimonials-widget-testimonials123"/>')],
    ["unsupported inner element", (s: string) => s.replace("<blockquote>", "<section>").replace("</blockquote>", "</section>")],
    ["raw-text element in card", (s: string) => s.replace("<!-- source:20 -->", "<script>business text</script>")],
    ["nested card", (s: string) => s.replace("<!-- source:20 -->", card(30, 1))],
  ])("fails closed for %s", (_label, mutate) => {
    expect(() => normal(mutate(page()))).toThrow("unordered testimonials widget");
  });
  it.each(["script", "style", "template", "textarea", "svg"])("does not treat a widget in %s as a real container", tag => {
    expect(() => normal(`<${tag}>${widget()}</${tag}>`)).toThrow("unordered testimonials widget");
    if (tag !== "textarea") expect(normal(`<${tag}>${widget()}</${tag}>${page()}`)).toBe(normal(page()));
  });
  it("rejects comment-only and nested-template spoofing", () => {
    expect(() => normal(`<!--${widget()}-->`)).toThrow("unordered testimonials widget");
    expect(() => normal(`<template><template></template>${widget()}</template>${page()}`)).toThrow("unordered testimonials widget");
  });
  it("requires a complete outside quote, never inside, duplicate-inside or spanning the widget", () => {
    expect(registryWebsiteQuoteOutsideWidget(page(), quote)).toBe(true);
    const embedded = page().replace("Customer 20 service experience", quote);
    expect(registryWebsiteQuoteOutsideWidget(embedded, quote)).toBe(false);
    expect(registryWebsiteQuoteOutsideWidget(embedded.replace(`<footer>${quote}</footer>`, ""), quote)).toBe(false);
    expect(registryWebsiteQuoteOutsideWidget(page(), "Company services Customer 11 service experience")).toBe(false);
  });
});

describe("existing website publisher gates with opt-in unordered widget", () => {
  it("verifies a reordered page with unchanged raw-source retention and outside identity", async () => {
    const p = parseRegistryWebsiteCorroboration(proof(), row(), now), body = page([3, 20, 11]);
    const result = await verify(body, p as ReturnType<typeof proof>);
    expect(result.website).toMatchObject({ normalization: mode, htmlSha256: sha(body), quoteStart: normal(body).indexOf(quote), normalizedVisibleTextSha256: p.normalizedVisibleTextSha256 });
  });
  it.each(["text", "attribute", "identity", "card loss"])("rejects a live %s change under the original review", async kind => {
    const body = kind === "text" ? page().replace("Author 20", "Different Author") : kind === "attribute" ? page().replace('title="customer"', 'title="different"') : kind === "identity" ? page().replace("123 Main Street", "124 Main Street") : page([20, 3]);
    await expect(verify(body)).rejects.toThrow("changed");
  });
  it("rejects a reviewed page whose identity comes from a testimonial", async () => {
    const body = page().replace("Customer 20 service experience", quote).replace(`<footer>${quote}</footer>`, "");
    await expect(verify(body, proof(body))).rejects.toThrow("wholly outside");
  });
  it("requires distinct fresh review binding and a declared ordinary-address mode", async () => {
    const p = proof();
    await expect(verify(page(), { ...p, reviewer: p.reader })).rejects.toThrow("independent review");
    await expect(verify(page(), { ...p, subject: "Acme LLC" })).rejects.toThrow("bind exact current evidence");
    expect(() => parseRegistryWebsiteCorroboration({ ...p, normalization: undefined }, row(), now)).toThrow("bind exact current evidence");
    expect(() => parseRegistryWebsiteCorroboration({ ...p, mode: "registry_identifier" }, row(), now)).toThrow("ordinary address proof");
    expect(() => parseRegistryWebsiteCorroboration({ ...p, canonicalRedirect: {} }, row(), now)).toThrow("ordinary address proof");
  });
});
