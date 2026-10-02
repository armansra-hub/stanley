import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { registryWebsiteText, type RegistryWebsiteNormalization } from "./registryWebsiteText";
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteEvidenceHash, parseRegistryWebsiteCorroboration, registryWebsiteVerifier } from "./registryWebsite";

// Self-contained fictional fixtures. The retained NRI source harness is separate;
// these tests need no private evidence files or undeployed baseline modules.
const version = "gravity_forms_honeypot_v3" as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const field = (label: string) => `<div id="field_1_8" class="gfield gfield--type-honeypot gform_validation_container field_sublabel_below gfield--has-description field_description_below field_validation_below gfield_visibility_visible"><label class="gfield_label gform-field-label" for="input_1_8"><span class="gform-field-label__text">${label}</span></label><div class="ginput_container"><input name="input_8" id="input_1_8" type="text" value="" autocomplete="new-password"/></div><div class="gfield_description" id="gfield_description_1_8">This field is for validation purposes and should be left unchanged.</div></div>`;
const form = (body: string) => `<form method="post" id="gform_1" data-formid="1">${body}</form>`;
const quote = "Acme Inc 123 Main Street Suite 4 Austin, TX 78701";
const html = (label: string) => `<footer>${quote}</footer>${form(field(label))}<p>Copyright 2026</p><label>I am a...</label>`;
const normal = (s: string) => registryWebsiteText(s, version);
const now = new Date("2026-10-02T00:28:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" }, context = { aliases: [], addresses: [], context: "" };
function row() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(normalization: RegistryWebsiteNormalization = version) {
  const { legalName: subject, ...address } = identity;
  const evidence = { sourceUrl: "https://acme.com/contact/", quote, quoteSha256: sha(quote), subject, address, normalization, normalizedVisibleTextSha256: sha(registryWebsiteText(html("Website"), normalization)) };
  const evidenceSha256 = registryWebsiteEvidenceHash(row(), evidence);
  return { ...evidence, reader: { taskId: "/fixture/instagram-reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/fixture/instagram-reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
beforeEach(() => fetch.mockReset());

describe("separately opted-in Instagram honeypot label", () => {
  it("equalizes whole pages with only Website/Instagram trap-label drift and preserves the legal/address quote", () => {
    expect(normal(html("Instagram"))).toBe(normal(html("Website")));
    expect(normal(html("Instagram"))).toBe(`${quote} Copyright 2026 I am a...`);
  });
  it.each([undefined, "gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2", "everest_forms_honeypot_v1"] as const)("never upgrades Instagram removal in existing mode %s", normalization => {
    for (const body of [html("Instagram"), form(field("Instagram")), "<p>Instagram is a customer channel</p>"]) expect(registryWebsiteText(body, normalization)).toBe(htmlToVisibleText(body));
  });
  it("retains existing finite Gravity label behavior", () => {
    expect(registryWebsiteText(form(field("Website")), "gravity_forms_honeypot_v1")).toBe("");
    for (const label of ["Facebook", "LinkedIn"]) {
      expect(registryWebsiteText(form(field(label)), "gravity_forms_honeypot_v1")).toBe(htmlToVisibleText(form(field(label))));
      expect(registryWebsiteText(form(field(label)), "gravity_forms_honeypot_v2")).toBe("");
    }
    expect(registryWebsiteText(form(field("Website")), "everest_forms_honeypot_v1")).toBe(htmlToVisibleText(form(field("Website"))));
  });
  it("adds only Instagram to the finite labels and preserves unrecognized labels", () => {
    expect(normal(form(field("Instagram")))).toBe("");
    for (const label of ["TikTok", "YouTube", "Instagram business address", "Acme Inc"]) expect(normal(form(field(label)))).toBe(htmlToVisibleText(form(field(label))));
  });
  it("retains substantive Instagram text and a trap-shaped field outside its declared form", () => {
    const text = "Instagram orders now support our growing business.";
    expect(normal(`<p>${text}</p>${form(field("Instagram") + "<label>Instagram account for customer service</label>")}`)).toBe(`${text} Instagram account for customer service`);
    expect(normal(field("Instagram"))).toBe(htmlToVisibleText(field("Instagram")));
  });
  it.each([
    ["unrelated form", (s: string) => s.replace('id="gform_1"', 'id="customer-form"')],
    ["wrong form linkage", (s: string) => s.replace('data-formid="1"', 'data-formid="2"')],
    ["missing trap declaration", (s: string) => s.replace("gfield--type-honeypot", "gfield--type-text")],
    ["explicit visible style", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" style="display:block"')],
    ["changed description", (s: string) => s.replace("validation purposes", "customer service")],
    ["substantive input value", (s: string) => s.replace('value=""', 'value="123 Main Street"')],
    ["additional business text", (s: string) => s.replace("</label>", "</label><p>New office</p>")],
    ["malformed closing label", (s: string) => s.replace("</label>", "")],
    ["real input purpose", (s: string) => s.replace('autocomplete="new-password"', 'autocomplete="email"')],
    ["duplicate field ID", (s: string) => s.replace('id="field_1_8"', 'id="field_1_8" id="field_1_9"')],
  ] as const)("retains malformed or substantive trap-like field: %s", (_name, change) => {
    const candidate = change(form(field("Instagram")));
    expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("rejects replay of version-bound v2 and v3 witness pairs", () => {
    expect(() => parseRegistryWebsiteCorroboration({ ...proof("gravity_forms_honeypot_v2"), normalization: version }, row(), now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(), normalization: "gravity_forms_honeypot_v2" }, row(), now)).toThrow("bind");
  });
  it("verifies the whole page with an explicitly bound v3 proof and unchanged legal/address identity", async () => {
    const p = proof(), body = html("Instagram");
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    const result = await registryWebsiteVerifier()(row(), parseRegistryWebsiteCorroboration(p, row(), now), company, context, now);
    expect(result.website).toMatchObject({ normalization: version, normalizedVisibleTextSha256: sha(normal(html("Website"))), htmlSha256: sha(body), quoteSha256: sha(quote), binding: "exact_legal_name_address" });
  });
  it.each([
    ["legal name", (s: string) => s.replaceAll("Acme Inc", "Different Operator Inc")],
    ["street", (s: string) => s.replaceAll("123 Main Street", "124 Main Street")],
    ["suite", (s: string) => s.replaceAll("Suite 4", "Suite 5")],
    ["date", (s: string) => s.replaceAll("2026", "2027")],
    ["substantive Instagram mention", (s: string) => s + "<p>Instagram business operations changed</p>"],
    ["ordinary form field", (s: string) => s.replaceAll("I am a...", "My company is...")],
    ["additional identity passage", (s: string) => s + "<p>New registered operator: Different LLC</p>"],
  ] as const)("rejects changed %s outside the exact declared trap", async (_name, change) => {
    const p = proof(), body = change(html("Instagram"));
    expect(body).not.toBe(html("Instagram")); expect(normal(body)).not.toBe(normal(html("Website")));
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    await expect(registryWebsiteVerifier()(row(), p, company, context, now)).rejects.toThrow("changed");
  });
});
