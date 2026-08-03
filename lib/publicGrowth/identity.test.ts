import { describe, expect, it } from "vitest";
import { decideIdentityMatch, normalizeDomain, normalizeName } from "./identity";

describe("public-growth identity matching", () => {
  it("normalizes legal suffixes and domains", () => {
    expect(normalizeName("The Acme Staffing, LLC")).toBe("acme staffing");
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
  });
  it("verifies an exact domain even when the government legal name differs", () => {
    expect(decideIdentityMatch({ id: "1", name: "Acme", domain: "acme.com" }, { legalName: "Acme Holdings LLC", domain: "https://www.acme.com" }).status).toBe("verified");
  });
  it("rejects a matching name with a conflicting official domain", () => {
    const d = decideIdentityMatch({ id: "1", name: "Acme Staffing", domain: "acmestaffing.com", state: "TX" }, { legalName: "Acme Staffing LLC", domain: "otheracme.com", state: "TX" });
    expect(d).toMatchObject({ status: "rejected", method: "conflict" });
  });
  it("keeps a generic name-only match pending", () => {
    expect(decideIdentityMatch({ id: "1", name: "Business Services", domain: null }, { legalName: "Business Services LLC" })).toMatchObject({ status: "pending", method: "name_only" });
  });
});

