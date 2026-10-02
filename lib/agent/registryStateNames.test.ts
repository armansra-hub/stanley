import { describe, expect, it } from "vitest";
import { registryContentHash, registryStreet, verifyRegistryIdentity, type RegistryProfile } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

const profile: RegistryProfile = {
  version: 1, dataset: "fmcsa", recordId: "123456", sourceAsOf: "2026-02-23", observedAt: "2026-09-29T23:00:00Z", facts: [],
  identity: { legalName: "Example Towing LLC", addressLine1: "12605 W NORTH AVE SUITE 249", city: "BROOKFIELD", state: "WI", postalCode: "53005", countryCode: "US" },
  provenance: { rowSha256: "a".repeat(64), quote: "synthetic unit-test source", sourceRow: {} },
};
const address: CompanyIdentityContext["addresses"][number] = { addressLine1: "12605 W North Ave Suite 249", city: "Brookfield", state: "Wisconsin", postalCode: "53005", countryCode: "US", sourceKind: "company_website", sourceId: "test-address", capturedAt: "2026-09-27T00:00:00Z" };
const context: CompanyIdentityContext = { aliases: [], context: "", addresses: [address] };
const now = new Date("2026-10-01T00:00:00Z");
const check = (source = profile, ctx = context, name = profile.identity.legalName) => verifyRegistryIdentity(source, { name }, ctx, [], now);

describe("explicit US complete state-name comparison", () => {
  it("compares WI and Wisconsin in either direction without changing source fields or hashes", () => {
    const before = JSON.stringify({ profile, context }), hash = registryContentHash(profile, "https://data.transportation.gov/test"), street = registryStreet(profile.identity);
    expect(check()?.method).toBe("exact_legal_name_address");
    expect(check()?.sourceIds).toEqual(["test-address"]);
    expect(check({ ...profile, identity: { ...profile.identity, state: "Wisconsin" } }, { ...context, addresses: [{ ...address, state: "WI" }] })?.method).toBe("exact_legal_name_address");
    expect(JSON.stringify({ profile, context })).toBe(before);
    expect(registryContentHash(profile, "https://data.transportation.gov/test")).toBe(hash);
    expect(registryStreet(profile.identity)).toBe(street);
  });
  it.each(["WA", "Washington", "New Wisconsin", "Wisc", "Wisconsin State", "Wisconsin/WI", "Wisconsin.", "Atlantis", "", "ZZ"])("rejects a different, partial or unknown state: %s", state => {
    expect(check(profile, { ...context, addresses: [{ ...address, state }] })).toBeNull();
  });
  it.each([
    { countryCode: "CA" }, { countryCode: undefined }, { countryCode: "" },
    { addressLine1: "12605 W North Ave 249" }, { addressLine1: "12605 W North Ave" },
    { addressLine1: "12605 W North Ave Suite 248" }, { addressLine1: "12606 W North Ave Suite 249" },
    { addressLine1: "12605 E North Ave Suite 249" }, { postalCode: "53006" },
  ])("preserves country, full suite, street and postal gates: %j", change => {
    expect(check(profile, { ...context, addresses: [{ ...address, ...change }] })).toBeNull();
  });
  it("does not expand states for an omitted or non-US registry country or another legal operator", () => {
    for (const countryCode of [undefined, "CA"] as const) expect(check({ ...profile, identity: { ...profile.identity, countryCode } })).toBeNull();
    expect(check(profile, context, "Example Towing Inc")).toBeNull();
    expect(check(profile, context, "Other Towing LLC")).toBeNull();
    const canadian = { ...profile, identity: { ...profile.identity, state: "AB", countryCode: "CA" as const } };
    expect(check(canadian, { ...context, addresses: [{ ...address, state: "Alberta", countryCode: "CA" }] })).toBeNull();
    expect(check(profile, { ...context, addresses: [{ ...address, state: "WI" }] })?.method).toBe("exact_legal_name_address");
  });
});
