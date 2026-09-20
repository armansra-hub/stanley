import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { compactSamEntity } from "./sam";
import { compareIdentityAddresses } from "./identity";
import { parseSamEntityContinuation, samBindingMatches } from "./samEntityState";

describe("SAM address and existing cursor primitives", () => {
  it("preserves the second physical address line for shared unit comparison", () => {
    const sam = compactSamEntity({ entityRegistration: { legalBusinessName: "Acme", ueiSAM: "ABCDEFGHIJKL" },
      coreData: { physicalAddress: { addressLine1: "1200 N Main St", addressLine2: "Suite 300", zipCode: "78701" } } });
    expect(sam).toMatchObject({ address: "1200 N Main St", addressLine2: "Suite 300" });
    expect(compareIdentityAddresses({ addresses: [{ addressLine1: "1200 North Main Street Suite 200", postalCode: "78701",
      sourceKind: "netsuite_record", sourceId: "record", capturedAt: "2026-09-20" }] }, { ...sam, addressLine1: sam.address })[0])
      .toMatchObject({ streetMatch: true, unitConflict: true, supportsIdentity: false });
    expect(compactSamEntity({}).addressLine2).toBeNull();
  });
  it("keeps old version-one queries and exact identifier authority unchanged", () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const binding = { entityId: "22222222-2222-4222-8222-222222222222", uei: "ABCDEFGHIJKL", cageCode: "1AB23" };
    const state = { version: 1, companyId, targets: [{ query: { cageCode: "1AB23" }, binding }, { query: { legalBusinessName: "Acme" } }], targetIndex: 1, page: 3, lastPageHash: "a".repeat(64) };
    expect(parseSamEntityContinuation(state, companyId)).toEqual(state);
    expect(samBindingMatches(binding, { uei: "abcdefghijkl", cageCode: "1ab23" })).toBe(true);
    expect(samBindingMatches(binding, { uei: "ZZZZZZZZZZZZ", cageCode: "1AB23" })).toBe(false);
    expect(samBindingMatches(binding, { uei: "ABCDEFGHIJKL", cageCode: "9ZZ99" })).toBe(false);
    expect(() => parseSamEntityContinuation({ ...state, targets: [{ query: { legalBusinessName: "Acme", unknown: "field" } }] }, companyId)).toThrow();
  });
});
