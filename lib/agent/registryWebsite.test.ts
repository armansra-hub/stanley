import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding, registryContentHash, verifyRegistryIdentity } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const now = new Date("2026-09-30T00:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" };
const context = { aliases: [], context: "private notes excluded", addresses: [{ addressLine1: "1 Old Road", state: "TX", postalCode: "78701", sourceKind: "netsuite_record" as const, sourceId: "crm-1", capturedAt: "2026-09-01T00:00:00Z" }] };
function row(address = identity, dataset = "fmcsa", recordId = "12345") {
  const sourceRow = { ...address, usdot_number: recordId }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset, recordId, sourceAsOf: null, observedAt: now.toISOString(), identity: address,
      facts: [{ field: "usdot_number", value: recordId }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(item = row(), html = "<footer>Acme Inc Headquarters 123 Main Street Suite 4 Austin, TX 78701</footer>", overrides = {}) {
  const visible = htmlToVisibleText(html), { legalName, ...address } = item.profile.identity;
  const evidence = { sourceUrl: "https://acme.com/", normalizedVisibleTextSha256: sha(visible), quote: visible, quoteSha256: sha(visible), subject: legalName,
    address: address as RegistryWebsiteCorroboration["address"], ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
  return { ...evidence, reader: { taskId: "/root/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/root/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string, finalUrl = "https://acme.com/") => ({ status: 200, finalUrl, body, contentType: "text/html; charset=utf-8" });
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue(page("<footer>Acme Inc Headquarters 123 Main Street Suite 4 Austin, TX 78701</footer>")); });
describe("independently reviewed registry website corroboration", () => {
  it.each([
    ["123 Main Street", "Floor 2", "Second Floor"],
    ["123 Main Street 2nd Floor", "", "Second Floor"],
    ["123 Main Street Floor 2", "", "Floor 2"],
  ])("accepts new explicit and legacy line-split floor forms through the website gate: %s %s / %s", async (street, sourceFloor, websiteFloor) => {
    const { addressLine2: _suite, ...baseAddress } = identity;
    const item = row({ ...baseAddress, addressLine1: street, ...(sourceFloor ? { addressLine2: sourceFloor } : {}) } as typeof identity);
    const html = `<footer>Acme Inc Headquarters 123 Main Street ${websiteFloor} Austin, TX 78701</footer>`;
    const address = { addressLine1: "123 Main Street", addressLine2: websiteFloor, city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };
    const original = JSON.stringify(item), hash = registryContentHash(item.profile, item.sourceUrl);
    fetch.mockResolvedValueOnce(page(html));
    const result = await registryWebsiteVerifier()(item, proof(item, html, { address }), company, context, now);
    expect(result.website?.binding).toBe("exact_legal_name_address");
    expect(JSON.stringify(item)).toBe(original);
    expect(registryContentHash(item.profile, item.sourceUrl)).toBe(hash);
  });
  it("keeps wrong/missing floors, suites and invalid ordinals held before a website fetch", async () => {
    const item = row({ ...identity, addressLine2: "Floor 2" });
    for (const addressLine2 of ["", "Third Floor", "Suite 2", "2rd Floor", "Second Floor Suite 3"]) {
      const html = `<footer>Acme Inc Headquarters 123 Main Street ${addressLine2} Austin, TX 78701</footer>`;
      const address = { addressLine1: "123 Main Street", addressLine2, city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };
      await expect(registryWebsiteVerifier()(item, proof(item, html, { address }), company, context, now)).rejects.toThrow("street or unit differs");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts closed spelled-out state equivalents only beside the same city and postal code", async () => {
    const item = row(), good = "Acme Inc Headquarters 123 Main Street Suite 4 Austin, Texas 78701";
    fetch.mockResolvedValueOnce(page(good));
    expect((await registryWebsiteVerifier()(item, proof(item, good), company, context, now)).method).toBe("official_website_corroboration");
    const wrong = "Acme Inc Headquarters 123 Main Street Suite 4 Austin, California 78701. Our Texas customers are welcome.";
    await expect(registryWebsiteVerifier()(item, proof(item, wrong), company, context, now)).rejects.toThrow("complete address");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("re-fetches exact own-page proof, retains old addresses, and does not change registry facts or fact hash", async () => {
    const item = row(), original = JSON.stringify(item.profile), hash = registryContentHash(item.profile, item.sourceUrl);
    const review = parseRegistryWebsiteCorroboration(proof(item), item, now);
    const result = await registryWebsiteVerifier()(item, review, company, context, now);
    expect(result).toMatchObject({ method: "official_website_corroboration", website: { binding: "exact_legal_name_address", priorAddresses: context.addresses, quoteStart: 0 } });
    expect(result.website?.quoteEnd).toBe(review.quote.length);
    expect(JSON.stringify(result)).not.toContain("private notes"); expect(JSON.stringify(item.profile)).toBe(original);
    expect(registryContentHash({ ...item.profile, verification: result }, item.sourceUrl)).toBe(hash);
    expect(fetch).toHaveBeenCalledWith("https://acme.com/", expect.objectContaining({ timeoutMs: 8000, maxBytes: 2_000_000, maxRedirects: 2 }));
    const prior = { ...item.profile, verification: result, publication: { contentHash: hash, eventId: "event", publishedAt: now.toISOString() } };
    expect(verifyRegistryIdentity(item.profile, company, context, [prior], now)?.website).toEqual(result.website);
  });
  it("requires two actual distinct, fresh task attestations bound to this exact row and passage", () => {
    const item = row(), good = proof(item);
    expect(() => parseRegistryWebsiteCorroboration({ ...good, reviewer: good.reader }, item, now)).toThrow("independent");
    expect(() => parseRegistryWebsiteCorroboration(good, { ...item, internalId: "456" }, now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...good, quote: good.quote + " invented" }, item, now)).toThrow("invalid");
    expect(() => parseRegistryWebsiteCorroboration({ ...good, verified: true }, item, now)).toThrow("invalid");
    expect(() => parseRegistryWebsiteCorroboration(good, item, new Date("2026-10-10T00:00:00Z"))).toThrow("bind");
  });
  it.each(["https://127.0.0.1/", "http://acme.com/", "https://acme.com.evil.test/", "https://subsidiary.acme.com/", "https://user:pass@acme.com/", "https://acme.com:444/"])("rejects unsafe/noncanonical URL before fetching: %s", async sourceUrl => {
    const item = row(), p = proof(item, undefined, { sourceUrl });
    await expect(registryWebsiteVerifier()(item, p, company, context, now)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an off-domain final redirect and private address DNS/transport rejection with no fallback", async () => {
    const item = row(), p = proof(item);
    fetch.mockResolvedValueOnce(page("anything", "https://unrelated.com/"));
    await expect(registryWebsiteVerifier()(item, p, company, context, now)).rejects.toThrow("own-domain");
    fetch.mockRejectedValueOnce(new Error("DNS private address"));
    await expect(registryWebsiteVerifier()(item, p, company, context, now)).rejects.toThrow("unavailable");
  });
  it("rejects changed pages, script-only quotes and non-HTML/incomplete HTTP responses", async () => {
    const item = row(), p = proof(item);
    for (const response of [page(`<script>${p.quote}</script>`), page(`<p>${p.quote} changed</p>`), { ...page(p.quote), status: 206 }, { ...page(p.quote), contentType: "application/json" }]) {
      fetch.mockResolvedValueOnce(response);
      await expect(registryWebsiteVerifier()(item, p, company, context, now)).rejects.toThrow();
    }
  });
  it("keeps unrelated legal entities, subsidiary addresses, missing/different units and countries held", async () => {
    const item = row();
    for (const [html, changes] of [
      ["Other Acme LLC Headquarters 123 Main Street Suite 4 Austin, TX 78701", { subject: "Other Acme LLC" }],
      ["Acme Inc subsidiary Other LLC Headquarters 123 Main Street Suite 4 Austin, TX 78701", {}],
      ["Acme Inc Headquarters 123 Main Street Suite 5 Austin, TX 78701", { address: { ...identity, legalName: undefined, addressLine2: "Suite 5" } }],
      ["Acme Inc Headquarters 123 Main Street Austin, TX 78701", { address: { ...identity, legalName: undefined, addressLine2: undefined } }],
      ["Acme Inc Headquarters 123 Main Street Suite 4 Austin, TX 78701", { address: { ...identity, legalName: undefined, countryCode: "CA" } }],
    ] as const) {
      await expect(registryWebsiteVerifier()(item, proof(item, html, changes), company, context, now)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the exact USDOT for J&T's narrowly different highway formatting while preserving stale JSON-LD", async () => {
    const jntIdentity = { legalName: "J & T LOGISTICS INC", addressLine1: "27089 HWY 65", city: "HUBBARD", state: "IA", postalCode: "50122", countryCode: "US" as const };
    const item = row(jntIdentity as typeof identity, "fmcsa", "2235302");
    const quote = "J&T LOGISTICS INC In 2023 J&T moved into our new 44,000 square foot facility at 27089 US Hwy 65 in Hubbard. BROKER INFO MC 541623 DOT 2235302 SCAC JTAI 27089 US Hwy 65 PO Box 429 Hubbard, IA 50122";
    const html = `<p>${quote}</p><script type="application/ld+json">{"@type":"LocalBusiness","name":"J&T LOGISTICS INC","url":"https://www.jntlogistics.com/","address":{"streetAddress":"100 N State St","addressLocality":"Hubbard","addressRegion":"IA","postalCode":"50122","addressCountry":"US"}}</script>`;
    fetch.mockResolvedValue(page(html, "https://www.jntlogistics.com/"));
    const p = proof(item, html, { subject: "J&T LOGISTICS INC", sourceUrl: "https://www.jntlogistics.com/", address: { ...jntIdentity, legalName: undefined, addressLine1: "27089 US Hwy 65" } });
    const result = await registryWebsiteVerifier()(item, p, { name: "J&T Logistics", domain: "jntlogistics.com" }, context, now);
    expect(result.website).toMatchObject({ binding: "exact_usdot_highway_format", registryAddress: jntIdentity });
    expect(JSON.stringify(result.website?.structuredIdentity)).toContain("100 N State St");
    await expect(registryWebsiteVerifier()(item, { ...p, quote: quote.replace("DOT 2235302", "DOT 9999999") }, { name: "J&T Logistics", domain: "jntlogistics.com" }, context, now)).rejects.toThrow("street or unit");
  });
  it("shares exact-URL fetches and stops after three distinct pages", async () => {
    const item = row(), verify = registryWebsiteVerifier(), p = proof(item);
    await verify(item, p, company, context, now); await verify(item, p, company, context, now);
    for (const path of ["contact", "locations"]) await verify(item, { ...p, sourceUrl: `https://acme.com/${path}` }, company, context, now);
    await expect(verify(item, { ...p, sourceUrl: "https://acme.com/fourth" }, company, context, now)).rejects.toThrow("three");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
