import { describe, expect, it } from "vitest";
import { normalizeIncCompanyName, normalizeIncDomain, validateInc5000Match } from "./inc5000";

const company = { id: "1", name: "Main Street Health, LLC", domain: "mainstreetruralhealth.com", city: "Nashville", state: "TN" };
const base = { companyId: "1", companyName: "Main Street Health", incName: "Main Street Health", profileUrl: "https://www.inc.com/profile/main-street-health" };

describe("Inc. 5000 matching", () => {
  it("normalizes legal suffixes and domains", () => {
    expect(normalizeIncCompanyName("The Example & Company, LLC")).toBe("example");
    expect(normalizeIncDomain("https://www.Example.com/about")).toBe("example.com");
  });
  it("accepts an official website domain match even across a rebrand", () => {
    expect(validateInc5000Match(company, { ...base, incName: "Different DBA", incWebsite: "https://www.mainstreetruralhealth.com" })).toMatchObject({ ok: true, method: "official_website_domain" });
  });
  it("accepts an exact non-generic company name", () => {
    expect(validateInc5000Match(company, base)).toMatchObject({ ok: true, method: "unique_exact_name" });
  });
  it("rejects a generic one-word name without corroboration", () => {
    expect(validateInc5000Match({ id: "2", name: "Arcadia" }, { ...base, companyId: "2", companyName: "Arcadia", incName: "Arcadia", profileUrl: "https://www.inc.com/profile/arcadia" })).toMatchObject({ ok: false, reason: "generic_name_without_domain_or_location" });
  });
  it("rejects non-Inc source URLs", () => {
    expect(validateInc5000Match(company, { ...base, profileUrl: "https://example.com" })).toMatchObject({ ok: false, reason: "invalid_inc_profile_url" });
  });
});
