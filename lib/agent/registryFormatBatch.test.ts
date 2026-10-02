import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, sameRegistryLegalName, verifyRegistryIdentity } from "./registryProfiles";
import { registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";
import { registryWebsiteText } from "./registryWebsiteText";

const now = new Date("2026-10-02T17:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const geo = { city: "Ventura", state: "CA", postalCode: "93003", countryCode: "US" as const };
const ci = { ...geo, addressLine1: "1601 Eastman Ave Unit 202", addressLine2: "Attn Legal" };
const ciSite = { ...geo, addressLine1: "1601 Eastman Avenue", addressLine2: "Suite 202" };
const reach = { ...geo, city: "Colorado Springs", state: "CO", postalCode: "80920", addressLine1: "1880 Office Club Pt Ste 263" };
const reachSite = { ...reach, addressLine1: "1880 Office Club Pointe Ste 263" };
const spoke = { ...geo, city: "Rancho Santa Margarita", postalCode: "92688", addressLine1: "22431 Antonio Parkway", addressLine2: "B160-634" };
const spokeSite = { ...spoke, addressLine1: "22431 Antonio Parkway, #B160-634", addressLine2: undefined };
const sameBoth = (a: typeof ciSite, b: typeof ciSite) => { expect(sameRegistryStreet(a, b)).toBe(true); expect(sameRegistryStreet(b, a)).toBe(true); };

describe("comparison-only address formatting", () => {
  it("retains exact fields and fingerprints while classifying a separate legal attention line", () => {
    const before = JSON.stringify(ci), fingerprint = registryStreet(ci);
    sameBoth(ci, ciSite);
    expect(JSON.stringify(ci)).toBe(before); expect(registryStreet(ci)).toBe(fingerprint);
    expect(fingerprint).toContain("attn legal");
  });
  it.each(["Attn Legal Suite 202", "Attn Legal 202", "c/o Legal", "Attn Acme Inc", "Legal", "Attn Legal; Floor 3", "Attn Legal PO Box 4"])("does not discard other routing or civic content: %s", addressLine2 => {
    expect(sameRegistryStreet({ ...ci, addressLine2 }, ciSite)).toBe(false);
  });
  it.each(["Suite 302", "Suite 0202", "", "Floor 202"])("retains missing or conflicting attention-address unit: %s", addressLine2 => {
    expect(sameRegistryStreet(ci, { ...ciSite, addressLine2 })).toBe(false);
  });
  it("accepts only terminal Pt/Pointe before the same labelled whole unit", () => sameBoth({ ...reach, addressLine2: "" }, { ...reachSite, addressLine2: "" }));
  it.each(["1880 Office Club Pointe Ste 1900", "1880 Office Club Pointe", "1880 Office Club Point Ste 263", "1881 Office Club Pointe Ste 263", "1880 Pointe Club Pt Ste 263", "1880 Office Club Pointe Ste 0263", "1880 Office Club Pointe Floor 263"])("retains substantive civic/labelled-unit differences: %s", addressLine1 => {
    expect(sameRegistryStreet(reach, { ...reachSite, addressLine1 })).toBe(false);
  });
  it("retains complete opaque code and literal internal hyphen with a # designator", () => {
    sameBoth(spoke, { ...spokeSite, addressLine2: "" });
    sameBoth(spoke, { ...spoke, addressLine2: "#B160-634" });
    expect(spoke.addressLine2).toBe("B160-634");
  });
  it.each(["#B160634", "#B160 634", "#B160-0634", "#B160-635", "#B161-634", "PMB B160-634", "Suite B160-634", "#B160-634-5", "#B160-634 Floor 3", "#B160"])("does not split, erase or relabel opaque unit %s", addressLine2 => {
    expect(sameRegistryStreet(spoke, { ...spoke, addressLine2 })).toBe(false);
  });
  it("does not treat a terminal unlabelled compound as a structured second-line code", () => {
    expect(sameRegistryStreet({ ...spoke, addressLine1: spoke.addressLine1 + " B160-634", addressLine2: "" }, spokeSite)).toBe(false);
  });
  it.each(["city", "state", "countryCode"] as const)("new comparisons reject changed %s", field => {
    for (const [a, b] of [[ci, ciSite], [reach, reachSite], [spoke, spokeSite]])
      expect(sameRegistryStreet(a, { ...b, [field]: field === "countryCode" ? "CA" : "OTHER" })).toBe(false);
  });
  it("retains the original full context observation and separate conflicting suite", () => {
    const identity = { ...reach, legalName: "Reach The Lost" };
    const profile = item(identity).profile;
    const observed = { ...reachSite, sourceKind: "company_website" as const, sourceId: "retained-observation", sourceUrl: "https://example.com/", capturedAt: "2026-09-29T15:02:29Z" };
    const context = { context: "", aliases: [], addresses: [observed, { ...observed, addressLine1: "1880 Office Club Pt Ste 1900", sourceKind: "netsuite_record" as const, sourceId: "crm" }] };
    const before = JSON.stringify(context), result = verifyRegistryIdentity(profile, { name: identity.legalName }, context, [], now);
    expect(result).not.toBeNull(); expect(result?.sourceIds).toEqual(["retained-observation"]);
    expect(JSON.stringify(context)).toBe(before);
    expect(verifyRegistryIdentity(profile, { name: identity.legalName }, { ...context, addresses: [context.addresses[1]] }, [], now)).toBeNull();
  });
  it("keeps omitted/mismatched route classifications, road types and name punctuation held", () => {
    expect(sameRegistryStreet({ ...geo, addressLine1: "16399 W. Highway 66" }, { ...geo, addressLine1: "16399 W U.S. HWY 66" })).toBe(false);
    expect(sameRegistryStreet({ ...geo, addressLine1: "6200 Patterson DRIVE" }, { ...geo, addressLine1: "6200 Patterson Rd" })).toBe(false);
    expect(sameRegistryLegalName("STEIN'S AIRCRAFT SERVICES, LLC", "Steins Aircraft Services")).toBe(false);
    expect(sameRegistryLegalName("John's Services LLC", "Johns Services LLC")).toBe(false);
  });
});

const regAddress = { legalName: "Acme Express Inc", addressLine1: "6200 Patterson DRIVE", city: "Little Rock", state: "AR", postalCode: "72209", countryCode: "US" as const };
const { legalName: _siteLegalName, ...siteAddressBase } = regAddress;
const siteAddress = { ...siteAddressBase, addressLine1: "6200 Patterson Rd." };
const company = { name: "Acme Express", domain: "example.com" }, context = { context: "", aliases: [], addresses: [] };
const block = "<h4>Acme Express Inc.</h4><p>Physical Address 6200 Patterson Rd. Little Rock AR 72209</p><p>MC# 718911 – DOT# 1863598</p>";
const html = '<h2 class="page-title">Contact Us</h2></div><div class="container"><!-- <h2>Contact Us</h2> -->' + block;
function item(identity = regAddress) {
  const sourceRow = { ...identity, usdot_number: "1863598" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "1863598", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "1863598" }], provenance: { rowSha256: sha(evidence), sourceRow, quote: evidence } } }, now);
}
function proof(body = html, quote = registryWebsiteText(body), normalization?: RegistryWebsiteCorroboration["normalization"]): RegistryWebsiteCorroboration {
  const data = { mode: "registry_identifier" as const, identifier: { kind: "usdot" as const, value: "1863598" }, sourceUrl: "https://example.com/contact/", normalizedVisibleTextSha256: sha(registryWebsiteText(body, normalization)), quote, quoteSha256: sha(quote), subject: "Acme Express Inc", address: siteAddress, ...(normalization ? { normalization } : {}) };
  const evidenceSha256 = registryWebsiteEvidenceHash(item(), data);
  return { ...data, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string) => ({ status: 200, finalUrl: "https://example.com/contact/", contentType: "text/html", body });
beforeEach(() => fetch.mockReset());
describe("structural Contact Us heading in existing exact-USDOT mode", () => {
  it("accepts a separate heading with every identity/address literal and hash preserved", async () => {
    fetch.mockResolvedValueOnce(page(html));
    const row = item(), before = JSON.stringify(row), hash = registryContentHash(row.profile, row.sourceUrl);
    const result = await registryWebsiteVerifier()(row, proof(), company, context, now);
    expect(result.website).toMatchObject({ binding: "exact_usdot_legal_subject", registryAddress: regAddress, websiteAddress: siteAddress, addressRelationship: "separate_observations_not_address_equivalence" });
    expect(JSON.stringify(row)).toBe(before); expect(registryContentHash(row.profile, row.sourceUrl)).toBe(hash);
  });
  it("binds the same structural occurrence when the selected quote starts at the subject", async () => {
    fetch.mockResolvedValueOnce(page(html));
    const quote = registryWebsiteText(block);
    await expect(registryWebsiteVerifier()(item(), proof(html, quote), company, context, now)).resolves.toBeTruthy();
  });
  it.each([
    "Contact Us " + block,
    "<p>Contact Us</p>" + block,
    "<!-- <h2>Contact Us</h2> -->Contact Us " + block,
    "<script><h2>Contact Us</h2></script>Contact Us " + block,
    "<h2>Global Contact Us</h2>" + block,
    "<h2>Contact Us</h2><p>Global</p>" + block,
    html + "<p>Contact Us Acme Express Inc.</p>",
    "<h2>Contact Us</h2><h4>Global Acme Express Inc.</h4>" + block,
  ])("rejects an inline, hidden, unrelated or separately ambiguous occurrence", async body => {
    fetch.mockResolvedValueOnce(page(body));
    await expect(registryWebsiteVerifier()(item(), proof(body), company, context, now)).rejects.toThrow(/ambiguous|subject/);
  });
  it.each([
    html.replace("Contact Us", "Not Contact Us"),
    html.replace("DOT# 1863598", "Other carrier DOT# 1863598"),
    html + "<p>Another carrier DOT# 1863599.</p>",
    html.replace("Acme Express Inc.", "Acme Express Inc. is not our operator"),
    html.replace("Acme Express Inc.", "Acme Express Inc.X"),
  ])("keeps negation, relationship, conflicting-ID and token-boundary guards", async body => {
    fetch.mockResolvedValueOnce(page(body));
    await expect(registryWebsiteVerifier()(item(), proof(body), company, context, now)).rejects.toThrow();
  });
  it("still rejects changed whole-page bytes with the original proof", async () => {
    fetch.mockResolvedValueOnce(page(html + "<p>New visible data</p>"));
    await expect(registryWebsiteVerifier()(item(), proof(), company, context, now)).rejects.toThrow("changed");
  });
  it("uses the proof's existing normalizer for the exact structural position", async () => {
    const body = '<form><div class="gfield gform_validation_container"><label>Email</label><input name="input_3" type="text"></div></form>' + html;
    const normalization = "gravity_forms_honeypot_v2";
    fetch.mockResolvedValueOnce(page(body));
    await expect(registryWebsiteVerifier()(item(), proof(body, registryWebsiteText(body, normalization), normalization), company, context, now)).resolves.toBeTruthy();
  });
});
