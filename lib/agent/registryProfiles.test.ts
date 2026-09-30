import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryProfileKey, verifyRegistryIdentity, type RegistryProfile } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

const now = new Date("2026-09-29T23:00:00Z");
const identity = { legalName: "Acme Logistics Inc", addressLine1: "123 Main Street", city: "Austin", state: "TX", postalCode: "78701" };
export function registryFixture() {
  const sourceRow = { ...identity, drivers: 42, power_units: 0 };
  const evidence = JSON.stringify(sourceRow);
  return { internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "ops_profile", source: "registry", detail: "Reported fleet capacity, not total employees.", evidence,
    sourceUrl: "https://data.transportation.gov/resource/test.json", registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null,
      observedAt: "2026-09-29T22:00:00Z", facts: [{ field: "drivers", value: 42 }, { field: "power_units", value: 0 }], identity,
      provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow, localFile: "research/registry/fmcsa/12345.json" } } };
}
const context: CompanyIdentityContext = { aliases: [], context: "private source headers must not leave this module", addresses: [{ addressLine1: "123 MAIN ST", city: "Austin", state: "TX", postalCode: "78701-1234", sourceKind: "netsuite_record", sourceId: "record-1", capturedAt: "2026-09-28T00:00:00Z" }] };
describe("registry baseline validation", () => {
  it("collapses an identical repeated terminal suite but preserves differing units and floors", () => {
    const profile = parseRegistryFinding(registryFixture(), now).profile;
    profile.identity = { ...profile.identity, addressLine1: "4161 N Thanksgiving Way Ste 202" };
    const ctx = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "4161 N Thanksgiving Way Ste202", addressLine2: "Suite 202" }] };
    expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, ctx, [], now)?.method).toBe("exact_legal_name_address");
    for (const addressLine2 of ["Suite 203", "Floor 202", "Suite 202 Floor 2"]) {
      expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, { ...ctx, addresses: [{ ...ctx.addresses[0], addressLine2 }] }, [], now)).toBeNull();
    }
  });
  it("retains null source date, zero facts and source-specific units; key ignores mutable label/count", () => {
    const row = parseRegistryFinding(registryFixture(), now);
    expect(row.profile.sourceAsOf).toBeNull();
    expect(row.profile.facts[0]).toEqual({ field: "drivers", label: "Reported drivers", value: 42, unit: "drivers" });
    expect(row.profile.facts[1].value).toBe(0);
    expect(registryProfileKey(row.profile)).toBe("registry:fmcsa:12345");
    expect(registryContentHash(row.profile, row.sourceUrl)).toBe(registryContentHash({ ...row.profile, observedAt: "2026-10-01T00:00:00Z" }, row.sourceUrl));
  });
  it.each(["https://data.transportation.gov.evil.test/a", "http://data.transportation.gov/a", "https://user:pass@data.transportation.gov/a", "https://data.transportation.gov:444/a"]) ("rejects non-authoritative URL %s", sourceUrl => {
    expect(() => parseRegistryFinding({ ...registryFixture(), sourceUrl }, now)).toThrow("approved dataset host");
  });
  it("rejects misrepresented counts, non-source facts, private fields, fabricated evidence and caller verification", () => {
    const sample = registryFixture();
    expect(() => parseRegistryFinding({ ...sample, registryProfile: { ...sample.registryProfile, facts: [{ field: "drivers", value: 42, label: "Employees", unit: "employees" }] } }, now)).toThrow("misrepresents");
    expect(() => parseRegistryFinding({ ...sample, registryProfile: { ...sample.registryProfile, facts: [{ field: "drivers", value: 43 }] } }, now)).toThrow("source-row value");
    expect(() => parseRegistryFinding({ ...sample, registryProfile: { ...sample.registryProfile, provenance: { ...sample.registryProfile.provenance, sourceRow: { ...sample.registryProfile.provenance.sourceRow, owner_email: "personal@example.test" } } } }, now)).toThrow("unnecessary field");
    expect(() => parseRegistryFinding({ ...sample, evidence: "The registry contains something else", registryProfile: { ...sample.registryProfile, provenance: { ...sample.registryProfile.provenance, quote: "The registry contains something else" } } }, now)).toThrow("retained exact quote");
    expect(() => parseRegistryFinding({ ...sample, registryProfile: { ...sample.registryProfile, verification: { method: "verified" } } }, now)).toThrow("server-owned");
  });
  it("requires CMS organization type 2 and excludes duplicating existing federal/Form5500 imports", () => {
    const sample = registryFixture();
    const cms = (organizationType: number) => {
      const sourceRow = { ...identity, organization_type: organizationType, npi: "1234567890" }, evidence = JSON.stringify(sourceRow);
      return { ...sample, sourceUrl: "https://npiregistry.cms.hhs.gov/provider-view/1234567890", evidence, registryProfile: { ...sample.registryProfile, dataset: "cms_nppes", facts: [{ field: "npi", value: "1234567890" }], provenance: { ...sample.registryProfile.provenance, quote: evidence, sourceRow } } };
    };
    expect(() => parseRegistryFinding(cms(1), now)).toThrow("entity type 2");
    expect(parseRegistryFinding(cms(2), now).profile.dataset).toBe("cms_nppes");
    expect(() => parseRegistryFinding({ ...sample, registryProfile: { ...sample.registryProfile, dataset: "form5500" } }, now)).toThrow("unsupported registry");
  });
  it("supports exact Canadian identities without inventing US ZIPs, and preserves full postal code", () => {
    const sample = registryFixture();
    const caIdentity = { ...identity, state: "BC", countryCode: "CA", postalCode: "V6B 1A1" };
    const sourceRow = { ...caIdentity, business_number: "123456789" }, evidence = JSON.stringify(sourceRow);
    const row = parseRegistryFinding({ ...sample, evidence, sourceUrl: "https://orgbook.gov.bc.ca/api/v4/topic/1", registryProfile: { ...sample.registryProfile,
      dataset: "bc_orgbook", identity: caIdentity, facts: [{ field: "business_number", value: "123456789" }], provenance: { ...sample.registryProfile.provenance, sourceRow, quote: evidence } } }, now);
    const caContext = { ...context, addresses: [{ ...context.addresses[0], state: "BC", countryCode: "CA", postalCode: "V6B1A1" }] };
    expect(verifyRegistryIdentity(row.profile, { name: identity.legalName }, caContext, [], now)).toMatchObject({ method: "exact_legal_name_address" });
    expect(verifyRegistryIdentity(row.profile, { name: identity.legalName }, { ...caContext, addresses: [{ ...caContext.addresses[0], postalCode: "V6B1A2" }] }, [], now)).toBeNull();
  });
  it("names IRS tax periods and licensed professionals truthfully", () => {
    const sample = registryFixture();
    const sourceRow = { ...identity, tax_period: "202412" }, evidence = JSON.stringify(sourceRow);
    const row = parseRegistryFinding({ ...sample, evidence, sourceUrl: "https://www.irs.gov/pub/irs-soi/eo_tx.csv", registryProfile: { ...sample.registryProfile,
      dataset: "irs_exempt", facts: [{ field: "tax_period", value: "202412" }], provenance: { ...sample.registryProfile.provenance, sourceRow, quote: evidence } } }, now);
    expect(row.profile.facts[0].label).toBe("Financial reporting period");
    expect(() => parseRegistryFinding({ ...sample, evidence, sourceUrl: "https://www.irs.gov/pub/irs-soi/eo_tx.csv", registryProfile: { ...sample.registryProfile,
      dataset: "irs_exempt", facts: [{ field: "filing_date", value: "202412" }], provenance: { ...sample.registryProfile.provenance, sourceRow, quote: evidence } } }, now)).toThrow("unsupported");
  });
  it("preserves literal WA license asterisks and keeps Canadian charity amounts in CAD", () => {
    const sample = registryFixture();
    const sourceRow = { ...identity, license_number: "BLAZEL*759KK" }, evidence = JSON.stringify(sourceRow);
    const wa = parseRegistryFinding({ ...sample, evidence, sourceUrl: "https://data.wa.gov/resource/licensing.json", registryProfile: { ...sample.registryProfile, dataset: "wa_contractors", recordId: "BLAZEL*759KK",
      facts: [{ field: "license_number", value: "BLAZEL*759KK" }], provenance: { ...sample.registryProfile.provenance, sourceRow, quote: evidence } } }, now);
    expect(wa.label).toBe("registry:wa_contractors:BLAZEL*759KK");
    const caIdentity = { ...identity, state: "BC", countryCode: "CA", postalCode: "V6B 1A1" };
    const cadRow = { ...caIdentity, total_revenue_cad: 100000 }, cadEvidence = JSON.stringify(cadRow);
    const cad = parseRegistryFinding({ ...sample, evidence: cadEvidence, sourceUrl: "https://open.canada.ca/data/dataset/example/download/financial.csv", registryProfile: { ...sample.registryProfile,
      dataset: "cra_charities", identity: caIdentity, facts: [{ field: "total_revenue_cad", value: 100000 }], provenance: { ...sample.registryProfile.provenance, sourceRow: cadRow, quote: cadEvidence } } }, now);
    expect(cad.profile.facts[0].unit).toBe("CAD");
  });
});
describe("registry identity admission", () => {
  const profile = () => parseRegistryFinding(registryFixture(), now).profile;
  it("requires exact legal-name plus street/unit, ZIP and state sourced independently", () => {
    expect(verifyRegistryIdentity(profile(), { name: identity.legalName }, context, [], now)).toMatchObject({ method: "exact_legal_name_address", sourceIds: ["record-1"] });
    for (const override of [{ addressLine1: "125 Main Street" }, { addressLine2: "Suite 2" }, { state: "CA" }, { postalCode: "78702" }, { legalName: "Acme Logistics Holdings Inc" }]) {
      expect(verifyRegistryIdentity({ ...profile(), identity: { ...identity, ...override } }, { name: identity.legalName }, context, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(profile(), { name: identity.legalName }, { ...context, addresses: [] }, [], now)).toBeNull();
  });
  it("accepts only same-source same-record unchanged previously server-verified binding", () => {
    const old: RegistryProfile = { ...profile(), verification: { method: "exact_legal_name_address", verifiedAt: now.toISOString(), sourceIds: ["record-1"] }, publication: { contentHash: "b".repeat(64), eventId: "old-event", publishedAt: now.toISOString() } };
    const empty = { aliases: [], addresses: [], context: "" };
    expect(verifyRegistryIdentity(profile(), { name: "renamed" }, empty, [old], now)?.method).toBe("prior_registry_binding");
    expect(verifyRegistryIdentity({ ...profile(), recordId: "other" }, { name: "renamed" }, empty, [old], now)).toBeNull();
    expect(verifyRegistryIdentity(profile(), { name: "renamed" }, empty, [{ ...old, publication: undefined }], now)).toBeNull();
  });
  it.each([
    ["Acme Logistics Incorporated", "Acme Logistics Inc."],
    ["Acme Logistics Corporation", "Acme Logistics Corp"],
    ["Acme Logistics L.L.C.", "Acme Logistics LLC"],
    ["Acme Logistics", "Acme Logistics Inc"],
    ["Acme Logistics LLC", "Acme Logistics"],
  ])("accepts only equivalent or omitted terminal legal suffixes: %s / %s", (companyName, sourceName) => {
    expect(verifyRegistryIdentity({ ...profile(), identity: { ...identity, legalName: sourceName } }, { name: companyName }, context, [], now)?.method).toBe("exact_legal_name_address");
  });
  it.each(["Acme Logistics Holdings Inc", "Acme Logistics Group Inc", "Acme Logistics West Inc", "Acme Logistics LLC", "Acme Logistics Inc Services"])("preserves substantive name words and conflicting explicit legal forms: %s", name => {
    expect(verifyRegistryIdentity(profile(), { name }, context, [], now)).toBeNull();
  });
  it("matches the MSBA Sixth Street formatting hold without dropping its unit or direction", () => {
    const source = { ...profile(), identity: { legalName: "MINNESOTA STATE BAR ASSOCIATION MSBA", addressLine1: "33 S 6TH ST STE4540", city: "MINNEAPOLIS", state: "MN", postalCode: "55402-3714" } };
    const crm = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "33 South Sixth Street #4540", state: "MN", postalCode: "55402", countryCode: "US" }] };
    const company = { name: "Minnesota State Bar Association (MSBA)" };
    expect(verifyRegistryIdentity(source, company, crm, [], now)?.sourceIds).toEqual(["record-1"]);
    for (const addressLine1 of ["33 N 6TH ST STE 4540", "33 S 6TH ST STE 4541", "33 S 6TH ST", "34 S 6TH ST STE 4540"]) {
      expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, addressLine1 } }, company, crm, [], now)).toBeNull();
    }
  });
  it("combines address lines while preserving exact units and permits postal-city aliases", () => {
    const source = { ...profile(), identity: { legalName: "STRATIS HEALTH", addressLine1: "2901 METRO DR STE 400", city: "BLOOMINGTON", state: "MN", postalCode: "55425-1558" } };
    const crm = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "2901 Metro Drive", addressLine2: "Suite 400", city: "Minneapolis", state: "MN", postalCode: "55425-1525", countryCode: "US" }] };
    const company = { name: "Stratis Health" };
    expect(verifyRegistryIdentity(source, company, crm, [], now)?.method).toBe("exact_legal_name_address");
    for (const override of [{ addressLine2: "Suite 401" }, { addressLine2: undefined }, { postalCode: "55424" }, { state: "WI" }, { countryCode: "CA" }]) {
      expect(verifyRegistryIdentity(source, company, { ...crm, addresses: [{ ...crm.addresses[0], ...override }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(source, company, { ...crm, addresses: [] }, [], now)).toBeNull();
  });
  it("normalizes directional and street abbreviations without conflating different directions or streets", () => {
    const source = { ...profile(), identity: { ...identity, addressLine1: "123 NW FIRST AVE UNIT 2" } };
    const crm = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "123 North West First Avenue", addressLine2: "Suite #2" }] };
    expect(verifyRegistryIdentity(source, { name: identity.legalName }, crm, [], now)?.method).toBe("exact_legal_name_address");
    for (const addressLine1 of ["123 NE 1ST AVE UNIT 2", "123 NW 2ND AVE UNIT 2", "123 NW 1ST ST UNIT 2"]) {
      expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, addressLine1 } }, { name: identity.legalName }, crm, [], now)).toBeNull();
    }
  });
});
