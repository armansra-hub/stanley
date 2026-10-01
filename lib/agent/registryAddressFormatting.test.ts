import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryStreet, verifyRegistryIdentity } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

const us = (addressLine1: string, addressLine2?: string) => ({ addressLine1, ...(addressLine2 ? { addressLine2 } : {}), city: "Eagle", state: "CO", countryCode: "US" });
const pairs = [
  [us("1117 Miners Aly"), us("1117 Miners Alley")],
  [us("1115 Chambers Ave", "D101"), us("1115 Chambers Avenue # D101")],
  [us("10064 S 134 Street"), us("10064 South 134th St")],
  [us("12424 Ironwood Circle Stuite 102"), us("12424 IRONWOOD CIRCLE STE 102")],
];

describe("bounded US comparison-only address notation", () => {
  it.each(pairs)("accepts the exact formatting pair, symmetrically", (left, right) => {
    const before = JSON.stringify([left, right]), prints = [registryStreet(left), registryStreet(right)];
    expect(sameRegistryStreet(left, right)).toBe(true);
    expect(sameRegistryStreet(right, left)).toBe(true);
    expect(JSON.stringify([left, right])).toBe(before);
    expect([registryStreet(left), registryStreet(right)]).toEqual(prints);
    expect(prints[0]).not.toBe(prints[1]);
  });
  it.each(pairs)("requires explicit US geography for the new comparison", (left, right) => {
    expect(sameRegistryStreet({ ...left, countryCode: "CA" }, { ...right, countryCode: "CA" })).toBe(false);
    expect(sameRegistryStreet({ ...left, countryCode: undefined }, { ...right, countryCode: undefined })).toBe(false);
    expect(sameRegistryStreet({ ...left, state: "UT" }, right)).toBe(false);
    expect(sameRegistryStreet({ ...left, state: undefined }, right)).toBe(false);
    expect(sameRegistryStreet({ ...left, city: "Denver" }, right)).toBe(false);
    expect(sameRegistryStreet({ ...left, city: undefined }, right)).toBe(false);
    expect(sameRegistryStreet({ ...left, countryCode: undefined }, right)).toBe(true);
  });
  it.each([
    [us("1117 Miners Aly"), us("1118 Miners Alley")],
    [us("1117 Miners Aly W"), us("1117 Miners Alley E")],
    [us("1117 Miners Aly", "Suite 2"), us("1117 Miners Alley", "Suite 3")],
    [us("1117 Miners Aly", "Suite 2"), us("1117 Miners Alley")],
    [us("1117 Aly Lane"), us("1117 Alley Lane")],
    [us("1117 Miners", "Aly"), us("1117 Miners", "Alley")],
    [us("1117 Miners Aly", "PMB 2"), us("1117 Miners Alley", "Suite 2")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave # D102")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave # D0101")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave Suite D101")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave PMB D101")],
    [us("1115 Chambers Ave", "D101"), us("1115 Chambers Ave Floor D101")],
    [us("1115 Chambers Ave D101"), us("1115 Chambers Ave # D101")],
    [us("1115 Chambers Ave", "D101-102"), us("1115 Chambers Ave # D101")],
    [us("1115 Chambers Ave Suite 2", "D101"), us("1115 Chambers Ave Suite 2 # D101")],
    [us("10064 S 134 Street"), us("10064 S 134st Street")],
    [us("10064 S 134 Street"), us("10064 N 134th Street")],
    [us("10064 S 134 Street"), us("10065 S 134th Street")],
    [us("10064 S 134 Street"), us("10064 S 135th Street")],
    [us("10064 S 134 Street"), us("10064 S 0134th Street")],
    [us("10064 S 134 Street"), us("10064 S 134th Avenue")],
    [us("134 Example Street"), us("134th Example Street")],
    [us("100 Example Street Suite 134"), us("100 Example Street Suite 134th")],
    [us("10064 Route 134 Street"), us("10064 Route 134th Street")],
    [us("100 First Street"), us("100 1 Street")],
    [us("10064 S 134-135 Street"), us("10064 S 134th Street")],
    [us("12424 Ironwood Circle Stuite 102"), us("12424 Ironwood Circle Suite 103")],
    [us("12424 Ironwood Circle Stuite 102"), us("12424 Ironwood Circle Suite 0102")],
    [us("12424 Ironwood Circle Stuite 102"), us("12421 Ironwood Circle Suite 102")],
    [us("12424 Ironwood Circle Stuite 102"), us("12424 Ironwood Circle")],
    [us("12424 Ironwood Circle Stuite 102"), us("12424 Ironwood Circle Unit 102")],
    [us("12424 Ironwood Circle Stuite 102"), us("12424 Ironwood Circle PMB 102")],
    [us("12424 Stuite Road"), us("12424 Suite Road")],
    [us("12424 Ironwood Circle Stuite 102-103"), us("12424 Ironwood Circle Suite 102")],
    [us("12424 Ironwood Circle Stuite 102 Floor 2"), us("12424 Ironwood Circle Suite 102")],
  ])("rejects a substantive or unsupported address difference", (left, right) => {
    expect(sameRegistryStreet(left, right)).toBe(false);
    expect(sameRegistryStreet(right, left)).toBe(false);
  });
  it.each([
    ["11", "11th"], ["12", "12th"], ["13", "13th"], ["21", "21st"], ["22", "22nd"], ["23", "23rd"], ["111", "111th"],
  ])("validates numeric street ordinal spelling: %s / %s", (number, ordinal) => {
    expect(sameRegistryStreet(us("100 " + number + " Street"), us("100 " + ordinal + " St"))).toBe(true);
  });
  it("allows a labelled second-line Stuite typo without changing a different unit role", () => {
    expect(sameRegistryStreet(us("12424 Ironwood Circle", "Stuite 102"), us("12424 Ironwood Cir Suite 102"))).toBe(true);
    expect(sameRegistryStreet(us("12424 Ironwood Circle", "Stuite 102"), us("12424 Ironwood Cir Apt 102"))).toBe(false);
  });
});

describe("full registry identity gates remain required", () => {
  const now = new Date("2026-10-01T03:00:00Z");
  it.each(pairs)("retains legal name, locality, postal code and original content", (left, right) => {
    const identity = { ...left, countryCode: "US", legalName: "Example Services LLC", city: "Eagle", postalCode: "81631" };
    const sourceRow = { ...identity, registration_number: "123" };
    const evidence = JSON.stringify(sourceRow);
    const input = { source: "registry", kind: "ops_profile", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123",
      sourceUrl: "https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=123", detail: "Dated registration, not current revenue or staffing.", evidence,
      registryProfile: { version: 1, dataset: "co_sos", recordId: "123", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T22:00:00Z",
        facts: [{ field: "registration_number", value: "123" }], identity, provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } };
    const parsed = parseRegistryFinding(input, now), before = JSON.stringify(input);
    const hash = registryContentHash(parsed.profile, parsed.sourceUrl, parsed.detail);
    const address = { ...right, countryCode: "US" as const, city: "Eagle", postalCode: "81631", sourceKind: "netsuite_record" as const, sourceId: "record-1", capturedAt: "2026-09-28T00:00:00Z" };
    const context: CompanyIdentityContext = { aliases: [], addresses: [address], context: "" };
    expect(verifyRegistryIdentity(parsed.profile, { name: "Example Services LLC" }, context, [], now)?.method).toBe("exact_legal_name_address");
    for (const patch of [{ city: "Denver" }, { postalCode: "81632" }, { state: "UT" }, { countryCode: "CA" as const }]) {
      expect(verifyRegistryIdentity(parsed.profile, { name: "Example Services LLC" }, { ...context, addresses: [{ ...address, ...patch }] }, [], now)).toBeNull();
    }
    expect(verifyRegistryIdentity(parsed.profile, { name: "Other Services LLC" }, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity(parsed.profile, { name: "Example Services Inc" }, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity(parsed.profile, { name: "Example Services LLC" }, { ...context, addresses: [] }, [], now)).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
    expect(registryContentHash(parsed.profile, parsed.sourceUrl, parsed.detail)).toBe(hash);
  });
});
