import { describe, expect, it } from "vitest";
import { compareIdentityAddresses, decideIdentityMatch, isPlausibleIdentityCandidate, normalizeDomain, normalizeName, normalizeStreetAddress, plausibleIdentityName } from "./identity";
import type { CompanyIdentityAddress } from "./types";

const address: CompanyIdentityAddress = { addressLine1: "1200 North Main Street Suite 200", city: "Austin", state: "Texas", postalCode: "78701",
  countryCode: "United States", sourceKind: "netsuite_record", sourceId: "record-123", capturedAt: "2026-09-19T00:00:00Z" };

describe("public-growth identity matching", () => {
  it("normalizes legal suffixes and domains", () => {
    expect(normalizeName("The Acme Staffing, LLC")).toBe("acme staffing");
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
  });
  it("preserves parent/subsidiary and interior name distinctions", () => {
    expect(normalizeName("Acme Holdings, Inc.")).toBe("acme holdings");
    expect(normalizeName("Acme Group LLC")).toBe("acme group");
    expect(normalizeName("Co Design LLC")).toBe("co design");
    expect(normalizeName("Smith & Jones Corporation")).toBe(normalizeName("Smith and Jones Corp"));
    expect(normalizeName("Smith Jones Corporation")).not.toBe(normalizeName("Smith and Jones Corp"));
  });
  it.each(["not a website", "N/A", "none", "mailto:hello@acme.com", "ftp://acme.com", "https://name:password@acme.com", "127.0.0.1"])("does not turn malformed/shared placeholders into website identity: %s", (value) => {
    expect(normalizeDomain(value)).toBeNull();
  });
  it("does not turn a shared corporate domain into a direct parent/subsidiary match", () => {
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: "acme.com" }, { legalName: "Acme Holdings LLC", domain: "https://www.acme.com" }))
      .toMatchObject({ status: "pending", method: "domain_only" });
  });
  it("keeps matching names with conflicting official domains unresolved", () => {
    const d = decideIdentityMatch({ id: "1", name: "Acme Staffing", domain: "acmestaffing.com", state: "TX" }, { legalName: "Acme Staffing LLC", domain: "otheracme.com", state: "TX" });
    expect(d).toMatchObject({ status: "pending", method: "conflict" });
  });
  it("keeps a generic name-only match pending", () => {
    expect(decideIdentityMatch({ id: "1", name: "Business Services", domain: null }, { legalName: "Business Services LLC" })).toMatchObject({ status: "pending", method: "name_only" });
  });
  it("accepts a sourced legal alias and website despite a historical/branch address mismatch", () => {
    const d = decideIdentityMatch({ id: "1", name: "Acme Brand", legalNames: ["Acme Services LLC"], domain: "acme.com", addresses: [address] },
      { legalName: "Acme Services, Inc", domain: "https://www.acme.com", addressLine1: "500 Other Road", city: "Denver", state: "CO", postalCode: "80202" });
    expect(d).toMatchObject({ status: "verified", method: "domain", evidence: { addressMatch: false, nameMatch: true } });
  });
  it("accepts exact legal/DBA names with normalized sourced street/location when the provider has no website", () => {
    expect(normalizeStreetAddress(address.addressLine1)).toBe(normalizeStreetAddress("1200 N Main St #200"));
    const d = decideIdentityMatch({ id: "1", name: "Acme", domain: "acme.com", addresses: [address] },
      { legalName: "Other Legal", dbaName: "Acme LLC", addressLine1: "1200 N Main St #200", city: "Austin", state: "TX", postalCode: "78701-1234", countryCode: "USA" });
    expect(d).toMatchObject({ status: "verified", method: "exact_name_address", evidence: { addressMatch: true } });
    expect(JSON.stringify(d.evidence)).not.toMatch(/1200|78701|North Main|Suite 200/);
    expect(d.evidence.addressEvidence).toEqual([expect.objectContaining({ sourceKind: "netsuite_record", sourceId: "record-123", streetMatch: true, postalMatch: true })]);
  });
  it("can use a documented branch address without overwriting or requiring the headquarters address", () => {
    const d = decideIdentityMatch({ id: "1", name: "Acme", domain: null, addresses: [address,
      { ...address, addressLine1: "900 Market Road", city: "Dallas", state: "TX", postalCode: "75201", sourceKind: "company_website", sourceId: "branch-page" }] },
      { legalName: "Acme LLC", addressLine1: "900 Market Rd", city: "Dallas", state: "TX", postalCode: "75201" });
    expect(d).toMatchObject({ status: "verified", method: "exact_name_address" });
  });
  it("matches an undelimited NetSuite ZIP+4 to the provider's five-digit ZIP", () => {
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: null, addresses: [{ ...address, postalCode: "787011234" }] },
      { legalName: "Acme LLC", addressLine1: "1200 N Main St #200", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" }))
      .toMatchObject({ status: "verified", method: "exact_name_address" });
  });
  it.each([{ state: "TX" }, { city: "Austin", state: "TX" }])("never verifies name and coarse location alone: %j", (location) => {
    expect(decideIdentityMatch({ id: "1", name: "Acme Aerospace", domain: null, city: "Austin", state: "TX" },
      { legalName: "Acme Aerospace LLC", ...location }).status).toBe("pending");
  });
  it.each([
    { addressLine1: "1200 N Main St #300", postalCode: "78701", countryCode: "US" },
    { addressLine1: "1200 N Main St #200", postalCode: "78701", countryCode: "CA" },
    { addressLine1: "1200 N Main St #200", postalCode: "78799", countryCode: "US" },
  ])("does not verify a conflicting suite, postcode or country through a partial address match: %j", (candidate) => {
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: null, addresses: [address] },
      { legalName: "Acme LLC", city: "Austin", state: "TX", ...candidate }).status).toBe("pending");
  });
  it("does not identify a company by its social-platform host or an address without a legal-name match", () => {
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: "linkedin.com/company/acme" },
      { legalName: "Acme LLC", domain: "linkedin.com/company/other" }).status).toBe("pending");
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: null, addresses: [address] },
      { legalName: "Different Business", addressLine1: address.addressLine1, city: address.city, state: address.state, postalCode: address.postalCode }).status).toBe("rejected");
  });
  it("compares an inline suite against a separate provider address line without losing the unit", () => {
    const company = { id: "1", name: "Acme", domain: null, addresses: [address] };
    const candidate = { legalName: "Acme LLC", addressLine1: "1200 N Main St", addressLine2: "Ste 200", postalCode: "78701" };
    expect(compareIdentityAddresses(company, candidate)[0]).toMatchObject({ streetMatch: true, unitMatch: true, unitConflict: false, unitMissingOn: null, supportsIdentity: true });
    expect(decideIdentityMatch(company, candidate)).toMatchObject({ status: "verified", method: "exact_name_address" });
    expect(JSON.stringify(compareIdentityAddresses(company, candidate))).not.toMatch(/1200|78701|Ste 200|Main/);
  });
  it("distinguishes a missing unit on either side from explicit conflicting units", () => {
    const candidate = { legalName: "Acme", addressLine1: "1200 N Main St", postalCode: "78701" };
    expect(compareIdentityAddresses({ addresses: [address] }, candidate)[0]).toMatchObject({ streetMatch: true, unitConflict: false, unitMissingOn: "candidate", supportsIdentity: false });
    expect(compareIdentityAddresses({ addresses: [{ ...address, addressLine1: "1200 N Main St" }] }, { ...candidate, addressLine2: "Suite 200" })[0])
      .toMatchObject({ unitConflict: false, unitMissingOn: "company", supportsIdentity: false });
    expect(compareIdentityAddresses({ addresses: [address] }, { ...candidate, addressLine2: "Suite 300" })[0])
      .toMatchObject({ streetMatch: true, unitConflict: true, unitMissingOn: null, supportsIdentity: false });
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: null, addresses: [address] }, candidate).status).toBe("pending");
  });
  it("retains conflicting historical comparisons alongside a supported branch without rewriting either address", () => {
    const addresses = [address, { ...address, addressLine1: "900 Market Road", addressLine2: "Floor 2", city: "Dallas", postalCode: "75201", sourceId: "current-branch" }];
    const before = JSON.stringify(addresses);
    const candidate = { legalName: "Acme", addressLine1: "900 Market Rd Fl 2", city: "Dallas", state: "TX", postalCode: "75201" };
    const comparisons = compareIdentityAddresses({ addresses }, candidate);
    expect(comparisons).toEqual([expect.objectContaining({ sourceId: "record-123", streetConflict: true, cityConflict: true, postalConflict: true, supportsIdentity: false }),
      expect.objectContaining({ sourceId: "current-branch", streetMatch: true, unitMatch: true, supportsIdentity: true })]);
    expect(JSON.stringify(addresses)).toBe(before);
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: "acme.test", addresses }, { ...candidate, domain: "another.test" }))
      .toMatchObject({ status: "pending", method: "conflict", evidence: { addressMatch: true, domainConflict: true } });
  });
  it.each([
    ["Acme Staffing", "ACME Staffing Services LLC"],
    ["Blue Heron Consulting", "Consulting Blue Heron, Inc."],
    ["Pine Valley Mgmt", "Pine Valley Management Corporation"],
    ["Bright-Line Media", "Brightline Media Inc."],
    ["Acme", "Acme Holdings LLC"],
  ])("retrieves plausible lexical variants without treating them as verified identities: %s / %s", (name, legalName) => {
    expect(plausibleIdentityName(name, legalName)).toBe(true);
    const company = { id: "1", name, domain: null, addresses: [address] };
    const candidate = { legalName, addressLine1: address.addressLine1, postalCode: address.postalCode };
    expect(isPlausibleIdentityCandidate(company, candidate)).toBe(true);
    expect(decideIdentityMatch(company, candidate)).toMatchObject({ status: "pending", method: "name_candidate" });
  });
  it.each([
    ["Global Services", "Quality Services"], ["Acme Staffing", "Acme Bakery"], ["Alpha Design", "Beta Design"],
    ["Interstate", "Interstatewide"], ["Acme", "x".repeat(501)], ["", "Acme"], ["HKS", "HKS Architects"],
  ])("does not fetch arbitrary unrelated/overlong names based on generic words: %s / %s", (a, b) => {
    expect(plausibleIdentityName(a, b)).toBe(false);
  });
  it("admits a sourced alias or exact official domain for detail while refusing shared-platform domains", () => {
    expect(isPlausibleIdentityCandidate({ name: "New Brand", legalNames: ["Old Brand Management"], domain: null }, { legalName: "Old Brand Mgmt LLC" })).toBe(true);
    expect(isPlausibleIdentityCandidate({ name: "New Brand", domain: "brand.test" }, { legalName: "Distinct Legal Entity", domain: "www.brand.test" })).toBe(true);
    expect(isPlausibleIdentityCandidate({ name: "New Brand", domain: "linkedin.com" }, { legalName: "Distinct Legal Entity", domain: "linkedin.com" })).toBe(false);
  });
});
