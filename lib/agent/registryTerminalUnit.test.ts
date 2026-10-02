import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, verifyRegistryIdentity } from "./registryProfiles";

const now = new Date("2026-10-01T09:00:00Z");
const geo = { city: "Denver", state: "CO", countryCode: "US" };
const bare = { ...geo, addressLine1: "120 E Cedar Avenue 306" };
const labelled = { ...geo, addressLine1: "120 East Cedar Ave, Suite 306" };

describe("identical terminal atomic unit with an explicit counterpart", () => {
  it.each(["Suite 306", "Ste. 306", "APT 306", "Apartment 306", "Unit 306", "#306", "# 306"])("retains the complete numeric unit against %s", unit => {
    const a = { ...geo, addressLine1: "120 East Cedar Ave " + unit };
    const b = { ...geo, addressLine1: "120 East Cedar Ave", addressLine2: unit };
    for (const other of [a, b]) {
      expect(sameRegistryStreet(bare, other)).toBe(true);
      expect(sameRegistryStreet(other, bare)).toBe(true);
    }
  });
  it("compares one nondirectional unit letter without changing fingerprints", () => {
    const a = { ...geo, addressLine1: "120 E Cedar Ave C" }, b = { ...geo, addressLine1: "120 East Cedar Avenue Ste C" };
    expect(sameRegistryStreet(a, b)).toBe(true);
    expect(sameRegistryStreet(b, a)).toBe(true);
    expect(registryStreet(a)).toBe("120 e cedar ave c");
    expect(registryStreet(b)).toBe("120 e cedar ave unit c");
  });
  it.each([
    "120 E Cedar Ave", "120 E Cedar Ave 307", "120 E Cedar Ave 0306", "120 E Cedar Ave 0",
    "120 E Cedar Ave 306-307", "120 E Cedar Ave 306/307", "120 E Cedar Ave 306 Floor 2",
    "120 E Cedar Ave PMB 306", "120 E Cedar Ave Building 306", "120 E Cedar Ave Floor 306",
    "120 E Cedar Ave Unit 4 306", "120 E Cedar Ave #4 306", "120 E Cedar Ave Room 306",
    "120 E Cedar 306", "120 E Cedar Highway 306", "PO Box 120 306",
    "120 W Cedar Ave 306", "121 E Cedar Ave 306", "120 E Cedars Ave 306", "120 E Cedar Road 306",
  ])("rejects incomplete, conflicting or compound bare addresses: %s", addressLine1 => {
    expect(sameRegistryStreet({ ...bare, addressLine1 }, labelled)).toBe(false);
  });
  it.each([
    "120 E Cedar Ave Suite 307", "120 E Cedar Ave Apt 0306", "120 E Cedar Ave PMB 306",
    "120 E Cedar Ave Building 306", "120 E Cedar Ave Floor 306", "120 E Cedar Ave Room 306",
    "120 E Cedar Ave Suite 306/307", "120 E Cedar Ave Suite 306 Floor 2", "120 E Cedar Ave #306 North",
  ])("does not invent a role or discard counterpart tokens: %s", addressLine1 => {
    expect(sameRegistryStreet(bare, { ...labelled, addressLine1 })).toBe(false);
  });
  it.each(["N", "S", "E", "W", "NE", "NW", "SE", "SW"])("rejects a direction-like bare unit %s", token => {
    expect(sameRegistryStreet({ ...bare, addressLine1: "120 Cedar Ave " + token }, { ...labelled, addressLine1: "120 Cedar Ave Suite " + token })).toBe(false);
  });
  it.each([{ city: "Boulder" }, { city: undefined }, { state: "TX" }, { countryCode: "CA" }, { addressLine2: "306" }, { addressLine2: "Suite 306" }, { addressLine2: "Floor 2" }])("preserves geography and additional lines", change => {
    expect(sameRegistryStreet({ ...bare, ...change }, labelled)).toBe(false);
  });
  it("keeps the existing omitted-US default and rejects missing geography", () => {
    expect(sameRegistryStreet({ ...bare, countryCode: undefined }, labelled)).toBe(true);
    expect(sameRegistryStreet({ ...bare, countryCode: undefined }, { ...labelled, countryCode: undefined })).toBe(false);
    expect(sameRegistryStreet({ ...bare, state: undefined }, labelled)).toBe(false);
  });
  it("preserves the earlier hyphen suite restriction and does not admit bare alphanumeric tokens", () => {
    const a = { ...bare, addressLine1: "120 E Cedar Ave B-223" };
    expect(sameRegistryStreet(a, { ...labelled, addressLine1: "120 E Cedar Ave Ste B223" })).toBe(true);
    expect(sameRegistryStreet(a, { ...labelled, addressLine1: "120 E Cedar Ave Unit B223" })).toBe(false);
    expect(sameRegistryStreet({ ...a, addressLine1: "120 E Cedar Ave B223" }, { ...labelled, addressLine1: "120 E Cedar Ave Ste B223" })).toBe(false);
  });
  it("retains full legal, postal and source integrity gates", () => {
    const identity = { ...bare, legalName: "Example Services Inc", postalCode: "80231", countryCode: "US" as const };
    const sourceRow = { ...identity, drivers: 2 }, evidence = JSON.stringify(sourceRow);
    const row = parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "ops_profile", source: "registry",
      detail: "Dated source report, not current employee count.", evidence, sourceUrl: "https://data.transportation.gov/resource/test.json",
      registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: "2026-10-01T00:00:00Z",
        facts: [{ field: "drivers", value: 2 }], identity, provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
    const address = { ...labelled, postalCode: "80231", sourceKind: "netsuite_record" as const, sourceId: "record-1", capturedAt: "2026-09-30T00:00:00Z" };
    const context = { aliases: [], context: "", addresses: [address] }, before = JSON.stringify(row), hash = registryContentHash(row.profile, row.sourceUrl, row.detail);
    expect(verifyRegistryIdentity(row.profile, { name: "Example Services Inc" }, context, [], now)?.method).toBe("exact_legal_name_address");
    for (const name of ["Other Services Inc", "Example Services LLC", "Example Services Holdings Inc"]) expect(verifyRegistryIdentity(row.profile, { name }, context, [], now)).toBeNull();
    for (const change of [{ postalCode: "80232" }, { state: "TX" }, { countryCode: "CA" }, { city: "Boulder" }, { addressLine1: "120 E Cedar Ave Suite 307" }]) {
      expect(verifyRegistryIdentity(row.profile, { name: "Example Services Inc" }, { ...context, addresses: [{ ...address, ...change }] }, [], now)).toBeNull();
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(registryContentHash(row.profile, row.sourceUrl, row.detail)).toBe(hash);
  });
});
