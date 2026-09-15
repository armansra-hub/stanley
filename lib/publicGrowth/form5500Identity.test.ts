import { describe, expect, it } from "vitest";
import { form5500IdentitySupported, isForm5500IdentityInput, normalizeForm5500Name } from "./form5500Identity";

const id = "bd2432fc-8a61-4f86-ac06-e1a2fb61642d";
const company = { id, name: "LLP Global Inc", state: "PA", city: "Somerset" };
const row = { companyId: id, sponsorName: "GLOBAL, INC.", sponsorState: "PA", sponsorCity: "SOMERSET",
  matchMethod: "exact_name_state_city", matchConfidence: 0.98 };

describe("Form 5500 source-specific identity evidence", () => {
  it("matches the maintained Python name normalization without adopting broader government matching", () => {
    expect(normalizeForm5500Name("The A & B PLC Holdings, Inc.")).toBe("a and b");
    expect(normalizeForm5500Name("LLP Global Inc")).toBe("global");
  });

  it("accepts actual normalized state and city support", () => {
    expect(form5500IdentitySupported({ ...company, state: " pa " }, row)).toBe(true);
  });

  it.each(["CA", " ca "])("rejects explicit contradictory state %s even for name-only", (state) => {
    expect(form5500IdentitySupported({ ...company, state }, row)).toBe(false);
    expect(form5500IdentitySupported({ ...company, state }, { ...row, matchMethod: "unique_exact_name", matchConfidence: 0.91 })).toBe(false);
  });

  it.each([null, "", "Pittsburgh"])("rejects unsupported high-confidence city %s", (city) => {
    expect(form5500IdentitySupported({ ...company, city }, row)).toBe(false);
  });

  it("retains unknown-state name-only fallback at its actual confidence", () => {
    const fallback = { ...row, matchMethod: "unique_exact_name", matchConfidence: 0.91 };
    expect(form5500IdentitySupported({ ...company, state: null, city: null }, fallback)).toBe(true);
    expect(form5500IdentitySupported(company, { ...fallback, matchConfidence: 0.98 })).toBe(false);
  });

  it("allows exact DBA but never an unrelated name or wrong company ID", () => {
    expect(form5500IdentitySupported(company, { ...row, sponsorName: "Other Sponsor", sponsorDba: "Global Inc" })).toBe(true);
    expect(form5500IdentitySupported(company, { ...row, sponsorName: "Other Sponsor" })).toBe(false);
    expect(form5500IdentitySupported({ ...company, id: "4d17b1d2-deef-4798-a912-ee991025992c" }, row)).toBe(false);
  });

  it("rejects malformed JSON fields and unsupported match claims", () => {
    for (const input of [null, [], { ...row, sponsorName: {} }, { ...row, sponsorDba: 1 },
      { ...row, sponsorState: ["PA"] }, { ...row, sponsorCity: true }, { ...row, matchConfidence: "0.98" },
      { ...row, matchMethod: "exact_name_city_state" }, { ...row, matchMethod: "verified" }]) {
      expect(isForm5500IdentityInput(input)).toBe(false);
      expect(form5500IdentitySupported(company, input)).toBe(false);
    }
  });
});
