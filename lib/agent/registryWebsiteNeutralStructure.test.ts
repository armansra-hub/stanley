import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const now = new Date("2026-10-05T00:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const raw = { dot_number: "1234567", dba_name: "BRAND CARGO", legal_name: "ORIGINAL OPERATOR LLC", phy_street: "123 N MAIN ST STE 4", phy_city: "AUSTIN", phy_state: "TX", phy_zip: "78701", phy_country: "US" };
const identity = { legalName: raw.legal_name, addressLine1: raw.phy_street, city: raw.phy_city, state: raw.phy_state, postalCode: raw.phy_zip, countryCode: "US" as const };
const company = { name: "Brand Cargo", domain: "brand.com" }, context = { aliases: [] as string[], addresses: [], context: "" };
const url = "https://brand.com/contact/";
const title = "<title>Contact Brand Cargo | Trucking &amp; Logistics Company</title>";
const weekly = "<p>Previous week: 56%<br />Current week: 54.5%<br />*Updated: 9-28-26</p>";
const nav = '<nav><a href="https://portal.com/login">Customer Login</a></nav>';
const footer = '<footer><p>© 2026 Brand Cargo</p><div class="links"><a href="https://brand.com/privacy-policy/">Privacy Policy</a></div></footer>';
const html = '<html><head>' + title + '</head><body>' + weekly + nav + '<address>123 N Main St Suite 4 Austin TX 78701</address><p>End address.</p>' + footer + '</body></html>';
function row() {
  const sourceRow = { ...identity, usdot_number: raw.dot_number }, original = JSON.stringify(raw);
  const evidence = JSON.stringify(sourceRow) + "\nOriginal public source row: " + original;
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123", sourceUrl: "https://safer.fmcsa.dot.gov/query.asp?query_string=1234567", evidence, detail: "Dated original operator transport facts.", registryProfile: { version: 1, dataset: "fmcsa", recordId: raw.dot_number, sourceAsOf: "2026-09-29", observedAt: now.toISOString(), identity: { ...identity }, facts: [{ field: "usdot_number", value: raw.dot_number }], provenance: { sourceRow, quote: evidence, rowSha256: sha(original) } } }, now);
}
function proof(r = row(), body = html, override: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}) {
  const text = htmlToVisibleText(body), quote = text.slice(0, text.indexOf("End address.") + "End address.".length);
  const base: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer"> = { mode: "registry_dba_address", sourceUrl: url, subject: "Brand Cargo", quote, quoteSha256: sha(quote), normalizedVisibleTextSha256: sha(text), address: { addressLine1: "123 N Main St", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" }, ...override };
  const evidenceSha256 = registryWebsiteEvidenceHash(r, base);
  return { ...base, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
function verify(body = html, override: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}) {
  fetch.mockResolvedValue({ body, finalUrl: url, status: 200, contentType: "text/html" });
  const r = row();
  return registryWebsiteVerifier()(r, proof(r, body, override), company, context, now);
}
beforeEach(() => fetch.mockReset());

describe("exact HTML-derived neutral DBA structure", () => {
  it("accepts closed neutral structures without removing text or changing original identity", async () => {
    const v = await verify();
    expect(v.website?.binding).toBe("exact_original_registry_dba_full_address");
    expect(v.website?.normalizedVisibleTextSha256).toBe(sha(htmlToVisibleText(html)));
    expect(v.website?.registryAddress).toEqual(identity);
    expect(v.website?.originalDba).toBe(raw.dba_name);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("allows optional www on the same privacy host", async () => {
    await expect(verify(html.replace("https://brand.com/privacy-policy/", "https://www.brand.com/privacy-policy/"))).resolves.toBeDefined();
  });
  it.each(["Brand Cargo LLC", "Brand Cargo West", "Not Brand Cargo", "Brand Cargo operated by Other LLC"])("rejects title subject alteration: %s", async value => {
    await expect(verify(html.replace(title, title.replace("Brand Cargo", value)))).rejects.toThrow();
  });
  it("rejects title-like body prose instead of a real title", async () => {
    await expect(verify(html.replace(title, "").replace("<body>", "<body><p>Contact Brand Cargo | Trucking &amp; Logistics Company</p>"))).rejects.toThrow();
  });
  it.each(["Other Operator LLC", "Trucking &amp; Logistics Company operated by Other LLC"])("rejects arbitrary title descriptor: %s", async value => {
    await expect(verify(html.replace("Trucking &amp; Logistics Company", value))).rejects.toThrow();
  });
  it.each(["other.com", "privacy.brand.com", "brand.com.other.com", "x@brand.com", "brand.com:444"])("rejects unsafe or nonexact privacy host: %s", async host => {
    await expect(verify(html.replace("https://brand.com/privacy-policy/", `https://${host}/privacy-policy/`))).rejects.toThrow();
  });
  it.each(["© 2026 Brand Cargo LLC", "© 2026 Brand Cargo operated by Other LLC", "© 2026 Customer Brand Cargo"])("rejects nonneutral footer: %s", async value => {
    await expect(verify(html.replace("© 2026 Brand Cargo", value))).rejects.toThrow();
  });
  it("does not hide other customer or previous-address prose", async () => {
    for (const prose of ["Customer Brand Cargo", "Brand Cargo Previous address: 123 N Main St Suite 4 Austin TX 78701"])
      await expect(verify(html.replace("<address>", `<p>${prose}</p><address>`))).rejects.toThrow();
  });
  it("rejects customer/company prose inside the login anchor", async () => {
    await expect(verify(html.replace("Customer Login</a>", "Customer Login for Brand Cargo</a>"))).rejects.toThrow();
  });
  it("requires actual nav structure for Customer Login", async () => {
    await expect(verify(html.replace("<nav>", "<section>").replace("</nav>", "</section>"))).rejects.toThrow();
  });
  it("rejects extra prose and invalid dates in the weekly widget", async () => {
    for (const altered of [weekly.replace("56%", "56% previous owner"), weekly.replace("9-28-26", "2-30-26")])
      await expect(verify(html.replace(weekly, altered))).rejects.toThrow();
  });
  it("preserves an operator contradiction outside the clipped quote", async () => {
    await expect(verify(html.replace("</footer>", "<p>Brand Cargo is operated by Other LLC</p></footer>"))).rejects.toThrow();
  });
  it("does not normalize away the original unit", async () => {
    const address = { ...proof().address!, addressLine2: "Suite 5" };
    await expect(verify(html.replace("Suite 4", "Suite 5"), { address })).rejects.toThrow();
  });
  it("still rejects changed full-page bytes against the reviewed text hash", async () => {
    const r = row(), p = proof(r);
    fetch.mockResolvedValue({ body: html + "<p>changed</p>", finalUrl: url, status: 200, contentType: "text/html" });
    await expect(registryWebsiteVerifier()(r, p, company, context, now)).rejects.toThrow("changed");
  });
});
