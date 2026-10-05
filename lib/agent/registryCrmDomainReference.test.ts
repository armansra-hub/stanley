import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => { throw new Error("No database in offline tests"); } }));
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { buildCompanyIdentityContext, parseNetSuiteDomainReference } from "../companyIdentity";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { registryWebsiteEvidenceHash, parseRegistryWebsiteCorroboration, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
const sha = (s: string) => createHash("sha256").update(s).digest("hex"), now = new Date("2026-10-05T00:00:00Z");
const company = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", netsuite_internal_id: "123", name: "Brand Cargo", domain: "old-brand.com" };
const record = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", capturedAt: "2026-07-28T00:00:00+00:00", header: "Lead: 456 Brand Cargo\nAccount Information\nCompany Name Brand Cargo\nWeb Address https://old-brand.com\nProvisioning Email ops@brand.com\nFirmographic Information\nComments old notes ops@another.com" };
const raw = { dot_number: "1234567", dba_name: "BRAND CARGO", legal_name: "ORIGINAL OPERATOR LLC", phy_street: "123 N MAIN ST STE 4", phy_city: "AUSTIN", phy_state: "TX", phy_zip: "78701", phy_country: "US" };
const identity = { legalName: raw.legal_name, addressLine1: raw.phy_street, city: raw.phy_city, state: raw.phy_state, postalCode: raw.phy_zip, countryCode: "US" as const };
const html = "<footer>Brand Cargo Headquarters 123 N Main St Suite 4 Austin TX 78701</footer>", url = "https://brand.com/contact";
function row() {
  const sourceRow = { ...identity, usdot_number: raw.dot_number }, original = JSON.stringify(raw), evidence = JSON.stringify(sourceRow) + "\nOriginal public source row: " + original;
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", companyId: company.id, internalId: "123", sourceUrl: "https://safer.fmcsa.dot.gov/query.asp?query_string=1234567", evidence, detail: "Dated carrier information remains unchanged.", registryProfile: { version: 1, dataset: "fmcsa", recordId: raw.dot_number, sourceAsOf: "2026-02-05", observedAt: "2026-09-29T00:00:00Z", identity: { ...identity }, facts: [{ field: "usdot_number", value: raw.dot_number }], provenance: { sourceRow, quote: evidence, rowSha256: sha(original) } } }, now);
}
function context(r = record) { return buildCompanyIdentityContext(company, { record: r }); }
function proof(r = row(), change: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}, body = html) {
  const text = htmlToVisibleText(body), base = { mode: "registry_dba_address" as const, crmDomainReference: context().crmDomainReference!, observedAt: "2026-10-04T00:00:00Z", sourceUrl: url, subject: "Brand Cargo", quote: text, quoteSha256: sha(text), normalizedVisibleTextSha256: sha(text), address: { addressLine1: "123 N Main St", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const }, ...change };
  const evidenceSha256 = registryWebsiteEvidenceHash(r, base);
  return { ...base, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue({ status: 200, finalUrl: url, contentType: "text/html", body: html }); });
describe("separately reviewed current CRM domain reference", () => {
  it("derives only the labelled current reference and preserves all canonical fields and context text", async () => {
    const c = context(), previous = buildCompanyIdentityContext(company, { record: { ...record, header: record.header.replace("Provisioning Email ops@brand.com", "Provisioning Email") } });
    expect(c.crmDomainReference).toEqual({ schema: "netsuite_provisioning_email_domain_v1", companyId: company.id, internalId: "123", companyName: company.name, recordId: record.id, headerSha256: sha(record.header), capturedAt: record.capturedAt, domain: "brand.com" });
    expect([c.aliases, c.addresses, c.context]).toEqual([previous.aliases, previous.addresses, previous.context]);
    expect(JSON.stringify(c)).not.toContain("ops@"); expect(JSON.stringify(c)).not.toContain("old notes");
    const r = row(), old = JSON.stringify([r, company, c]), hash = registryContentHash(r.profile, r.sourceUrl, r.detail);
    const verified = await registryWebsiteVerifier()(r, proof(r), company, c, now);
    expect(verified.website?.binding).toBe("exact_original_registry_dba_full_address");
    expect(verified.website?.crmDomainReferenceVerification).toMatchObject({ ...c.crmDomainReference, canonicalDomain: "old-brand.com", canonicalDomainChanged: false });
    expect(verified.sourceIds).toContain(`netsuite_record:${record.id}:header:sha256:${sha(record.header)}`);
    expect(JSON.stringify([r, company, c])).toBe(old); expect(registryContentHash(r.profile, r.sourceUrl, r.detail)).toBe(hash);
  });
  it.each([
    record.header.replace("Account Information\n", ""), record.header.replace("Firmographic Information", "Other Section").replace("Comments old notes ops@another.com", ""),
    record.header.replace("Company Name Brand Cargo", "Company Name Brand Cargo LLC"), record.header.replace("Company Name Brand Cargo", "Company Name Brand Cargo West"),
    record.header.replace("Provisioning Email ops@brand.com", "Contact Email ops@brand.com"), record.header.replace("Provisioning Email ops@brand.com", "Provisioning Email"),
    record.header.replace("Provisioning Email ops@brand.com", "Provisioning Email ops@brand.com; ops@other.com"),
    record.header.replace("Provisioning Email ops@brand.com", "Research Notes\nProvisioning Email ops@brand.com"),
    record.header.replace("Provisioning Email ops@brand.com", "Contacts\nProvisioning Email ops@brand.com"),
    record.header.replace("Provisioning Email ops@brand.com", "Comments Provisioning Email ops@brand.com"),
    record.header.replace("Provisioning Email ops@brand.com", "Provisioning Email ops@brand.com\nProvisioning Email ops@other.com"),
    record.header.replace("Company Name Brand Cargo", "Company Name Brand Cargo\nCompany Name Brand Cargo"),
    record.header.replace("Account Information", "Account Information\nAccount Information"),
    record.header.replace("Provisioning Email ops@brand.com", "Provisioning Email https://brand.com"),
    record.header + "x".repeat(6001),
  ])("rejects absent, duplicate, truncated, wrong-name or non-current labelled fields %#", header => {
    expect(parseNetSuiteDomainReference(company, { ...record, header })).toBeUndefined();
  });
  it.each(["gmail.com", "sub.gmail.com", "tenant.onmicrosoft.com", "wordpress.com", "yahoo.com", "proton.me", "127.0.0.1", "xn--lookalike.test", "www.brand.com"])("rejects non-business or unsafe reference domain %s", domain => {
    expect(parseNetSuiteDomainReference(company, { ...record, header: record.header.replace("ops@brand.com", "ops@" + domain) })).toBeUndefined();
  });
  it.each([{ id: "wrong" }, { capturedAt: "2026-07-28" }, { capturedAt: "invalid" }])("rejects malformed server metadata %j", change => {
    expect(parseNetSuiteDomainReference(company, { ...record, ...change })).toBeUndefined();
  });
  it.each([".ops", "ops.", "op..s", "x".repeat(65)])("rejects malformed or oversized mailbox local part %s", local => {
    expect(parseNetSuiteDomainReference(company, { ...record, header: record.header.replace("ops@brand.com", local + "@brand.com") })).toBeUndefined();
  });
  it.each(["recordId", "headerSha256", "capturedAt", "domain", "companyName"])("rejects a re-signed caller reference differing from server %s", async field => {
    const r = row(), ref = { ...context().crmDomainReference!, [field]: field === "recordId" ? company.id : field === "headerSha256" ? "a".repeat(64) : field === "capturedAt" ? "2026-07-29T00:00:00Z" : "different.com" };
    await expect(registryWebsiteVerifier()(r, proof(r, { crmDomainReference: ref }), company, context(), now)).rejects.toThrow("server-derived");
  });
  it("rejects absent server metadata, absent current IDs, wrong IDs, and caller-only aliases", async () => {
    const r = row(), p = proof(r);
    for (const c of [{ aliases: [], addresses: [], context: "" }, { aliases: ["brand.com"], addresses: [], context: "" }]) await expect(registryWebsiteVerifier()(r, p, company, c, now)).rejects.toThrow("server-derived");
    for (const co of [{ name: company.name, domain: company.domain }, { ...company, id: record.id }, { ...company, netsuite_internal_id: "999" }]) await expect(registryWebsiteVerifier()(r, p, co, context(), now)).rejects.toThrow("server-derived");
  });
  it.each(["https://brand.com.evil.test/contact", "https://sub.brand.com/contact", "https://old-brand.com/contact", "https://brand.com/contact?other=1"])("rejects source outside the exact referenced host/path %s", async sourceUrl => {
    const r = row(); await expect(registryWebsiteVerifier()(r, proof(r, { sourceUrl }), company, context(), now)).rejects.toThrow();
  });
  it.each(["https://brand.com/other", "https://www.brand.com/contact", "https://other.com/contact"])("rejects guessed or changed redirect %s", async finalUrl => {
    fetch.mockResolvedValue({ status: 200, finalUrl, contentType: "text/html", body: html }); const r = row(); await expect(registryWebsiteVerifier()(r, proof(r), company, context(), now)).rejects.toThrow();
  });
  it("binds the full original profile and changed page rather than email alone", async () => {
    const r = row(), p = proof(r); r.detail += " changed"; expect(() => parseRegistryWebsiteCorroboration(p, r, now)).toThrow();
    const untouched = row(); fetch.mockResolvedValue({ status: 200, finalUrl: url, contentType: "text/html", body: html + " changed" }); await expect(registryWebsiteVerifier()(untouched, proof(untouched), company, context(), now)).rejects.toThrow("changed");
  });
  it("retains legal-form, original-DBA, full-unit and country gates", async () => {
    for (const identityChange of [{ legalName: "ORIGINAL OPERATOR INC" }, { addressLine1: "123 N MAIN ST STE 5" }, { countryCode: undefined }]) {
      const r = row(); Object.assign(r.profile.identity, identityChange); await expect(registryWebsiteVerifier()(r, proof(r), company, context(), now)).rejects.toThrow();
    }
    const r = row(); await expect(registryWebsiteVerifier()(r, proof(r, { subject: "Brand" }), company, context(), now)).rejects.toThrow();
  });
  it("requires actual independent fresh reviews after both captured sources", async () => {
    const r = row(); const same = proof(r); same.reviewer.taskId = same.reader.taskId; expect(() => parseRegistryWebsiteCorroboration(same, r, now)).toThrow("independent");
    for (const observedAt of ["2026-10-06T00:00:00Z", "invalid"]) expect(() => parseRegistryWebsiteCorroboration(proof(r, { observedAt }), r, now)).toThrow();
    const stale = proof(r); stale.reader.reviewedAt = "2026-09-20T00:00:00Z"; expect(() => parseRegistryWebsiteCorroboration(stale, r, now)).toThrow();
    const earlier = proof(r); earlier.reader.reviewedAt = "2026-10-03T00:00:00Z"; expect(() => parseRegistryWebsiteCorroboration(earlier, r, now)).toThrow("precedes");
    const reverse = proof(r); reverse.reviewer.reviewedAt = "2026-10-04T23:59:00Z"; expect(() => parseRegistryWebsiteCorroboration(reverse, r, now)).toThrow("precedes");
  });
  it.each([{ mode: "registry_identifier" }, { canonicalRedirect: { requestedUrl: "https://old-brand.com/", finalUrl: "https://brand.com/", normalizedVisibleTextSha256: "a".repeat(64) } }])("rejects unsupported combinations %j", change => {
    const r = row(); expect(() => parseRegistryWebsiteCorroboration({ ...proof(r), ...change }, r, now)).toThrow();
  });
  it("rechecks CRM proof mode and witnesses even when invoked directly rather than through HTTP parsing", async () => {
    const r = row();
    await expect(registryWebsiteVerifier()(r, proof(r, { mode: undefined }), company, context(), now)).rejects.toThrow("canonical legal entity");
  });
  it("keeps canonical-domain DBA proofs unchanged without reference or new observedAt", async () => {
    const r = row(), p = proof(r, { crmDomainReference: undefined, observedAt: undefined });
    const { crmDomainReference: _c, observedAt: _o, reader: _r, reviewer: _v, ...base } = p;
    const evidenceSha256 = registryWebsiteEvidenceHash(r, base), legacy = { ...base, reader: { ...p.reader, evidenceSha256 }, reviewer: { ...p.reviewer, evidenceSha256 } };
    expect((await registryWebsiteVerifier()(r, legacy, { ...company, domain: "brand.com" }, context(), now)).website).not.toHaveProperty("crmDomainReferenceVerification");
  });
});
