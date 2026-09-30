import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryProfileKey, registryStreet, sameRegistryLegalName, sameRegistryStreet, verifyRegistryIdentity, type RegistryProfile } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

describe("explicit terminal US suite punctuation", () => {
  const address = { addressLine1: "2505 Anthem Village Dr, Suite E-525", state: "NV", countryCode: "US" };
  it.each([
    { addressLine1: "2505 Anthem Village Drive Ste E525" },
    { addressLine1: "2505 Anthem Village Dr, Ste. e525" },
    { addressLine1: "2505 Anthem Village Dr", addressLine2: "Suite E525" },
  ])("compares the same full suite inline or on its own line: $addressLine1", other => {
    const right = { ...address, ...other };
    expect(sameRegistryStreet(address, right)).toBe(true);
    expect(sameRegistryStreet(right, address)).toBe(true);
  });
  it.each([
    "2505 Anthem Village Dr E525", "2505 Anthem Village Dr Unit E525", "2505 Anthem Village Dr Floor E525",
    "2505 Anthem Village Dr Suite E526", "2505 Anthem Village Dr Suite E0525", "2505 Anthem Village Dr Suite F525",
    "2505 Anthem Village Dr Suite E525-526", "2505 Anthem Village Dr Suite EE525", "2505 Anthem Village Dr Suite E525 Floor 2",
    "2505 Anthem Village Dr Suite E525 Suite E526", "2505 Anthem Village Dr Building A Suite E525",
    "2506 Anthem Village Dr Suite E525", "2505 North Anthem Village Dr Suite E525", "2505 Anthem Village Road Suite E525",
  ])("preserves explicit designators, full units and every street token: %s", addressLine1 => {
    expect(sameRegistryStreet(address, { ...address, addressLine1 })).toBe(false);
  });
  it("does not discard an additional line or geography", () => {
    const other = { ...address, addressLine1: "2505 Anthem Village Dr Ste E525" };
    for (const change of [{ addressLine2: "Suite E525" }, { addressLine2: "Floor 2" }, { addressLine2: "North" }, { state: "TX" }, { countryCode: "CA" }, { countryCode: undefined }]) {
      expect(sameRegistryStreet(address, { ...other, ...change })).toBe(false);
    }
    expect(registryStreet(address)).toBe("2505 anthem village dr unit e 525");
    expect(registryStreet(other)).toBe("2505 anthem village dr unit e525");
  });
  it("retains exact legal, postal and jurisdiction checks when a canonical address uses an inline suite", () => {
    const profile = parseRegistryFinding(registryFixture(), now).profile;
    profile.identity = { ...profile.identity, ...address, city: "Henderson", postalCode: "89052", countryCode: "US" };
    const a = { ...context.addresses[0], ...address, addressLine1: "2505 Anthem Village Dr Ste E525", city: "Henderson", postalCode: "89052" };
    const ctx = { ...context, addresses: [a] }, before = JSON.stringify(profile), hash = registryContentHash(profile, "https://data.transportation.gov/resource/test.json");
    expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, ctx, [], now)?.method).toBe("exact_legal_name_address");
    for (const change of [{ addressLine1: "2505 Anthem Village Dr Ste E526" }, { postalCode: "89053" }, { state: "TX" }, { countryCode: "CA" }]) {
      expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, { ...ctx, addresses: [{ ...a, ...change }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(profile, { name: "Acme Logistics LLC" }, ctx, [], now)).toBeNull();
    expect(JSON.stringify(profile)).toBe(before);
    expect(registryContentHash(profile, "https://data.transportation.gov/resource/test.json")).toBe(hash);
  });
});

describe("explicit US PO-box punctuation", () => {
  const address = { addressLine1: "P.O. Box 130808", state: "TX", countryCode: "US" };
  it.each(["PO Box 130808", "POBox 130808", "P.O.Box 130808", "P. O. Box 130808", "po box 130808"])("compares the same complete numeric mailbox: %s", addressLine1 => {
    const other = { ...address, addressLine1 };
    expect(sameRegistryStreet(address, other)).toBe(true);
    expect(sameRegistryStreet(other, address)).toBe(true);
  });
  it("preserves the schema's omitted US-country default, without changing fingerprints", () => {
    const source = { addressLine1: address.addressLine1, state: "TX" };
    const website = { ...address, addressLine1: "PO Box 130808" };
    expect(registryStreet(source)).toBe("p o box 130808");
    expect(registryStreet(website)).toBe("po box 130808");
    expect(sameRegistryStreet(source, website)).toBe(true);
  });
  it.each([
    "PO Box 130809", "PO Box 0130808", "PO Box 130808A", "PO Box 130808-130809",
    "PO Box 130808 Suite 2", "PMB 130808", "130808 PO Box Road", "Rural Route 2 PO Box 130808",
    "Care of PO Box 130808", "Old PO Box 130808", "PO Box 130808 North",
  ])("does not discard box digits or qualifiers: %s", addressLine1 => {
    expect(sameRegistryStreet(address, { ...address, addressLine1 })).toBe(false);
  });
  it("does not drop second-line station/unit information or substitute a country/state", () => {
    const other = { ...address, addressLine1: "PO Box 130808" };
    // Existing P.O. and P-O fingerprints are already equal. The new branch
    // must not also merge P-O with the previously distinct PO token.
    expect(sameRegistryStreet({ ...address, addressLine1: "P-O Box 130808" }, other)).toBe(false);
    for (const addressLine2 of ["Station A", "Suite 2", "Floor 3", "North"]) {
      expect(sameRegistryStreet(address, { ...other, addressLine2 })).toBe(false);
      expect(sameRegistryStreet({ ...address, addressLine2 }, { ...other, addressLine2 })).toBe(true);
      expect(sameRegistryStreet({ ...address, addressLine2 }, { ...other, addressLine2: "Station B" })).toBe(false);
    }
    for (const extra of [{ state: "OK" }, { state: undefined }, { countryCode: "CA" }, { countryCode: "GB" }]) {
      expect(sameRegistryStreet(address, { ...other, ...extra })).toBe(false);
    }
  });
  it("keeps legal-name, complete mailbox, ZIP and geography checks at the identity gate", () => {
    const profile = parseRegistryFinding(registryFixture(), now).profile;
    profile.identity = { ...profile.identity, addressLine1: "P.O. Box 130808", city: "Dallas", state: "TX", postalCode: "75313" };
    const a = { ...context.addresses[0], addressLine1: "PO Box 130808", city: "Dallas", state: "TX", postalCode: "75313", countryCode: "US" };
    const ctx = { ...context, addresses: [a] };
    const before = JSON.stringify(profile), hash = registryContentHash(profile, "https://data.transportation.gov/resource/test.json");
    expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, ctx, [], now)?.method).toBe("exact_legal_name_address");
    for (const change of [{ addressLine1: "PO Box 130809" }, { addressLine2: "Unit 3" }, { postalCode: "75314" }, { state: "OK" }, { countryCode: "CA" }]) {
      expect(verifyRegistryIdentity(profile, { name: profile.identity.legalName }, { ...ctx, addresses: [{ ...a, ...change }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(profile, { name: "Acme Logistics LLC" }, ctx, [], now)).toBeNull();
    expect(JSON.stringify(profile)).toBe(before);
    expect(registryContentHash(profile, "https://data.transportation.gov/resource/test.json")).toBe(hash);
  });
});

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
  it("compares explicit US terminal Building/BLDG without changing fingerprints or profile content", () => {
    const source = { addressLine1: "4051 N HIGLEY RD BLDG 25", countryCode: "US" };
    const expanded = { addressLine1: "4051 N Higley Road Building 25", countryCode: "US" };
    const original = JSON.stringify([source, expanded]);
    expect(registryStreet(source)).toBe("4051 n higley rd bldg 25");
    expect(registryStreet(expanded)).toBe("4051 n higley rd building 25");
    expect(sameRegistryStreet(source, expanded)).toBe(true);
    expect(sameRegistryStreet(expanded, source)).toBe(true);
    expect(sameRegistryStreet(source, { ...expanded, addressLine1: "4051 N Higley Road", addressLine2: "Building 25" })).toBe(true);
    expect(JSON.stringify([source, expanded])).toBe(original);
  });
  it.each([
    "4051 N Higley Rd Building 26", "4051 N Higley Rd Building 025", "4051 N Higley Rd Building 25A",
    "4051 N Higley Rd Suite 25", "4051 N Higley Rd", "4051 N Higley Rd 25",
    "4052 N Higley Rd Building 25", "4051 S Higley Rd Building 25", "4051 N Higley Rd 25 Building",
    "4051 N Higley Rd Building25", "4051 N Higley Rd Building 25 Suite 2",
  ])("keeps building identity, civic numbers and designators exact: %s", addressLine1 => {
    expect(sameRegistryStreet({ addressLine1: "4051 N HIGLEY RD BLDG 25", countryCode: "US" }, { addressLine1, countryCode: "US" })).toBe(false);
  });
  it("requires explicit US on both building addresses and does not expand street names or bare designators", () => {
    const source = { addressLine1: "4051 N Higley Rd BLDG 25", countryCode: "US" };
    const expanded = { addressLine1: "4051 N Higley Rd Building 25", countryCode: "US" };
    for (const countryCode of [undefined, "CA"]) {
      expect(sameRegistryStreet({ ...source, countryCode }, expanded)).toBe(false);
      expect(sameRegistryStreet(source, { ...expanded, countryCode })).toBe(false);
    }
    for (const [left, right] of [["Building 25", "BLDG 25"], ["4051 Building Road", "4051 BLDG Road"], ["4051 Building 25 Rd", "4051 BLDG 25 Rd"]]) {
      expect(sameRegistryStreet({ ...source, addressLine1: left }, { ...expanded, addressLine1: right })).toBe(false);
    }
  });
  it("admits terminal Company/Co only with exact independently sourced US canonical address", () => {
    const source = { ...profile(), identity: { legalName: "AGILIS CO", addressLine1: "2380 CROSSROADS BLVD", city: "ALBERT LEA", state: "MN", postalCode: "56007", countryCode: "US" as const } };
    const address = { ...context.addresses[0], addressLine1: "2380 Crossroads Boulevard", city: "Albert Lea", state: "MN", postalCode: "56007-4001", countryCode: "US" };
    const before = JSON.stringify(source), hash = registryContentHash(source, "https://safer.fmcsa.dot.gov/");
    expect(sameRegistryLegalName("Agilis Company", "AGILIS CO")).toBe(false);
    for (const legalName of ["AGILIS CO", "Agilis Co."]) {
      expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, legalName } }, { name: "Agilis Company" }, { ...context, addresses: [address] }, [], now)).toMatchObject({ method: "exact_legal_name_address", sourceIds: ["record-1"] });
    }
    expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, legalName: "Agilis Company" } }, { name: "Agilis Co" }, { ...context, addresses: [address] }, [], now)?.method).toBe("exact_legal_name_address");
    for (const override of [{ addressLine1: "2381 Crossroads Blvd" }, { addressLine2: "Suite 2" }, { state: "CO" }, { postalCode: "56008" }, { countryCode: "CA" }, { countryCode: undefined }]) {
      expect(verifyRegistryIdentity(source, { name: "Agilis Company" }, { ...context, addresses: [{ ...address, ...override }] }, [], now)).toBeNull();
    }
    for (const countryCode of [undefined, "CA" as const]) {
      expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, countryCode } }, { name: "Agilis Company" }, { ...context, addresses: [address] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(source, { name: "Agilis Company" }, { ...context, addresses: [] }, [], now)).toBeNull();
    expect(JSON.stringify(source)).toBe(before);
    expect(registryContentHash(source, "https://safer.fmcsa.dot.gov/")).toBe(hash);
  });
  it.each([
    ["Agilis", "AGILIS CO"], ["Agilis Corporation", "Agilis Company"], ["Agilis Company Inc", "Agilis Co LLC"],
    ["Agilis Company Inc", "Agilis Co Inc"], ["Agilis Company West", "Agilis Co West"],
    ["Agilis Company", "Agilis LLC"], ["Agilis Company", "Agilis Holdings Co"],
  ])("does not delete Company/Co, expand compound forms or conflate legal entities: %s / %s", (name, legalName) => {
    const source = { ...profile(), identity: { ...identity, legalName, countryCode: "US" as const } };
    const ctx = { ...context, addresses: [{ ...context.addresses[0], countryCode: "US" }] };
    expect(verifyRegistryIdentity(source, { name }, ctx, [], now)).toBeNull();
  });
  it("matches explicit Texas VZ CR and County Road labels without rewriting evidence", () => {
    const source = { ...profile(), identity: { ...identity, legalName: "HUBBARD EXPRESS AIR FREIGHT & DELIVERY LLC", addressLine1: "153 VZ CR 4804", city: "CHANDLER", state: "TX", countryCode: "US" as const, postalCode: "75758" } };
    const address = { ...context.addresses[0], addressLine1: "153 Vz County Road 4804", city: "Chandler", state: "TX", countryCode: "US" as const, postalCode: "75758" };
    const company = { name: "Hubbard Express Air Freight & Delivery" };
    const before = JSON.stringify(source);
    const hash = registryContentHash(source, "https://safer.fmcsa.dot.gov/");
    expect(registryStreet(source.identity)).toBe("153 vz cr 4804");
    expect(registryStreet(address)).toBe("153 vz county rd 4804");
    expect(sameRegistryStreet(source.identity, address)).toBe(true);
    expect(sameRegistryStreet(address, source.identity)).toBe(true);
    expect(verifyRegistryIdentity(source, company, { ...context, addresses: [address] }, [], now)).toMatchObject({ method: "exact_legal_name_address", sourceIds: ["record-1"] });
    expect(JSON.stringify(source)).toBe(before);
    expect(registryContentHash(source, "https://safer.fmcsa.dot.gov/")).toBe(hash);
    for (const override of [{ postalCode: "75756" }, { state: "OK" }, { countryCode: "CA" as const }]) {
      expect(verifyRegistryIdentity(source, company, { ...context, addresses: [{ ...address, ...override }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(source, { name: "Hubbard Express Air Freight & Delivery Inc" }, { ...context, addresses: [address] }, [], now)).toBeNull();
  });
  it("retains VZ road numbers, civic suffixes, directions and units", () => {
    const address = { addressLine1: "153 Vz County Road 4804", state: "TX", countryCode: "US" };
    for (const addressLine1 of ["154 VZ CR 4804", "153A VZ CR 4804", "153 VZ CR 4805", "153 VZ CR 4804A", "153 VZ CR 4804 North", "153 VZ CR 4804 Suite 2", "153 CR 4804", "153 VZ Court 4804", "153 VZ County Avenue 4804"]) {
      expect(sameRegistryStreet(address, { ...address, addressLine1 })).toBe(false);
    }
    const unit = { ...address, addressLine2: "Suite 2" };
    expect(sameRegistryStreet(unit, { ...unit, addressLine1: "153 VZ CR 4804" })).toBe(true);
    for (const addressLine2 of [undefined, "Suite 3", "Floor 2"]) {
      expect(sameRegistryStreet(unit, { ...unit, addressLine1: "153 VZ CR 4804", addressLine2 })).toBe(false);
    }
  });
  it("requires explicit Texas US geography and the anchored VZ road label", () => {
    const address = { addressLine1: "153 Vz County Road 4804", state: "TX", countryCode: "US" };
    const abbreviated = { ...address, addressLine1: "153 VZ CR 4804" };
    for (const override of [{ state: undefined }, { state: "OK" }, { countryCode: undefined }, { countryCode: "CA" }]) {
      expect(sameRegistryStreet({ ...address, ...override }, abbreviated)).toBe(false);
      expect(sameRegistryStreet(address, { ...abbreviated, ...override })).toBe(false);
      expect(sameRegistryStreet({ ...address, ...override }, { ...abbreviated, ...override })).toBe(false);
    }
    for (const [expanded, short] of [["153 Old VZ County Road 4804", "153 Old VZ CR 4804"], ["153 County Road 4804", "153 CR 4804"], ["VZ County Road 4804", "VZ CR 4804"], ["153 VZ County Road", "153 VZ CR"]]) {
      expect(sameRegistryStreet({ ...address, addressLine1: expanded }, { ...abbreviated, addressLine1: short })).toBe(false);
    }
  });
  it("matches explicit Alberta Range Road abbreviations without changing source fingerprints", () => {
    const source = { ...profile(), identity: { ...identity, addressLine1: "55024 RANGE ROAD 234", city: "Sturgeon County", state: "AB", countryCode: "CA" as const, postalCode: "T8T 2A7" } };
    const address = { ...context.addresses[0], addressLine1: "55024 Rge Rd 234", city: "Sturgeon County", state: "AB", countryCode: "CA" as const, postalCode: "T8T2A7" };
    const before = JSON.stringify(source);
    expect(registryStreet(source.identity)).toBe("55024 range rd 234");
    expect(registryStreet(address)).toBe("55024 rge rd 234");
    expect(sameRegistryStreet(source.identity, address)).toBe(true);
    expect(sameRegistryStreet(address, source.identity)).toBe(true);
    expect(verifyRegistryIdentity(source, { name: identity.legalName }, { ...context, addresses: [address] }, [], now)?.method).toBe("exact_legal_name_address");
    expect(JSON.stringify(source)).toBe(before);
    for (const override of [{ postalCode: "T8T2A8" }, { state: "BC" }, { countryCode: "US" as const }]) {
      expect(verifyRegistryIdentity(source, { name: identity.legalName }, { ...context, addresses: [{ ...address, ...override }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(source, { name: "Acme Logistics Holdings Inc" }, { ...context, addresses: [address] }, [], now)).toBeNull();
  });
  it("keeps the rural civic number, road number, suffix, unit and direction exact", () => {
    const address = { addressLine1: "55024 Range Road 234", state: "AB", countryCode: "CA" };
    for (const addressLine1 of ["55025 Rge Rd 234", "55024 Rge Rd 235", "55024 Rge Rd 234A", "55024A Rge Rd 234", "55024 Rge Rd 234 North", "55024 Rge Rd 234 Suite 2", "55024 RR 234", "55024 Rge Avenue 234", "55024 Strange Rd 234"]) {
      expect(sameRegistryStreet(address, { ...address, addressLine1 })).toBe(false);
    }
    const unit = { ...address, addressLine2: "Suite 2" };
    expect(sameRegistryStreet(unit, { ...unit, addressLine1: "55024 Rge Rd 234" })).toBe(true);
    for (const addressLine2 of [undefined, "Suite 3", "Floor 2"]) {
      expect(sameRegistryStreet(unit, { ...unit, addressLine1: "55024 Rge Rd 234", addressLine2 })).toBe(false);
    }
  });
  it("does not expand Range Road outside explicit Alberta Canada or within other street names", () => {
    const address = { addressLine1: "55024 Range Road 234", state: "AB", countryCode: "CA" };
    const abbreviated = { ...address, addressLine1: "55024 Rge Rd 234" };
    for (const override of [{ state: undefined }, { state: "BC" }, { countryCode: undefined }, { countryCode: "US" }]) {
      expect(sameRegistryStreet({ ...address, ...override }, abbreviated)).toBe(false);
      expect(sameRegistryStreet(address, { ...abbreviated, ...override })).toBe(false);
      expect(sameRegistryStreet({ ...address, ...override }, { ...abbreviated, ...override })).toBe(false);
    }
    expect(sameRegistryStreet({ ...address, addressLine1: "55024 Old Range Road 234" }, { ...abbreviated, addressLine1: "55024 Old Rge Rd 234" })).toBe(false);
  });
  it.each([
    ["Floor 2", "Second Floor"], ["Floor 2", "2nd Floor"], ["Floor 2", "Floor 2nd"],
    ["Floor 11", "Eleventh Floor"], ["Floor 12", "12th Floor"], ["Floor 13", "13th Floor"],
    ["Floor 20", "Twentieth Floor"], ["Floor 21", "21st Floor"], ["Floor 112", "112th Floor"],
  ])("matches explicit floor-only second lines without changing source evidence: %s / %s", (sourceFloor, websiteFloor) => {
    const source = { ...profile(), identity: { ...identity, addressLine1: "1550 Wewatta St.", addressLine2: sourceFloor } };
    const before = JSON.stringify(source);
    const website = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "1550 Wewatta Street", addressLine2: websiteFloor }] };
    expect(verifyRegistryIdentity(source, { name: identity.legalName }, website, [], now)?.method).toBe("exact_legal_name_address");
    expect(JSON.stringify(source)).toBe(before);
  });
  it("does not discard floors, replace suites or repair invalid/compound floor designators", () => {
    const source = { ...profile(), identity: { ...identity, addressLine1: "1550 Wewatta St", addressLine2: "Floor 2" } };
    for (const addressLine2 of [undefined, "Floor 3", "Third Floor", "Suite 2", "Floor 02", "2rd Floor", "Floor 2th", "2nd Floor Suite 3", "Floor 2 Suite 3", "Suite 2 Floor 3"]) {
      const website = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "1550 Wewatta Street", addressLine2 }] };
      expect(verifyRegistryIdentity(source, { name: identity.legalName }, website, [], now)).toBeNull();
    }
    for (const [sourceFloor, badOrdinal] of [["Floor 11", "11st Floor"], ["Floor 12", "12nd Floor"], ["Floor 13", "13rd Floor"], ["Floor 21", "21th Floor"]]) {
      const website = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "1550 Wewatta Street", addressLine2: badOrdinal }] };
      expect(verifyRegistryIdentity({ ...source, identity: { ...source.identity, addressLine2: sourceFloor } }, { name: identity.legalName }, website, [], now)).toBeNull();
    }
  });
  it("keeps street, legal-name and compound-designator order gates after floor normalization", () => {
    const source = { ...profile(), identity: { ...identity, addressLine1: "1550 Second Street", addressLine2: "Floor 2" } };
    const website = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "1550 Second Street", addressLine2: "Second Floor" }] };
    for (const addressLine1 of ["1551 Second Street", "1550 Third Street", "1550 Second Avenue"]) {
      expect(verifyRegistryIdentity(source, { name: identity.legalName }, { ...website, addresses: [{ ...website.addresses[0], addressLine1 }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(source, { name: "Acme Logistics Holdings Inc" }, website, [], now)).toBeNull();
    const compound = { ...source, identity: { ...source.identity, addressLine2: "Suite 2 Floor 3" } };
    expect(verifyRegistryIdentity(compound, { name: identity.legalName }, { ...website, addresses: [{ ...website.addresses[0], addressLine2: "Floor 2 Suite 3" }] }, [], now)).toBeNull();
  });
  it.each([["2nd Floor", "Second Floor"], ["Floor 2", "Floor 2"]])("preserves legacy inline/split floor matches and street fingerprints: %s / %s", (inlineFloor, splitFloor) => {
    const source = { ...profile(), identity: { ...identity, addressLine1: `1550 Wewatta Street ${inlineFloor}` } };
    const website = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "1550 Wewatta Street", addressLine2: splitFloor }] };
    expect(registryStreet(source.identity)).toBe(registryStreet(website.addresses[0]));
    expect(registryStreet(website.addresses[0])).toBe(`1550 wewatta st ${inlineFloor.toLowerCase()}`);
    expect(verifyRegistryIdentity(source, { name: identity.legalName }, website, [], now)?.method).toBe("exact_legal_name_address");
  });
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


describe("explicit US suite punctuation and terminal Plaza suffix", () => {
  const suite = { addressLine1: "1322 Space Park Drive", addressLine2: "Suite C-245", state: "TX", countryCode: "US" };
  const compact = { ...suite, addressLine2: "Suite C245" };
  const plaza = { addressLine1: "222 S. Riverside Plaza", addressLine2: "Suite 1500", state: "IL", countryCode: "US" };
  const plz = { addressLine1: "222 S Riverside Plz Ste 1500", state: "IL", countryCode: "US" };
  it("adds symmetric suite punctuation comparison without changing fingerprints or inputs", () => {
    const original = JSON.stringify([suite, compact]);
    expect(registryStreet(suite)).toBe("1322 space park dr unit c 245");
    expect(registryStreet(compact)).toBe("1322 space park dr unit c245");
    expect(sameRegistryStreet(suite, compact)).toBe(true);
    expect(sameRegistryStreet(compact, suite)).toBe(true);
    expect(sameRegistryStreet(suite, { ...compact, addressLine2: "Ste. c245" })).toBe(true);
    expect(sameRegistryStreet({ ...suite, addressLine2: "Suite C-0245" }, { ...compact, addressLine2: "Suite C0245" })).toBe(true);
    expect(JSON.stringify([suite, compact])).toBe(original);
  });
  it.each([
    "C245", "Suite C246", "Suite D245", "Suite C0245", "Suite 245", "Suite C245A", "Suite CC245",
    "Suite C-245-2", "Suite 245-250", "Suite C 245", "Suite C - 245", "Building C Suite 245",
    "Suite C245 Floor 2", "Suite C245 and C246", "Apartment C245", "Unit C245", "SuiteC245", "Suite C/245", "Suite C–245", "Suite С245",
  ])("does not add an equivalence for unsupported unit %s", addressLine2 => {
    // These punctuation-only strings already match the hyphenated fingerprint;
    // the additive branch must not broaden their equivalence to compact C245.
    const reference = ["Suite C 245", "Suite C - 245", "Suite C/245", "Suite C–245"].includes(addressLine2) ? compact : suite;
    expect(sameRegistryStreet(reference, { ...compact, addressLine2 })).toBe(false);
  });
  it.each([
    { addressLine1: "1323 Space Park Drive" }, { addressLine1: "1322 Space Park Road" },
    { addressLine1: "1322 East Space Park Drive" }, { addressLine1: "1322 Space Park Drive Suite C245" },
    { state: "CA" }, { state: undefined }, { countryCode: "CA" }, { countryCode: undefined },
  ])("keeps suite base and explicit geography exact: %j", override => {
    expect(sameRegistryStreet(suite, { ...compact, ...override })).toBe(false);
    expect(sameRegistryStreet({ ...suite, ...override }, compact)).toBe(false);
  });
  it("does not introduce suite matching for non-US pairs, bare UCC units or noncivic bases", () => {
    expect(sameRegistryStreet({ ...suite, countryCode: "CA" }, { ...compact, countryCode: "CA" })).toBe(false);
    expect(sameRegistryStreet(suite, { ...compact, addressLine2: "C245" })).toBe(false);
    expect(sameRegistryStreet({ ...suite, addressLine1: "Space Park" }, { ...compact, addressLine1: "Space Park" })).toBe(false);
  });
  it("compares terminal Plaza/Plz across legacy line splits without changing fingerprints", () => {
    const original = JSON.stringify([plaza, plz]);
    expect(registryStreet(plaza)).toBe("222 s riverside plaza unit 1500");
    expect(registryStreet(plz)).toBe("222 s riverside plz unit 1500");
    expect(sameRegistryStreet(plaza, plz)).toBe(true);
    expect(sameRegistryStreet(plz, plaza)).toBe(true);
    expect(sameRegistryStreet({ ...plaza, addressLine2: undefined }, { ...plz, addressLine1: "222 S Riverside Plz" })).toBe(true);
    expect(JSON.stringify([plaza, plz])).toBe(original);
  });
  it.each([
    "223 S Riverside Plz Ste1500", "222 N Riverside Plz Ste1500", "222 S Riverside Plz Ste1501",
    "222 S Riverside Plz", "222 S Riverside Plz 1500", "222 S Riverside Plz Ste01500",
    "222 S Riverside Plz Ste1500 Floor2", "222 S Riverside Plz Annex Ste1500", "222 S Riverside Place Ste1500",
  ])("keeps Plaza civic, direction, suffix and complete unit exact: %s", addressLine1 => {
    expect(sameRegistryStreet(plaza, { ...plz, addressLine1 })).toBe(false);
  });
  it.each([
    ["222 Plaza Road", "222 Plz Road"], ["222 Plaza Riverside", "222 Plz Riverside"],
    ["222 Riverside Plaza West", "222 Riverside Plz West"], ["Plaza 222", "Plz 222"],
    ["222 Riverside Plaza Building 2", "222 Riverside Plz Building 2"],
  ])("never expands arbitrary Plaza tokens or compound tails: %s / %s", (left, right) => {
    expect(sameRegistryStreet({ ...plaza, addressLine1: left, addressLine2: undefined }, { ...plz, addressLine1: right })).toBe(false);
  });
  it.each([{ state: undefined }, { state: "TX" }, { countryCode: undefined }, { countryCode: "CA" }])("requires explicit shared US geography for Plaza: %j", override => {
    expect(sameRegistryStreet(plaza, { ...plz, ...override })).toBe(false);
    expect(sameRegistryStreet({ ...plaza, ...override }, plz)).toBe(false);
  });
  it.each([
    [suite, compact, "TX", "77058"], [plaza, plz, "IL", "60606"],
  ])("retains legal, full-address, ZIP and source-content gates", (address, sourceAddress, state, postalCode) => {
    const sample = registryFixture();
    const sourceIdentity = { ...identity, ...sourceAddress, state, postalCode, countryCode: "US" as const };
    const sourceRow = { ...sourceIdentity, drivers: 42, power_units: 0 }, evidence = JSON.stringify(sourceRow);
    const item = parseRegistryFinding({ ...sample, evidence, registryProfile: { ...sample.registryProfile, identity: sourceIdentity, provenance: { ...sample.registryProfile.provenance, sourceRow, quote: evidence } } }, now);
    const ctx = { ...context, addresses: [{ ...context.addresses[0], ...address, state, postalCode }] };
    const original = JSON.stringify(item), hash = registryContentHash(item.profile, item.sourceUrl);
    expect(verifyRegistryIdentity(item.profile, { name: identity.legalName }, ctx, [], now)?.method).toBe("exact_legal_name_address");
    for (const override of [{ postalCode: "99999" }, { state: "AZ" }, { countryCode: "CA" }, { countryCode: undefined }]) {
      expect(verifyRegistryIdentity(item.profile, { name: identity.legalName }, { ...ctx, addresses: [{ ...ctx.addresses[0], ...override }] }, [], now)).toBeNull();
    }
    for (const name of ["Other Acme Logistics Inc", "Acme Logistics LLC"]) expect(verifyRegistryIdentity(item.profile, { name }, ctx, [], now)).toBeNull();
    expect(verifyRegistryIdentity(item.profile, { name: identity.legalName }, { ...ctx, addresses: [] }, [], now)).toBeNull();
    expect(JSON.stringify(item)).toBe(original);
    expect(registryContentHash(item.profile, item.sourceUrl)).toBe(hash);
  });
});


describe("street-suffix versus secondary-designator boundaries", () => {
  it.each(["1322 Space Park Drive #2", "1322 Space Park Drive Ste2"])("does not broaden hyphen matching when line 1 already labels a unit: %s", addressLine1 => {
    const base = { addressLine1, state: "TX", countryCode: "US" };
    expect(sameRegistryStreet({ ...base, addressLine2: "Suite C-245" }, { ...base, addressLine2: "Suite C245" })).toBe(false);
  });
  it.each([
    [{ addressLine1: "222 Riverside", addressLine2: "Plaza" }, { addressLine1: "222 Riverside Plz" }],
    [{ addressLine1: "222 Riverside Rd Suite Foo Plaza" }, { addressLine1: "222 Riverside Rd Suite Foo Plz" }],
    [{ addressLine1: "222 Riverside Rd Building 2 Plaza" }, { addressLine1: "222 Riverside Rd Building 2 Plz" }],
    [{ addressLine1: "222 Riverside Rd Floor 2 Plaza" }, { addressLine1: "222 Riverside Rd Floor 2 Plz" }],
    [{ addressLine1: "222 Riverside Plaza", addressLine2: "Building 2" }, { addressLine1: "222 Riverside Plz", addressLine2: "Building 2" }],
  ])("does not confuse Plaza with an appended building/unit name or second address line", (left, right) => {
    expect(sameRegistryStreet({ ...left, state: "IL", countryCode: "US" }, { ...right, state: "IL", countryCode: "US" })).toBe(false);
  });
});
