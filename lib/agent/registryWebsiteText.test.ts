import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { registryWebsiteText } from "./registryWebsiteText";
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteEvidenceHash, parseRegistryWebsiteCorroboration, registryWebsiteVerifier } from "./registryWebsite";

const version = "gravity_forms_honeypot_v1" as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const trap = (label: string) => `<div id="field_1_8" class="gfield gfield--type-honeypot gform_validation_container field_sublabel_below gfield--has-description field_description_below field_validation_below gfield_visibility_visible"><label class="gfield_label gform-field-label" for="input_1_8"><span class="gform-field-label__text">${label}</span></label><div class="ginput_container"><input name="input_8" id="input_1_8" type="text" value="" autocomplete="new-password"/></div><div class="gfield_description" id="gfield_description_1_8">This field is for validation purposes and should be left unchanged.</div></div>`;
const form = (field: string) => `<form method="post" id="gform_1" data-formid="1">${field}<label>Phone number for service</label></form>`;
const quote = "Acme Inc Headquarters 123 Main Street Suite 4 Austin, TX 78701";
const html = (label: string) => `<footer>${quote}</footer>${form(trap(label))}`;
const normal = (s: string) => registryWebsiteText(s, version);
const now = new Date("2026-10-01T01:00:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
function row() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity,
      facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(versioned = true) {
  const item = row(), { legalName: subject, ...address } = identity;
  const evidence = { sourceUrl: "https://acme.com/", quote, quoteSha256: sha(quote), subject, address,
    normalizedVisibleTextSha256: sha(registryWebsiteText(html("Phone"), versioned ? version : undefined)),
    ...(versioned ? { normalization: version } : {}) };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
  return { ...evidence, reader: { taskId: "/root/reader", reviewedAt: now.toISOString(), evidenceSha256 },
    reviewer: { taskId: "/root/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
beforeEach(() => fetch.mockReset());

describe("explicit versioned Gravity Forms anti-spam normalization", () => {
  it("keeps legacy text and evidence hashes unchanged by default", () => {
    expect(registryWebsiteText(html("Phone"))).toBe(htmlToVisibleText(html("Phone")));
    expect(registryWebsiteText(html("Phone"))).not.toBe(registryWebsiteText(html("URL")));
    expect(proof(false).reader.evidenceSha256).not.toBe(proof().reader.evidenceSha256);
  });
  it.each(["Phone", "URL", "Company", "Email", "Name", "Website", "Comments", "Fax"])("omits only the complete declared empty trap: %s", label => {
    expect(normal(html(label))).toBe(`${quote} Phone number for service`);
  });
  it.each([
    ["missing explicit trap type", (s: string) => s.replace("gfield--type-honeypot", "gfield--type-text")],
    ["missing validation container", (s: string) => s.replace("gform_validation_container", "other")],
    ["new visible class", (s: string) => s.replace("gfield_visibility_visible", "show")],
    ["explicit visible style", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" style="display:block"')],
    ["changed description", (s: string) => s.replace("validation purposes", "customer contact")],
    ["meaningful label", (s: string) => s.replace(">Phone<", ">Acme Inc 123 Main Street<")],
    ["extra business text", (s: string) => s.replace("</label>", "</label><span>New office 99 Main Street</span>")],
    ["input business value", (s: string) => s.replace('value=""', 'value="Acme Inc"')],
    ["extra business attribute", (s: string) => s.replace('value=""', 'value="" aria-label="Acme Inc"')],
    ["wrong input relationship", (s: string) => s.replace('name="input_8"', 'name="input_9"')],
    ["wrong description relationship", (s: string) => s.replace("gfield_description_1_8", "gfield_description_2_8")],
    ["duplicate attribute", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" id="field_2_8"')],
    ["unquoted extra boolean", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" inert')],
    ["malformed closure", (s: string) => s.replace("</span></label>", "</label>")],
  ])("retains the entire candidate with %s", (_label, change) => {
    const candidate = form(change(trap("Phone")));
    expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("retains ordinary hidden content, ordinary forms, and fields outside their exact form", () => {
    for (const candidate of [trap("Phone"), form(trap("Phone")).replace('data-formid="1"', 'data-formid="2"'),
      form(trap("Phone")).replace('data-formid="1"', 'data-formid="2" data-formid="1"'),
      '<div hidden>Acme Inc 99 Main Street</div><label>Phone</label>', '<form><label>Company</label><p>Acme Inc</p></form>']) {
      expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
    }
  });
  it("does not process markup-like text inside ignored scripts/comments", () => {
    const candidate = `<script>${form(trap("URL"))}</script><!--${form(trap("Company"))}-->${html("Phone")}`;
    expect(normal(candidate)).toBe(normal(html("Phone")));
  });
  it("rejects unknown versions and changing/removing the version without new attestations", () => {
    const item = row(), p = proof();
    expect(() => parseRegistryWebsiteCorroboration({ ...p, normalization: "anything" }, item, now)).toThrow("normalization");
    const { normalization: _version, ...withoutVersion } = p;
    expect(() => parseRegistryWebsiteCorroboration(withoutVersion, item, now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(false), normalization: version }, item, now)).toThrow("bind");
  });
  it("accepts reviewed versioned text across trap changes and retains raw live HTML hash", async () => {
    const item = row(), p = parseRegistryWebsiteCorroboration(proof(), item, now), body = html("Company");
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    const result = await registryWebsiteVerifier()(item, p, { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now);
    expect(result.website).toMatchObject({ normalization: version, htmlSha256: sha(body), normalizedVisibleTextSha256: p.normalizedVisibleTextSha256 });
  });
  it.each(["identity", "ordinary form", "additional hidden identity"])("still rejects live %s changes under the reviewed version", async change => {
    const body = change === "identity" ? html("URL").replace("123 Main Street", "124 Main Street")
      : change === "ordinary form" ? html("URL").replace("Phone number for service", "Phone number for billing")
        : html("URL") + '<div hidden>Different Operator LLC 99 Side Street</div>';
    fetch.mockResolvedValue({ status: 200, finalUrl: "https://acme.com/", contentType: "text/html", body });
    await expect(registryWebsiteVerifier()(row(), proof(), { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now)).rejects.toThrow("changed");
  });
  it("does not silently upgrade legacy proofs when a trap label changes", async () => {
    fetch.mockResolvedValue({ status: 200, finalUrl: "https://acme.com/", contentType: "text/html", body: html("URL") });
    await expect(registryWebsiteVerifier()(row(), proof(false), { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now)).rejects.toThrow("changed");
  });
});

describe("opt-in v2 declared social-label and above-description variants", () => {
  const version2 = "gravity_forms_honeypot_v2" as const;
  const v2 = (s: string) => registryWebsiteText(s, version2);
  const above = (label: string) => trap(label)
    .replaceAll("field_sublabel_below", "field_sublabel_above")
    .replaceAll("field_description_below", "field_description_above")
    .replace(/(<div class="ginput_container">.*?<\/div>)(<div class="gfield_description".*?<\/div>)/, "$2$1");
  const page = (field: string) => `<footer>${quote}</footer>${form(field)}`;
  it.each(["Facebook", "LinkedIn", "Comments"])("recognizes only closed layouts for %s", label => {
    for (const field of [trap(label), above(label)]) expect(v2(page(field))).toBe(`${quote} Phone number for service`);
  });
  it("leaves legacy and v1 outputs unchanged for new labels and layout", () => {
    for (const field of [trap("Facebook"), trap("LinkedIn"), above("Comments"), above("LinkedIn")]) {
      expect(normal(page(field))).toBe(htmlToVisibleText(page(field)));
      expect(registryWebsiteText(page(field))).toBe(htmlToVisibleText(page(field)));
      expect(v2(page(field))).not.toBe(normal(page(field)));
    }
  });
  it.each([
    ["business-bearing label", (s: string) => s.replace(">LinkedIn<", ">Acme Inc Headquarters<")],
    ["unrecognized social label", (s: string) => s.replace(">LinkedIn<", ">Instagram<")],
    ["missing trap marker", (s: string) => s.replace("gfield--type-honeypot", "gfield--type-text")],
    ["missing validation marker", (s: string) => s.replace("gform_validation_container", "ordinary")],
    ["visible override", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" style="display:block"')],
    ["nonempty input", (s: string) => s.replace('value=""', 'value="123 Main Street"')],
    ["meaningful description", (s: string) => s.replace("This field is for validation purposes and should be left unchanged.", "Acme Inc 123 Main Street")],
    ["extra identity passage", (s: string) => s.replace("</label>", "</label><p>Acme Inc 123 Main Street</p>")],
    ["wrong field relationship", (s: string) => s.replace('name="input_8"', 'name="input_9"')],
  ])("retains both layouts with %s", (_label, change) => {
    for (const field of [trap("LinkedIn"), above("LinkedIn")]) {
      const candidate = page(change(field));
      expect(v2(candidate)).toBe(htmlToVisibleText(candidate));
    }
  });
  it.each([
    ["missing above declaration", (s: string) => s.replace("field_description_above", "")],
    ["contradictory placement", (s: string) => s.replace("field_description_above", "field_description_above field_description_below")],
    ["below classes on above layout", (s: string) => s.replaceAll("_above", "_below")],
  ])("retains above-description field with %s", (_label, change) => {
    const candidate = page(change(above("LinkedIn")));
    expect(v2(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("keeps ordinary social fields, hidden identity and visible changes", () => {
    const candidate = page(above("LinkedIn"));
    for (const changed of [candidate.replace("123 Main Street", "124 Main Street"),
      candidate.replace("Phone number for service", "Phone number for billing"),
      candidate + '<div hidden>Different Operator LLC 99 New Street</div>',
      candidate + '<label>Facebook</label><input value="Acme Inc"/>']) expect(v2(changed)).not.toBe(v2(candidate));
  });
  it("requires newly bound v2 witnesses even when v1 and v2 text happen to agree", () => {
    const p = proof();
    expect(() => parseRegistryWebsiteCorroboration({ ...p, normalization: version2 }, row(), now)).toThrow("bind");
  });
  it("verifies independently bound v2 while retaining raw HTML hashes", async () => {
    const item = row(), { reader: _r, reviewer: _v, ...old } = proof();
    const body = page(above("LinkedIn"));
    const evidence = { ...old, normalization: version2, normalizedVisibleTextSha256: sha(v2(body)) };
    const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
    const p = { ...evidence, reader: { ...proof().reader, evidenceSha256 }, reviewer: { ...proof().reviewer, evidenceSha256 } };
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    const result = await registryWebsiteVerifier()(item, parseRegistryWebsiteCorroboration(p, item, now),
      { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now);
    expect(result.website).toMatchObject({ normalization: version2, htmlSha256: sha(body), normalizedVisibleTextSha256: evidence.normalizedVisibleTextSha256 });
    const { normalization: _n, ...downgraded } = p;
    expect(() => parseRegistryWebsiteCorroboration(downgraded, item, now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...p, normalization: version }, item, now)).toThrow("bind");
  });
});
