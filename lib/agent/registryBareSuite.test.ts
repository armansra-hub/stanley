import { describe, expect, it } from "vitest";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, verifyRegistryIdentity } from "./registryProfiles";

const now = new Date("2026-10-01T08:00:00Z");
const bare = { addressLine1: "120 East Cedar Avenue B-223", city: "Denver", state: "CO", countryCode: "US" };
const explicit = { ...bare, addressLine1: "120 E Cedar Ave Ste B223" };
function fixture() {
  const identity = { ...bare, legalName: "Example Logistics Inc", postalCode: "80231", countryCode: "US" as const };
  const sourceRow = { ...identity, drivers: 2 }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "ops_profile", source: "registry",
    detail: "Historical reported drivers, not total employees.", evidence, sourceUrl: "https://data.transportation.gov/resource/test.json",
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: "2026-10-01T00:00:00Z",
      facts: [{ field: "drivers", value: 2 }], identity, provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
}

describe("terminal bare letter-hyphen suite against an explicit suite", () => {
  it.each([
    explicit,
    { ...explicit, addressLine1: "120 E Cedar Avenue, Suite B-223" },
    { ...explicit, addressLine1: "120 East Cedar Ave", addressLine2: "Ste. b223" },
  ])("compares complete street and identical unit symmetrically", other => {
    expect(sameRegistryStreet(bare, other)).toBe(true);
    expect(sameRegistryStreet(other, bare)).toBe(true);
  });
  it("allows the existing omitted US source default only with an explicit US counterpart", () => {
    expect(sameRegistryStreet({ ...bare, countryCode: undefined }, explicit)).toBe(true);
    expect(sameRegistryStreet({ ...bare, countryCode: undefined }, { ...explicit, countryCode: undefined })).toBe(false);
  });
  it.each([
    "120 East Cedar Avenue B223", "120 East Cedar Avenue 223", "120 East Cedar Avenue BB-223",
    "120 East Cedar Avenue B-0223", "120 East Cedar Avenue B-223-224", "120 East Cedar Avenue B-223 Floor 2",
    "120 East Cedar Avenue Building B-223", "120 East Cedar Avenue Floor B-223", "120 East Cedar Avenue PMB B-223",
    "120 East Cedar Avenue Unit 4 B-223", "120 East Cedar Avenue #4 B-223", "120 East Cedar B-223",
    "120 East Cedar Highway B-223", "PO Box 120 B-223", "120 East Cedar Avenue B–223",
  ])("does not infer an ambiguous or compound unit: %s", addressLine1 => {
    expect(sameRegistryStreet({ ...bare, addressLine1 }, explicit)).toBe(false);
  });
  it.each([
    "120 E Cedar Ave Ste B224", "120 E Cedar Ave Ste C223", "120 E Cedar Ave Ste B0223",
    "120 E Cedar Ave Unit B223", "120 E Cedar Ave Building B223", "120 E Cedar Ave Floor B223",
    "120 E Cedar Ave Ste B223 Floor 2", "121 E Cedar Ave Ste B223", "120 W Cedar Ave Ste B223",
    "120 E Cedar Road Ste B223", "120 E Cedars Ave Ste B223",
  ])("keeps the counterpart's exact role, unit and every street token: %s", addressLine1 => {
    expect(sameRegistryStreet(bare, { ...explicit, addressLine1 })).toBe(false);
  });
  it.each([{ city: "Boulder" }, { city: undefined }, { state: "AZ" }, { state: undefined }, { countryCode: "CA" },
    { addressLine2: "Floor 2" }, { addressLine2: "Ste B223" }])("preserves geography and additional lines", change => {
    expect(sameRegistryStreet({ ...bare, ...change }, explicit)).toBe(false);
  });
  it("preserves fingerprints, source content and full legal/postal identity gates", () => {
    const row = fixture(), before = JSON.stringify(row), hash = registryContentHash(row.profile, row.sourceUrl, row.detail);
    const context: CompanyIdentityContext = { aliases: [], context: "", addresses: [{ ...explicit, postalCode: "80231",
      sourceKind: "netsuite_record", sourceId: "record-1", capturedAt: "2026-09-30T00:00:00Z" }] };
    expect(verifyRegistryIdentity(row.profile, { name: "Example Logistics Inc" }, context, [], now)?.method).toBe("exact_legal_name_address");
    for (const name of ["Example Logistics LLC", "Other Logistics Inc", "Example Logistics Holdings Inc"]) {
      expect(verifyRegistryIdentity(row.profile, { name }, context, [], now)).toBeNull();
    }
    for (const change of [{ postalCode: "80232" }, { state: "AZ" }, { countryCode: "CA" }, { city: "Boulder" }, { addressLine1: "120 E Cedar Ave Ste B224" }]) {
      expect(verifyRegistryIdentity(row.profile, { name: "Example Logistics Inc" }, { ...context, addresses: [{ ...context.addresses[0], ...change }] }, [], now)).toBeNull();
    }
    expect(registryStreet(bare)).toBe("120 e cedar ave b 223");
    expect(registryStreet(explicit)).toBe("120 e cedar ave unit b223");
    expect(JSON.stringify(row)).toBe(before);
    expect(registryContentHash(row.profile, row.sourceUrl, row.detail)).toBe(hash);
  });
});
