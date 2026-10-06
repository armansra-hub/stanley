import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, verifyRegistryIdentity } from "./registryProfiles";

const place = { city: "Portland", state: "OR", countryCode: "US" };
const split = { ...place, addressLine1: "6225 N E 112TH AVE" };
const joined = { ...place, addressLine1: "6225 NE 112th Ave" };

describe("split compass initials before a numbered US street", () => {
  it.each([
    ["6225 N E 112TH AVE", "6225 NE 112th Ave"],
    ["6225 N W 2ND ST", "6225 NW 2nd Street"],
    ["6225 S E 3RD RD", "6225 SE 3rd Road"],
    ["6225 S W 11TH BLVD", "6225 SW 11th Boulevard"],
    ["6225 N E 112 AVE", "6225 NE 112 Avenue"],
    ["6225 N. E. 112TH AVE", "6225 NE 112th Ave"],
    ["6225 N E 112TH AVE SUITE 20", "6225 NE 112th Ave Ste 20"],
  ])("compares only the same numbered street in either direction: %s", (a: string, b: string) => {
    const left = { ...place, addressLine1: a }, right = { ...place, addressLine1: b };
    const before = JSON.stringify([left, right]);
    expect(sameRegistryStreet(left, right)).toBe(true);
    expect(sameRegistryStreet(right, left)).toBe(true);
    expect(JSON.stringify([left, right])).toBe(before);
  });
  it("preserves complete labelled second-line units and old fingerprints", () => {
    expect(sameRegistryStreet({ ...split, addressLine2: "Suite 20" }, { ...joined, addressLine2: "Ste 20" })).toBe(true);
    expect(registryStreet(split)).toBe("6225 n e 112th ave");
    expect(registryStreet(joined)).toBe("6225 ne 112th ave");
  });
  it.each([
    ["100 N E ST", "100 NE ST"],
    ["100 S W AVE", "100 SW AVE"],
    ["100 N ELM ST", "100 NELM ST"],
    ["100 N E TWELFTH ST", "100 NE TWELFTH ST"],
    ["100 N E 112RD AVE", "100 NE 112RD AVE"],
    ["100 N E 02ND AVE", "100 NE 02ND AVE"],
    ["100 N E 12-14 ST", "100 NE 12-14 ST"],
    ["100 N E 112A ST", "100 NE 112A ST"],
    ["100 E N 112TH AVE", "100 EN 112TH AVE"],
    ["N E 112TH AVE", "NE 112TH AVE"],
  ])("does not merge letter street names, invalid ordinals or arbitrary tokens: %s", (a: string, b: string) => {
    const left = { ...place, addressLine1: a }, right = { ...place, addressLine1: b };
    expect(sameRegistryStreet(left, right)).toBe(false);
    expect(sameRegistryStreet(right, left)).toBe(false);
  });
  it.each([
    { addressLine1: "6226 NE 112TH AVE" }, { addressLine1: "6225 NW 112TH AVE" },
    { addressLine1: "6225 NE 113TH AVE" }, { addressLine1: "6225 NE 112TH ST" },
    { addressLine1: "6225 112TH AVE" }, { addressLine1: "6225 NE 112TH AVE NORTH" },
    { addressLine2: "Suite 20" }, { city: "Salem" }, { city: undefined },
    { state: "WA" }, { state: undefined }, { countryCode: "CA" },
  ])("retains every other street token and the existing US geography guard: %j", (change: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; countryCode?: string }) => {
    expect(sameRegistryStreet(split, { ...joined, ...change })).toBe(false);
  });
  it("cannot consume unrelated second-line content or differing units", () => {
    for (const second of ["North", "Floor 2", "Building A", "PMB 20", "20"]) {
      expect(sameRegistryStreet({ ...split, addressLine2: second }, { ...joined, addressLine2: second })).toBe(false);
    }
    expect(sameRegistryStreet({ ...split, addressLine2: "Suite 20" }, { ...joined, addressLine2: "Suite 21" })).toBe(false);
    expect(sameRegistryStreet({ ...split, addressLine2: "Suite 020" }, { ...joined, addressLine2: "Suite 20" })).toBe(false);
  });
  it("preserves the established omitted-US-country default and unrelated exact matches", () => {
    expect(sameRegistryStreet({ ...split, countryCode: undefined }, joined)).toBe(true);
    expect(sameRegistryStreet({ ...split, countryCode: undefined }, { ...joined, countryCode: undefined })).toBe(false);
    expect(sameRegistryStreet({ addressLine1: "100 Main Street" }, { addressLine1: "100 Main St" })).toBe(true);
    expect(sameRegistryStreet({ ...split, city: "Salem" }, { ...split, city: "Portland" })).toBe(true); // unchanged legacy exact-string branch
  });
  it("retains identity, ZIP and legal-form gates without rewriting any profile bytes", () => {
    const identity = { legalName: "Example Transport Inc", ...split, countryCode: "US" as const, postalCode: "97220" };
    const sourceRow = { ...identity, usdot_number: "12345", drivers: 50 };
    const evidence = JSON.stringify(sourceRow), now = new Date("2026-10-06T12:00:00Z");
    const row = parseRegistryFinding({ source: "registry", kind: "ops_profile", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123", evidence,
      sourceUrl: "https://safer.fmcsa.dot.gov/query.asp?query_string=12345", registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: "2021-06-24", observedAt: "2026-09-29T23:14:59Z",
        identity, facts: [{ field: "usdot_number", value: "12345" }, { field: "drivers", value: 50 }], provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
    const address = { ...joined, countryCode: "US" as const, postalCode: "97220", sourceKind: "netsuite_record" as const, sourceId: "retained-record-1", capturedAt: "2026-07-28T00:00:00+00:00" };
    const context = { aliases: [], context: "", addresses: [address] };
    const before = JSON.stringify(row), hash = registryContentHash(row.profile, row.sourceUrl);
    expect(verifyRegistryIdentity(row.profile, { name: "Example Transport" }, context, [], now)?.method).toBe("exact_legal_name_address");
    for (const change of [{ postalCode: "97221" }, { countryCode: "CA" as const }, { state: "WA" }, { city: "Salem" }, { addressLine2: "Suite 20" }]) {
      expect(verifyRegistryIdentity(row.profile, { name: "Example Transport" }, { ...context, addresses: [{ ...address, ...change }] }, [], now)).toBeNull();
    }
    for (const name of ["Example Transport LLC", "Another Transport Inc"]) expect(verifyRegistryIdentity(row.profile, { name }, context, [], now)).toBeNull();
    expect(JSON.stringify(row)).toBe(before);
    expect(registryContentHash(row.profile, row.sourceUrl)).toBe(hash);
  });
});
