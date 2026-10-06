import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { registryWebsiteText } from "./registryWebsiteText";
import { registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

// Synthetic test-only companies and actors. No factual/source/final approval.
const now = new Date("2026-10-06T12:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const identity = { legalName: "Northridge Design Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: identity.legalName, domain: "northridge.example.com" };
const context = { aliases: [], addresses: [], context: "" };
const block = (label = "Find Us", state = "TX") => `<div class="location"><div>${label}</div><div>Austin, ${state}</div><div><i></i><p>123 Main Street, Suite 4, 78701</p></div></div>`;
const page = (body = block()) => `<html><head><title>Contact</title></head><body><footer>${body}<p>© Northridge Design Inc. 2026</p></footer></body></html>`;
function item(changes = {}) {
  const address = { ...identity, ...changes }, sourceRow = { ...address, registration_number: "20000000001" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceUrl: "https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=20000000001", evidence,
    registryProfile: { version: 1, dataset: "co_sos", recordId: "20000000001", sourceAsOf: "2026-10-01", observedAt: "2026-10-01T00:00:00Z", identity: address, facts: [{ field: "registration_number", value: "20000000001" }], provenance: { rowSha256: sha(evidence), quote: evidence, sourceRow } } }, now);
}
function proof(row = item(), html = page(), overrides = {}) {
  const text = registryWebsiteText(html), { legalName, ...address } = row.profile.identity;
  const bare = { sourceUrl: "https://northridge.example.com/", normalizedVisibleTextSha256: sha(text), quote: text, quoteSha256: sha(text), subject: legalName, address: address as RegistryWebsiteCorroboration["address"], ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(row, bare);
  return { ...bare, reader: { taskId: "/test-only/heading-first/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test-only/heading-first/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const response = (html: string) => ({ status: 200, finalUrl: "https://northridge.example.com/", contentType: "text/html", body: html });
beforeEach(() => fetch.mockReset());
describe("ordinary US heading-first address block", () => {
  it.each(["Find Us", "Our Office", "Office Address", "Headquarters"])("accepts only a complete labelled container: %s", async (label: string) => {
    const html = page(block(label)), row = item(), original = JSON.stringify(row), hash = registryContentHash(row.profile, row.sourceUrl);
    fetch.mockResolvedValueOnce(response(html));
    const result = await registryWebsiteVerifier()(row, proof(row, html), company, context, now);
    expect(result.website?.binding).toBe("exact_legal_name_address");
    expect(result.website?.addressLayout).toMatchObject({ schema: "city_state_heading_before_street_postal_v1" });
    expect(result.website?.quoteStart).toBe(0);
    expect(JSON.stringify(row)).toBe(original); expect(registryContentHash(row.profile, row.sourceUrl)).toBe(hash);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts a full state name without altering source text or source address", async () => {
    const html = page(block("Find Us", "Texas")); fetch.mockResolvedValueOnce(response(html));
    expect((await registryWebsiteVerifier()(item(), proof(item(), html), company, context, now)).website?.registryAddress).toEqual(identity);
  });
  it.each([
    page('<section><div>Find Us</div><div>Austin, TX</div></section><section><p>123 Main Street, Suite 4, 78701</p></section>'),
    page('<div><section>Find Us Austin TX</section><section>123 Main Street Suite 4 78701</section></div>'),
    page('<div><div>Find Us</div><div>Austin TX</div><div>123 Main Street Suite 4</div><div>78701</div></div>'),
    page('<div>Find Us Austin TX 123 Main Street Suite 4 78701</div>'),
    page(block().replace('Suite 4, 78701', 'Suite 4</p><p>78701')),
    page(block().replace('<div>Austin, TX</div>', '<div>Austin, TX</div><p>Other Office</p>')),
  ])("rejects cross-container, incomplete or non-heading layouts", async (html: string) => {
    fetch.mockResolvedValueOnce(response(html));
    await expect(registryWebsiteVerifier()(item(), proof(item(), html), company, context, now)).rejects.toThrow();
  });
  it.each([
    ["street", { addressLine1: "124 Main Street" }], ["unit", { addressLine2: "Suite 5" }],
    ["missing unit", { addressLine2: "" }], ["city", { city: "Dallas" }], ["state", { state: "CA" }],
    ["ZIP", { postalCode: "78702" }], ["country", { countryCode: "CA" }],
  ])("preserves exact %s source comparison", async (_label: string, change: Record<string, string>) => {
    const special = _label === "missing unit" || _label === "country";
    const row = special ? item() : item(change); fetch.mockResolvedValueOnce(response(page()));
    await expect(registryWebsiteVerifier()(row, proof(row, page(), { address: { ...identity, legalName: undefined, ...(special ? change : {}) } }), company, context, now)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["hidden", "hidden=hidden", "style=\"display:none\"", "aria-hidden=\"true\"", "inert", "onclick=\"anything()\""])("rejects hidden/active container attribute %s", async (attribute: string) => {
    const html = page(block().replace('class="location"', attribute)); fetch.mockResolvedValueOnce(response(html));
    await expect(registryWebsiteVerifier()(item(), proof(item(), html), company, context, now)).rejects.toThrow();
  });
  it.each(["template", "svg", "math", "select", "textarea", "script", "noscript"])("rejects inert/active wrapper %s", async (tag: string) => {
    const html = page(`<${tag}>${block()}</${tag}>`); fetch.mockResolvedValueOnce(response(html));
    await expect(registryWebsiteVerifier()(item(), proof(item(), html), company, context, now)).rejects.toThrow();
  });
  it("rejects hidden ancestors and malformed close tags", async () => {
    for (const html of [page(`<section hidden>${block()}</section>`), page(block().replace('</p>', '</span>'))]) {
      fetch.mockResolvedValueOnce(response(html));
      await expect(registryWebsiteVerifier()(item(), proof(item(), html), company, context, now)).rejects.toThrow();
    }
  });
  it.each(["Not our office", "Former address", "Registered agent", "Customer address", "Unrelated company", "Parent company"])("rejects contrary surrounding attribution even when omitted from selected quote: %s", async (contrary: string) => {
    const html = page(`<p>${contrary}</p>${block()}`), full = registryWebsiteText(html), quote = full.slice(full.indexOf('Find Us'));
    fetch.mockResolvedValueOnce(response(html));
    await expect(registryWebsiteVerifier()(item(), proof(item(), html, { quote, quoteSha256: sha(quote) }), company, context, now)).rejects.toThrow();
  });
  it("requires the whole exact source legal subject and canonical domain", async () => {
    for (const changed of [{ subject: "Northridge Design LLC" }, { sourceUrl: "https://unrelated.example.com/" }]) {
      await expect(registryWebsiteVerifier()(item(), proof(item(), page(), changed), company, context, now)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("revalidates distinct actual-proof shape and stale/hash-bound final attestations", async () => {
    const valid = proof();
    for (const invalid of [{ ...valid, reader: undefined, reviewer: undefined }, { ...valid, reviewer: valid.reader }, { ...valid, reader: { ...valid.reader, evidenceSha256: 'a'.repeat(64) } }, { ...valid, reviewer: { ...valid.reviewer, reviewedAt: '2026-09-01T00:00:00Z' } }]) {
      await expect(registryWebsiteVerifier()(item(), invalid as RegistryWebsiteCorroboration, company, context, now)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains full-page hash, quoted range, unique block and off-domain response gates", async () => {
    for (const html of [page() + ' changed']) {
      fetch.mockResolvedValueOnce(response(html));
      await expect(registryWebsiteVerifier()(item(), proof(), company, context, now)).rejects.toThrow();
    }
    const duplicate = page(block() + block()); fetch.mockResolvedValueOnce(response(duplicate));
    await expect(registryWebsiteVerifier()(item(), proof(item(), duplicate), company, context, now)).rejects.toThrow();
    fetch.mockResolvedValueOnce({ ...response(page()), finalUrl: 'https://other.example.com/' });
    await expect(registryWebsiteVerifier()(item(), proof(), company, context, now)).rejects.toThrow();
  });
});
