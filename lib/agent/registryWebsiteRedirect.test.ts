import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const now = new Date("2026-10-01T04:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const company = { name: "Acme Inc", domain: "acme.com" }, context = { aliases: [], addresses: [], context: "" };
const address = { addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const identity = { legalName: company.name, ...address }, rootHtml = "<p>Acme company website.</p>";
const contactHtml = "<footer>Acme Inc Headquarters 123 Main Street Suite 4 Austin TX 78701</footer>";
const redirect = { requestedUrl: "https://acme.com/", finalUrl: "https://new-acme.com/", normalizedVisibleTextSha256: sha(htmlToVisibleText(rootHtml)) };
const sourceRow = { ...identity, usdot_number: "12345" };
const row = () => parseRegistryFinding({ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123", source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", detail: "Dated original observations.", evidence: JSON.stringify(sourceRow),
  registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", observedAt: now.toISOString(), sourceAsOf: null, identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { sourceRow, quote: JSON.stringify(sourceRow), rowSha256: "a".repeat(64) } } }, now);
function proof(item = row(), overrides: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}) {
  const text = htmlToVisibleText(contactHtml);
  const evidence = { sourceUrl: "https://new-acme.com/contact", quote: text, quoteSha256: sha(text), subject: company.name, normalizedVisibleTextSha256: sha(text), address, canonicalRedirect: redirect, ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
  return { ...evidence, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string, finalUrl: string) => ({ status: 200, contentType: "text/html", body, finalUrl });
beforeEach(() => { fetch.mockReset(); fetch.mockImplementation(async (url: string) => url === redirect.requestedUrl ? page(rootHtml, redirect.finalUrl) : page(contactHtml, url)); });
describe("reviewed canonical-root redirect", () => {
  it("binds both full responses while preserving original company, source, content and address", async () => {
    const item = row(), before = JSON.stringify({ item, company }), hash = registryContentHash(item.profile, item.sourceUrl, item.detail);
    const result = await registryWebsiteVerifier()(item, proof(item), company, context, now);
    expect(result.website?.binding).toBe("exact_legal_name_address");
    expect(result.website?.canonicalRedirectVerification).toEqual({ ...redirect, fetchedAt: now.toISOString(), htmlSha256: sha(rootHtml) });
    expect(result.sourceIds).toEqual([`website:sha256:${sha(htmlToVisibleText(contactHtml))}`, `website:sha256:${redirect.normalizedVisibleTextSha256}`]);
    expect(JSON.stringify({ item, company })).toBe(before);
    expect(registryContentHash(item.profile, item.sourceUrl, item.detail)).toBe(hash);
    expect(fetch.mock.calls.map(c => c[0])).toEqual([redirect.requestedUrl, "https://new-acme.com/contact"]);
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ maxRedirects: 2, maxBytes: 2_000_000, timeoutMs: 8000 });
  });
  it("reuses the same canonical-root response when it itself contains the identity proof", async () => {
    fetch.mockResolvedValue(page(contactHtml, redirect.finalUrl));
    const item = row(), p = proof(item, { sourceUrl: redirect.requestedUrl, canonicalRedirect: { ...redirect, normalizedVisibleTextSha256: sha(htmlToVisibleText(contactHtml)) } });
    const result = await registryWebsiteVerifier()(item, p, company, context, now);
    expect(result.website?.finalUrl).toBe(redirect.finalUrl); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves legacy own-domain behavior without a redirect proof", async () => {
    const item = row(), p = proof(item, { canonicalRedirect: undefined, sourceUrl: "https://acme.com/contact" });
    const result = await registryWebsiteVerifier()(item, p, company, context, now);
    expect(result.website?.canonicalRedirectVerification).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not admit an unreviewed cross-domain redirect", async () => {
    fetch.mockResolvedValue(page(contactHtml, "https://new-acme.com/contact"));
    const item = row();
    await expect(registryWebsiteVerifier()(item, proof(item, { canonicalRedirect: undefined, sourceUrl: "https://acme.com/contact" }), company, context, now)).rejects.toThrow("canonical own-domain");
  });
  it.each(["http://acme.com/", "https://acme.com/path", "https://acme.com/?next=https://new-acme.com", "https://acme.com/#target", "https://user@acme.com/", "https://acme.com:444/", "https://127.0.0.1/", "https://other.com/"])("rejects unsafe or noncanonical request root %s", async requestedUrl => {
    const item = row(); await expect(registryWebsiteVerifier()(item, proof(item, { canonicalRedirect: { ...redirect, requestedUrl } }), company, context, now)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["https://new-acme.com/path", "https://new-acme.com/?redirect=1", "http://new-acme.com/", "https://127.0.0.1/", redirect.requestedUrl])("rejects an invalid observed destination %s", async finalUrl => {
    const item = row(); await expect(registryWebsiteVerifier()(item, proof(item, { canonicalRedirect: { ...redirect, finalUrl } }), company, context, now)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["https://other.com/contact", "https://new-acme.com/contact?next=1", "https://new-acme.com/contact#fragment", "https://user@new-acme.com/contact"])("rejects unbound destination source %s", async sourceUrl => {
    const item = row(); await expect(registryWebsiteVerifier()(item, proof(item, { sourceUrl }), company, context, now)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([page(rootHtml, "https://third.com/"), page(rootHtml + " changed", redirect.finalUrl), { ...page(rootHtml, redirect.finalUrl), status: 403 }, { ...page(rootHtml, redirect.finalUrl), contentType: "application/pdf" }])("rejects changed or unavailable canonical-root response", async changed => {
    fetch.mockResolvedValueOnce(changed); const item = row();
    await expect(registryWebsiteVerifier()(item, proof(item), company, context, now)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains safe-fetch failure and does not retry it from the request cache", async () => {
    fetch.mockRejectedValue(new Error("DNS resolved a private target")); const item = row(), verify = registryWebsiteVerifier();
    for (let i = 0; i < 2; i++) await expect(verify(item, proof(item), company, context, now)).rejects.toThrow("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rechecks content and both independent attestations even after fetch caching", async () => {
    const item = row(), p = proof(item), verify = registryWebsiteVerifier(); await verify(item, p, company, context, now);
    for (const changed of [{ ...item, detail: "Altered final detail" }, { ...item, evidence: item.evidence + " " }, { ...item, sourceUrl: item.sourceUrl + "?different=1" }])
      await expect(verify(changed, p, company, context, now)).rejects.toThrow("bind exact");
    await expect(verify(item, { ...p, reviewer: p.reader }, company, context, now)).rejects.toThrow("independent");
    await expect(verify(item, { ...p, canonicalRedirect: { ...redirect, normalizedVisibleTextSha256: "b".repeat(64) } }, company, context, now)).rejects.toThrow("bind exact");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects unsupported hop assertions and stale attestations", () => {
    const item = row(), p = proof(item);
    expect(() => parseRegistryWebsiteCorroboration({ ...p, canonicalRedirect: { ...redirect, hops: [] } }, item, now)).toThrow("canonical redirect");
    expect(() => parseRegistryWebsiteCorroboration(p, item, new Date("2026-10-10T04:00:00Z"))).toThrow("bind exact");
  });
  it("still rejects wrong legal entity, missing unit and a root page without complete address", async () => {
    const item = row();
    for (const overrides of [{ subject: "Other LLC" }, { address: { ...address, addressLine2: "Suite 5" } }, { quote: htmlToVisibleText(rootHtml), quoteSha256: sha(htmlToVisibleText(rootHtml)) }])
      await expect(registryWebsiteVerifier()(item, proof(item, overrides), company, context, now)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the final contact host and full contact content after validating delegation", async () => {
    const item = row();
    for (const changed of [page(contactHtml, "https://third.com/contact"), page(contactHtml + " changed", "https://new-acme.com/contact")]) {
      fetch.mockResolvedValueOnce(page(rootHtml, redirect.finalUrl)).mockResolvedValueOnce(changed);
      await expect(registryWebsiteVerifier()(item, proof(item), company, context, now)).rejects.toThrow();
    }
  });
  it("counts delegation and proof pages together against the existing three-fetch budget", async () => {
    const item = row(), verify = registryWebsiteVerifier();
    await verify(item, proof(item), company, context, now);
    await verify(item, proof(item, { sourceUrl: "https://new-acme.com/locations" }), company, context, now);
    await expect(verify(item, proof(item, { sourceUrl: "https://new-acme.com/third" }), company, context, now)).rejects.toThrow("three source pages");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("allows only an entire longer ordinary-address page, rejecting clipped and joined passages", async () => {
    const item = row(), longText = htmlToVisibleText(contactHtml) + " Navigation".repeat(220), html = `<div>${longText}</div>`;
    const p = proof(item, { quote: longText, quoteSha256: sha(longText), normalizedVisibleTextSha256: sha(longText) });
    fetch.mockImplementation(async (url: string) => url === redirect.requestedUrl ? page(rootHtml, redirect.finalUrl) : page(html, url));
    expect((await registryWebsiteVerifier()(item, p, company, context, now)).website?.quote).toBe(longText);
    for (const quote of [longText.slice(0, -10), longText.slice(0, 1900) + " ... " + longText.slice(-100)])
      await expect(registryWebsiteVerifier()(item, proof(item, { quote, quoteSha256: sha(quote), normalizedVisibleTextSha256: sha(longText) }), company, context, now)).rejects.toThrow();
  });
  it("keeps the old cap, identifier/DBA caps and the absolute 6000 cap", () => {
    const item = row(), long = "a".repeat(1801);
    for (const overrides of [{ canonicalRedirect: undefined }, { mode: "registry_identifier" as const }, { mode: "registry_dba_address" as const }])
      expect(() => parseRegistryWebsiteCorroboration(proof(item, { quote: long, quoteSha256: sha(long), ...overrides }), item, now)).toThrow();
    const tooLong = "a".repeat(6001);
    expect(() => parseRegistryWebsiteCorroboration(proof(item, { quote: tooLong, quoteSha256: sha(tooLong) }), item, now)).toThrow();
  });
});
