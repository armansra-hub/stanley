import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const now = new Date("2026-09-30T00:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", city: "Los Angeles", state: "CA", postalCode: "90001", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" };
const context = { aliases: [], addresses: [{ ...identity, sourceKind: "netsuite_record" as const, sourceId: "fixture-netsuite-address", capturedAt: "2026-09-01" }], context: "private notes excluded" };
const source = "Contact Acme Inc. Licensed Contractor California License #644768. Licenses: CA-644768 AZ-295553 NV-0080972.";
function row(status = "CLEAR", sourceIdentity = identity) {
  const sourceRow = { ...sourceIdentity, license_number: "644768", license_status: status }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123", source: "registry", kind: "ops_profile",
    sourceUrl: "https://web.cslb.ca.gov/Onlineservices/DataPortal/ContractorList", evidence, detail: "Recorded license status is not business size or budget.",
    registryProfile: { version: 1, dataset: "ca_contractors", recordId: "644768", sourceAsOf: "2026-09-29", observedAt: now.toISOString(), identity: { ...sourceIdentity },
      facts: [{ field: "license_number", value: "644768" }, { field: "license_status", value: status }], provenance: { rowSha256: sha("retained original CSV row"), quote: evidence, sourceRow } } }, now);
}
function proof(item = row(), html = source, overrides: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}): RegistryWebsiteCorroboration {
  const visible = htmlToVisibleText(html);
  const evidence: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer"> = { mode: "registry_identifier", identifier: { kind: "cslb_license", value: "644768" },
    sourceUrl: "https://acme.com/", normalizedVisibleTextSha256: sha(visible), quote: visible, quoteSha256: sha(visible), subject: "Acme Inc", ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
  return { ...evidence, reader: { taskId: "/test/cslb-reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/cslb-reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string) => ({ status: 200, finalUrl: "https://acme.com/", contentType: "text/html", body });
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue(page(source)); });

describe("California CSLB identity with an explicitly unknown website address", () => {
  it("retains registry and canonical addresses without inventing a website address or changing facts", async () => {
    const item = row(), before = JSON.stringify(item.profile), hash = registryContentHash(item.profile, item.sourceUrl, item.detail);
    const result = await registryWebsiteVerifier()(item, proof(item), company, context, now);
    expect(result.website).toMatchObject({ binding: "exact_cslb_license_legal_subject", registryAddress: identity, websiteAddress: null,
      addressRelationship: "website_address_unknown_registry_address_retained", priorAddresses: context.addresses });
    expect(JSON.stringify(item.profile)).toBe(before);
    expect(registryContentHash({ ...item.profile, verification: result }, item.sourceUrl, item.detail)).toBe(hash);
    expect(JSON.stringify(result)).not.toContain("private notes");
  });
  it.each(["California License #644768", "California Contractor's License No. 644768", "CSLB #644768", "CSLB License Number 644768", "Licenses: CA-644768"])("accepts only an explicit California authority label: %s", async label => {
    const html = `Acme Inc. ${label}.`; fetch.mockResolvedValueOnce(page(html));
    expect((await registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).website?.binding).toBe("exact_cslb_license_legal_subject");
  });
  it.each(["License #644768", "Contractor #644768", "ROC 644768", "Arizona License #644768", "EIN #644768", "CSLB #0644768", "CSLB #6447680", "CSLB #644768X", "CSLB #644768-2", "CSLB #644768/2", "CSLB #644768.2"])("rejects an unlabeled, wrong-authority or borrowed number: %s", async label => {
    await expect(registryWebsiteVerifier()(row(), proof(row(), `Acme Inc. ${label}.`), company, context, now)).rejects.toThrow(/identifier/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects wrong dataset, authority, country, record, source scalar or duplicated/conflicting facts", () => {
    const changes: Array<(item: ReturnType<typeof row>) => void> = [
      item => { item.profile.dataset = "wa_contractors"; },
      item => { item.sourceUrl = "https://data.wa.gov/license.csv"; },
      item => { item.profile.identity.countryCode = "CA"; },
      item => { item.profile.recordId = "644769"; },
      item => { item.profile.provenance.sourceRow.license_number = "644769"; },
      item => { item.profile.facts = item.profile.facts.filter(f => f.field !== "license_number"); },
      item => { item.profile.facts.push({ field: "license_number", label: "License number", value: "644768" }); },
      item => { item.profile.facts.push({ field: "license_number", label: "License number", value: "644769" }); },
    ];
    for (const change of changes) { const item = row(); change(item); expect(() => parseRegistryWebsiteCorroboration(proof(item), item, now)).toThrow(/source|authority/); }
  });
  it("keeps California licensing separate from a physical address in another US state", async () => {
    const item = row("CLEAR", { ...identity, state: "NV" });
    expect((await registryWebsiteVerifier()(item, proof(item), company, context, now)).website?.binding).toBe("exact_cslb_license_legal_subject");
  });
  it.each([" CSLB #999999.", " Licenses: CA-999999 AZ-644768.", " CSLB #0644768.", " CSLB #644768-X.", " Acme LLC.", " Our customer's CSLB #644768.", " Our old California License #644768.", " Old Licenses: CA-644768.", " We do not hold CSLB #644768."])("rejects contradictory full-page context outside the reviewed passage: %s", async extra => {
    const html = source + extra; fetch.mockResolvedValueOnce(page(html));
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { quote: source, quoteSha256: sha(source) }), company, context, now)).rejects.toThrow(/conflicting|ambiguous|historical|negated/);
  });
  it("accepts only the complete neutral area heading, scoped to the CSLB branch", async () => {
    const html = "Additional Areas Served Acme Inc. California License #644768."; fetch.mockResolvedValueOnce(page(html));
    expect((await registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).website?.binding).toBe("exact_cslb_license_legal_subject");
  });
  it.each(["Served Acme Inc", "Global Acme Inc", "Not Acme Inc", "Customer Acme Inc", "Additional Areas Acme Inc", "GlobalAdditional Areas Served Acme Inc", "Additional Areas ServedBy Acme Inc", "Additional Areas Served Global Acme Inc", "Additional Areas Served Not Acme Inc"])("rejects an ambiguous/partial/embedded heading or legal subject: %s", async subject => {
    await expect(registryWebsiteVerifier()(row(), proof(row(), `${subject}. California License #644768.`), company, context, now)).rejects.toThrow(/prefix|negated|ambiguous/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still checks every subject occurrence after a valid heading", async () => {
    const quote = "Additional Areas Served Acme Inc. California License #644768.", html = quote + " Global Acme Inc.";
    fetch.mockResolvedValueOnce(page(html));
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { quote, quoteSha256: sha(quote) }), company, context, now)).rejects.toThrow("prefix");
  });
  it("does not permit omitted addresses for legacy, USDOT or EIN proofs", () => {
    const item = row(), cslb = proof(item), { mode, identifier, reader, reviewer, ...legacy } = cslb;
    const hash = registryWebsiteEvidenceHash(item, legacy), attested = { ...legacy, reader: { ...reader, evidenceSha256: hash }, reviewer: { ...reviewer, evidenceSha256: hash } };
    expect(() => parseRegistryWebsiteCorroboration(attested, item, now)).toThrow("address");
    for (const [dataset, kind, field, value, sourceUrl] of [["fmcsa", "usdot", "usdot_number", "644768", "https://data.transportation.gov/a.json"], ["irs_exempt", "ein", "ein", "123456789", "https://www.irs.gov/a.csv"]] as const) {
      const r = row(); r.profile.dataset = dataset; r.profile.recordId = value; r.profile.facts = [{ field, label: field, value }]; r.profile.provenance.sourceRow[field] = value; r.sourceUrl = sourceUrl;
      expect(() => parseRegistryWebsiteCorroboration(proof(r, source, { identifier: { kind, value } }), r, now)).toThrow("address");
    }
  });
  it("applies unchanged full literal address checks whenever an address is supplied", async () => {
    const address = { addressLine1: "456 New Road", addressLine2: "Suite 2", city: "Reno", state: "NV", postalCode: "89501", countryCode: "US" as const };
    const html = `Acme Inc Contact 456 New Road Suite 2 Reno NV 89501. California License #644768.`;
    fetch.mockResolvedValueOnce(page(html));
    const result = await registryWebsiteVerifier()(row(), proof(row(), html, { address }), company, context, now);
    expect(result.website).toMatchObject({ websiteAddress: address, registryAddress: identity, addressRelationship: "separate_observations_not_address_equivalence" });
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { address: { ...address, addressLine2: "Suite 3" } }), company, context, now)).rejects.toThrow("complete address");
    expect(() => parseRegistryWebsiteCorroboration(proof(row(), html, { address: { ...address, addressLine1: "" } }), row(), now)).toThrow("address");
  });
  it("binds changed source facts, final interpretation and optional-address choice to fresh independent attestations", () => {
    const original = row(), attested = proof(original), changed = row("SUSPENDED");
    expect(changed.profile.provenance.rowSha256).toBe(original.profile.provenance.rowSha256);
    expect(() => parseRegistryWebsiteCorroboration(attested, changed, now)).toThrow("bind exact");
    changed.detail = "Different final interpretation";
    expect(() => parseRegistryWebsiteCorroboration(attested, changed, now)).toThrow("bind exact");
    const { legalName, ...address } = identity;
    expect(() => parseRegistryWebsiteCorroboration({ ...attested, address }, original, now)).toThrow("bind exact");
    expect(() => parseRegistryWebsiteCorroboration({ ...attested, reviewer: attested.reader }, original, now)).toThrow("independent");
  });
  it("still rejects a changed page, off-domain redirects and an inexact legal form", async () => {
    fetch.mockResolvedValueOnce(page(source + " Changed"));
    await expect(registryWebsiteVerifier()(row(), proof(), company, context, now)).rejects.toThrow("changed");
    fetch.mockResolvedValueOnce({ ...page(source), finalUrl: "https://other.com/" });
    await expect(registryWebsiteVerifier()(row(), proof(), company, context, now)).rejects.toThrow("own-domain");
    await expect(registryWebsiteVerifier()(row(), proof(row(), source.replaceAll("Acme Inc", "Acme LLC"), { subject: "Acme LLC" }), company, context, now)).rejects.toThrow("subject");
  });
});
