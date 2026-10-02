import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { registryWebsiteText } from "./registryWebsiteText";
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteEvidenceHash, parseRegistryWebsiteCorroboration, registryWebsiteVerifier } from "./registryWebsite";

// Portable fictional Acme fixtures; real retained failure validation stays outside the repository.
const version = "everest_forms_honeypot_v3" as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const trap = (label: string) => `<div class="evf-honeypot-container evf-field-hp"><label for="evf-12-field-hp" class="evf-field-label">${label}</label><input type="text" name="everest_forms[hp]" id="evf-12-field-hp" class="input-text"></div>`;
const form = (s: string) => `<form id="evf-form-12" class="everest-form" data-formid="12" data-ajax_submission="0" data-keyboard_friendly_form="0" data-form_state_type="" method="post" enctype="multipart/form-data" action="/contact/">${s}</form>`;
const quote = "Acme Inc 123 Main Street Suite 4 Austin, TX 78701";
const html = (label: string) => `<footer>${quote}</footer>${form(trap(label))}<p>Copyright 2026</p><label>Message for customer service</label>`;
const normal = (s: string) => registryWebsiteText(s, version);
const now = new Date("2026-10-01T12:00:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
function row() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(versioned = true) {
  const { legalName: subject, ...address } = identity;
  const e = { sourceUrl: "https://acme.com/contact/", quote, quoteSha256: sha(quote), subject, address, normalizedVisibleTextSha256: sha(registryWebsiteText(html("Website"), versioned ? version : undefined)), ...(versioned ? { normalization: version } : {}) };
  const evidenceSha256 = registryWebsiteEvidenceHash(row(), e);
  // Fictional unit-test witnesses only; never a business-source review receipt.
  return { ...e, reader: { taskId: "/fixture/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/fixture/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
beforeEach(() => fetch.mockReset());
describe("opt-in Everest v3 complete upstream finite labels with unchanged grammar", () => {
  it("equalizes all six upstream empty trap labels and preserves the complete business text", () => {
    expect(normal(html("Website"))).toBe(normal(html("Message")));
    for (const label of ["Name", "Phone", "Comment", "Message", "Email", "Website"]) expect(normal(html(label))).toBe(normal(html("Message")));
    expect(normal(html("Message"))).toBe(`${quote} Copyright 2026 Message for customer service`);
  });
  it.each([undefined, "gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2", "gravity_forms_honeypot_v3", "everest_forms_honeypot_v1", "everest_forms_honeypot_v2"] as const)("keeps Name, Phone and Email in every older mode %s", v => {
    for (const label of ["Name", "Phone", "Email"]) {
      expect(registryWebsiteText(html(label), v)).toBe(htmlToVisibleText(html(label)));
      expect(registryWebsiteText(html(label), v)).not.toBe(normal(html(label)));
    }
  });
  it.each([
    ["non-Everest form", (s: string) => s.replace('class="everest-form"', 'class="other-form"')],
    ["wrong parent id", (s: string) => s.replace('id="evf-form-12"', 'id="evf-form-13"')],
    ["wrong data form id", (s: string) => s.replace('data-formid="12"', 'data-formid="13"')],
    ["unknown parent attribute", (s: string) => s.replace('method="post"', 'method="post" hidden')],
    ["duplicate parent attribute", (s: string) => s.replace('method="post"', 'method="post" method="post"')],
    ["GET form", (s: string) => s.replace('method="post"', 'method="get"')],
    ["different declared layout", (s: string) => s.replace('data-ajax_submission="0"', 'data-ajax_submission="1"')],
    ["missing trap declaration", (s: string) => s.replace('evf-field-hp', 'evf-field-text')],
    ["real visible class", (s: string) => s.replace('evf-field-hp', 'evf-field-hp visible')],
    ["visible style", (s: string) => s.replace('class="evf-honeypot-container evf-field-hp"', 'class="evf-honeypot-container evf-field-hp" style="display:block"')],
    ["substantive label", (s: string) => s.replace('>Comment<', '>Acme Inc<')],
    ["unknown label", (s: string) => s.replace('>Comment<', '>Fax<')],
    ["label suffix", (s: string) => s.replace('>Comment<', '>Comment address<')],
    ["plural label not observed", (s: string) => s.replace('>Comment<', '>Comments<')],
    ["lowercase label not observed", (s: string) => s.replace('>Comment<', '>comment<')],
    ["changed label target", (s: string) => s.replace('for="evf-12-field-hp"', 'for="evf-13-field-hp"')],
    ["changed input id", (s: string) => s.replace('id="evf-12-field-hp"', 'id="evf-13-field-hp"')],
    ["real input name", (s: string) => s.replace('everest_forms[hp]', 'everest_forms[message]')],
    ["nonempty value", (s: string) => s.replace('class="input-text"', 'class="input-text" value="123 Main Street"')],
    ["unobserved value attribute", (s: string) => s.replace('class="input-text"', 'class="input-text" value=""')],
    ["business attribute", (s: string) => s.replace('class="input-text"', 'class="input-text" aria-label="Acme Inc"')],
    ["duplicate input attribute", (s: string) => s.replace('type="text"', 'type="text" type="text"')],
    ["extra substantive region", (s: string) => s.replace('</label>', '</label><p>New office 124 Main Street</p>')],
    ["malformed field", (s: string) => s.replace('</label>', '')],
    ["nested form", (s: string) => s.replace('<div class=', '<form><div class=')],
    ["duplicated trap", (s: string) => s.replace('</form>', trap("Message") + '</form>')],
    ["unquoted duplicate trap input", (s: string) => s.replace('</form>', '<input name=everest_forms[hp]></form>')],
    ["uppercase duplicate trap name", (s: string) => s.replace('</form>', '<INPUT NAME="everest_forms[hp]"></form>')],
    ["encoded duplicate trap name", (s: string) => s.replace('</form>', '<input name="everest_forms&#91;hp&#93;"></form>')],
  ] as const)("retains malformed or substantive content: %s", (_label, change) => {
    const candidate = change(form(trap("Comment")));
    expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("never deletes ordinary labels, out-of-form traps or fields from another form", () => {
    for (const candidate of [trap("Comment"), '<form><label>Comment</label><input name="message"></form>', '<div hidden>Comment Acme Inc</div>', '<p>Comment</p>']) expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("requires new version-bound witnesses even when other proof fields are retained", () => {
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(false), normalization: version }, row(), now)).toThrow('bind');
    const { normalization: _v, ...downgraded } = proof();
    expect(() => parseRegistryWebsiteCorroboration(downgraded, row(), now)).toThrow('bind');
  });
  it.each(["Name", "Phone", "Comment", "Message", "Email", "Website"])("accepts upstream %s trap only through complete-page verification", async label => {
    const body = html(label), p = proof();
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    const result = await registryWebsiteVerifier()(row(), parseRegistryWebsiteCorroboration(p, row(), now), { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now);
    expect(result.website).toMatchObject({ normalization: version, htmlSha256: sha(body), normalizedVisibleTextSha256: p.normalizedVisibleTextSha256 });
  });
  it.each([
    ["name", (s: string) => s.replace("Acme Inc", "Different Operator LLC")],
    ["address", (s: string) => s.replace("123 Main Street", "124 Main Street")],
    ["unit", (s: string) => s.replace("Suite 4", "Suite 5")],
    ["date", (s: string) => s.replace("2026", "2027")],
    ["substantive prose", (s: string) => s.replace("customer service", "new service business")],
    ["real field label", (s: string) => s.replace("Message for customer service", "Website for customer service")],
    ["additional identity", (s: string) => s + '<div hidden>Different Operator LLC</div>'],
  ] as const)("rejects changed %s outside the exact non-content region", async (_label, change) => {
    const p = proof(), body = change(html("Comment"));
    expect(normal(body)).not.toBe(normal(html("Website")));
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    await expect(registryWebsiteVerifier()(row(), p, { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now)).rejects.toThrow('changed');
  });

  it("requires new witnesses for v2-to-v3 despite an otherwise identical page hash", () => {
    const p = proof(), { reader: _reader, reviewer: _reviewer, ...evidence } = p;
    const prior = { ...evidence, normalization: "everest_forms_honeypot_v2" as const };
    const evidenceSha256 = registryWebsiteEvidenceHash(row(), prior);
    const old = { ...prior, reader: { ...p.reader, evidenceSha256 }, reviewer: { ...p.reviewer, evidenceSha256 } };
    expect(() => parseRegistryWebsiteCorroboration(old, row(), now)).not.toThrow();
    expect(() => parseRegistryWebsiteCorroboration({ ...old, normalization: version }, row(), now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...p, normalization: prior.normalization }, row(), now)).toThrow("bind");
  });
  it("keeps two actual independent roles mandatory", () => {
    const p = proof();
    expect(() => parseRegistryWebsiteCorroboration({ ...p, reviewer: p.reader }, row(), now)).toThrow();
  });
  it("rejects unknown normalization versions instead of silently upgrading", () => {
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(), normalization: "everest_forms_honeypot_v999" }, row(), now)).toThrow("normalization");
  });

  it.each(["Name", "Phone", "Comment", "Message", "Email", "Website"])("does not generalize %s beyond the exact empty hp field", label => {
    for (const candidate of [
      form(trap(label).replace('everest_forms[hp]', 'everest_forms[company]')),
      form(trap(label).replace('class="input-text"', 'class="input-text" value="Acme Inc"')),
      form(trap(label).replace('</label>', '</label><p>124 Main Street</p>')),
      form(trap(label).replace('evf-field-hp', 'evf-field-text')),
      trap(label), '<p>' + label + '</p>',
    ]) expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("retains unsupported casing, translations, suffixes and substantive names", () => {
    for (const label of ["email", "EMAIL", "Comments", "Company", "URL", "Fax", "Correo", "Email address", "Acme Inc", "123 Main Street", "", " "])
      expect(normal(form(trap(label)))).toBe(htmlToVisibleText(form(trap(label))));
  });
});
