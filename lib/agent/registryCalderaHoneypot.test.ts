import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { registryWebsiteText } from "./registryWebsiteText";
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteEvidenceHash, parseRegistryWebsiteCorroboration, registryWebsiteVerifier } from "./registryWebsite";

// Fictional data and test-only witnesses. Actual saved source replay is separate.
const version = "caldera_forms_honeypot_v1" as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = "CF123456789abcd";
const labels = { Name: "name", Url: "url", "Order Number": "order_number", "Web Site": "web_site" };
const trap = (label: keyof typeof labels) => `<div class="hide" style="display:none; overflow:hidden;height:0;width:0;"><label>${label}</label><input type="text" name="${labels[label]}" value="" autocomplete="off"></div>`;
const form = (field: string) => `<form data-instance="1" class="${id} caldera_forms_form cfajax-trigger" method="POST" enctype="multipart/form-data" id="${id}_1" data-form-id="${id}" aria-label="Contact form" data-target="#caldera_notices_1" data-template="#cfajax_${id}-tmpl" data-cfajax="${id}" data-load-element="_parent" data-load-class="cf_processing" data-post-disable="0" data-action="cf_process_ajax_submit" data-request="https://acme.com/cf-api/${id}" data-custom-callback="slug_post_form_submit" data-hiderows="true">
<input type="hidden" id="_cf_verify_${id}" name="_cf_verify" value="abc1234567" data-nonce-time="1791273619"><input type="hidden" name="_wp_http_referer" value="/contact/"><div id="cf2-${id}_1"></div><input type="hidden" name="_cf_frm_id" value="${id}"><input type="hidden" name="_cf_frm_ct" value="1"><input type="hidden" name="cfajax" value="${id}"><input type="hidden" name="_cf_cr_pst" value="676">
${field}<div id="${id}_1-row-1" class="row first_row"><label>Name *</label><input required name="fld_123" value=""><label>Order Number *</label><p>13 + 6 = *</p></div></form>`;
const quote = "Acme Inc 123 Main Street Suite 4 Austin, TX 78701";
const html = (label: keyof typeof labels) => `<header>${quote}</header>${form(trap(label))}<p>Copyright 2026</p>`;
const normal = (s: string) => registryWebsiteText(s, version);
const now = new Date("2026-10-06T08:30:00.000Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
function row() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}
function proof(versioned = true) {
  const { legalName: subject, ...address } = identity;
  const evidence = { sourceUrl: "https://acme.com/contact/", quote, quoteSha256: sha(quote), subject, address, normalizedVisibleTextSha256: sha(registryWebsiteText(html("Name"), versioned ? version : undefined)), ...(versioned ? { normalization: version } : {}) };
  const evidenceSha256 = registryWebsiteEvidenceHash(row(), evidence);
  return { ...evidence, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
beforeEach(() => fetch.mockReset());
describe("closed opt-in Caldera empty trap", () => {
  it.each(Object.keys(labels) as (keyof typeof labels)[])("removes only the structurally bound %s trap", label => {
    expect(normal(html(label))).toBe(`${quote} Name * Order Number * 13 + 6 = * Copyright 2026`);
  });
  it.each([
    ["wrong framework", (s: string) => s.replace("caldera_forms_form", "ordinary_form")],
    ["GET form", (s: string) => s.replace('method="POST"', 'method="GET"')],
    ["mismatched instance", (s: string) => s.replace('data-instance="1"', 'data-instance="2"')],
    ["mismatched identity", (s: string) => s.replace('data-form-id="' + id, 'data-form-id="CF0000000000000')],
    ["wrong action", (s: string) => s.replace("cf_process_ajax_submit", "customer_update")],
    ["duplicate form attribute", (s: string) => s.replace('method="POST"', 'method="POST" method="POST"')],
    ["boolean form attribute", (s: string) => s.replace('method="POST"', 'method="POST" hidden')],
    ["wrong hidden form ID", (s: string) => s.replace('name="_cf_frm_id" value="' + id, 'name="_cf_frm_id" value="CF0000000000000')],
    ["wrong hidden instance", (s: string) => s.replace('name="_cf_frm_ct" value="1"', 'name="_cf_frm_ct" value="2"')],
    ["wrong cfajax", (s: string) => s.replace('name="cfajax" value="' + id, 'name="cfajax" value="CF0000000000000')],
    ["missing nonce", (s: string) => s.replace('name="_cf_verify"', 'name="other"')],
    ["extra nonce text", (s: string) => s.replace('data-nonce-time="1791273619"', 'data-nonce-time="1791273619" aria-label="Acme Inc"')],
    ["unknown hidden control", (s: string) => s.replace('name="_cf_cr_pst"', 'name="new"')],
    ["unbound placement", (s: string) => s.replace('<div class="hide"', '<p>Visible content</p><div class="hide"')],
    ["ordinary wrapper class", (s: string) => s.replace('class="hide"', 'class="form-group"')],
    ["visible style", (s: string) => s.replace('display:none;', 'display:block;')],
    ["missing zero width", (s: string) => s.replace('width:0;', '')],
    ["extra style override", (s: string) => s.replace('width:0;', 'width:0;display:block;')],
    ["duplicate wrapper class", (s: string) => s.replace('class="hide"', 'class="hide" class="hide"')],
    ["extra wrapper attribute", (s: string) => s.replace('class="hide"', 'class="hide" aria-label="Acme Inc"')],
    ["business-bearing label", (s: string) => s.replace('<label>Name</label>', '<label>Acme Inc Headquarters</label>')],
    ["unknown label", (s: string) => s.replace('<label>Name</label>', '<label>Company</label>')],
    ["lowercase label with absent input name", (s: string) => s.replace('<label>Name</label>', '<label>name</label>').replace('name="name"', '')],
    ["label attributes", (s: string) => s.replace('<label>Name</label>', '<label title="Acme Inc">Name</label>')],
    ["label markup", (s: string) => s.replace('<label>Name</label>', '<label><span>Name</span></label>')],
    ["extra business passage", (s: string) => s.replace('<label>Name</label>', '<label>Name</label><p>Acme Inc new office</p>')],
    ["input name mismatch", (s: string) => s.replace('name="name"', 'name="customer"')],
    ["populated input", (s: string) => s.replace('name="name" value=""', 'name="name" value="Acme Inc"')],
    ["required input", (s: string) => s.replace('name="name"', 'name="name" required')],
    ["input type", (s: string) => s.replace('type="text" name="name"', 'type="email" name="name"')],
    ["autocomplete on", (s: string) => s.replace('autocomplete="off"', 'autocomplete="on"')],
    ["duplicate input attribute", (s: string) => s.replace('name="name"', 'name="name" name="name"')],
    ["duplicate trap name", (s: string) => s.replace('</form>', '<input name="name"></form>')],
    ["encoded duplicate trap name", (s: string) => s.replace('</form>', '<input NAME="n&#97;me"></form>')],
    ["duplicate control", (s: string) => s.replace('</form>', '<input name="_cf_frm_id"></form>')],
    ["duplicated trap", (s: string) => s.replace('</form>', trap("Name") + '</form>')],
    ["changed first row", (s: string) => s.replace('-row-1"', '-row-2"')],
    ["nested form", (s: string) => s.replace('<div class="hide"', '<form><div class="hide"')],
    ["malformed field", (s: string) => s.replace('</label><input type="text"', '<input type="text"')],
  ] as const)("retains the complete page with %s", (_label, change) => {
    const candidate = change(html("Name"));
    expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("does not process outside-form, comment, raw-text or duplicate-ID pseudoforms", () => {
    for (const candidate of [trap("Name"), `<textarea>${form(trap("Name"))}</textarea>`, `<script>${form(trap("Name"))}</script>`, `<!--${form(trap("Name"))}-->`, form(trap("Name")) + form(trap("Url")), `<template><template>${form(trap("Name"))}</template></template>`])
      expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it.each(['<plaintext>', '<PLAINTEXT>', '<plaintext id="legacy">', '<plaintext/>'])("retains form-like plaintext after %s", open => {
    const candidate = open + html("Name");
    expect(normal(candidate)).toBe(htmlToVisibleText(candidate));
  });
  it("keeps every legacy output and evidence version binding unchanged", () => {
    for (const mode of [undefined, "gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2", "gravity_forms_honeypot_v3", "everest_forms_honeypot_v1", "everest_forms_honeypot_v2", "everest_forms_honeypot_v3"] as const)
      expect(registryWebsiteText(html("Name"), mode)).toBe(htmlToVisibleText(html("Name")));
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(false), normalization: version }, row(), now)).toThrow("bind");
    const { normalization: _n, ...removed } = proof();
    expect(() => parseRegistryWebsiteCorroboration(removed, row(), now)).toThrow("bind");
    expect(() => parseRegistryWebsiteCorroboration({ ...proof(), mode: "registry_dba_address" }, row(), now)).toThrow("ordinary");
  });
  it("accepts newly bound whole-page proof and records the actual fetched raw HTML hash", async () => {
    const p = proof(), body = html("Web Site");
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    const result = await registryWebsiteVerifier()(row(), parseRegistryWebsiteCorroboration(p, row(), now), { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now);
    expect(result.website).toMatchObject({ normalization: version, htmlSha256: sha(body), normalizedVisibleTextSha256: p.normalizedVisibleTextSha256 });
  });
  it("direct verifier rejects switching a legacy proof into Caldera without fresh evidence-bound witnesses", async () => {
    const p = { ...proof(false), normalization: version };
    await expect(registryWebsiteVerifier()(row(), p, { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now)).rejects.toThrow("bind");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["business identity", (s: string) => s.replace("Acme Inc", "Other Operator LLC")],
    ["complete street", (s: string) => s.replace("123 Main Street", "124 Main Street")],
    ["suite", (s: string) => s.replace("Suite 4", "Suite 5")],
    ["real form label", (s: string) => s.replace("Name *", "Customer *")],
    ["arithmetic", (s: string) => s.replace("13 + 6", "14 + 6")],
    ["date", (s: string) => s.replace("Copyright 2026", "Copyright 2027")],
    ["additional hidden identity", (s: string) => s + '<div hidden>Other Operator LLC 99 New Street</div>'],
  ] as const)("still rejects changed %s", async (_label, change) => {
    const p = proof(), body = change(html("Url"));
    fetch.mockResolvedValue({ status: 200, finalUrl: p.sourceUrl, contentType: "text/html", body });
    await expect(registryWebsiteVerifier()(row(), p, { name: "Acme Inc", domain: "acme.com" }, { aliases: [], addresses: [], context: "" }, now)).rejects.toThrow("changed");
  });
});
