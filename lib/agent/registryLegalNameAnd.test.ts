import { describe, expect, it } from "vitest";
import { parseRegistryFinding, registryContentHash, registryStreet, sameRegistryLegalName, verifyRegistryIdentity } from "./registryProfiles";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

const now = new Date("2026-09-30T23:00:00Z");
function fixture() {
  const identity = { legalName: "Example Strategies AND Solutions, LLC", addressLine1: "275 W EXAMPLE RD STE 440", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
  const sourceRow = { ...identity, registration_number: "1234567", filing_date: "2023-10-20", lien_type: "ucc" };
  const evidence = JSON.stringify(sourceRow);
  const finding = parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "ops_profile", source: "registry",
    detail: "Historical UCC filing; no current debt or budget inferred.", sourceUrl: "https://data.colorado.gov/resource/8upq-58vz.json?debtorid=123", evidence,
    registryProfile: { version: 1, dataset: "co_ucc", recordId: "1234567:123", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T22:00:00Z",
      facts: [{ field: "registration_number", value: "1234567" }], identity, provenance: { rowSha256: "a".repeat(64), quote: evidence, sourceRow } } }, now);
  const company = { name: "Example Strategies & Solutions LLC" };
  const context: CompanyIdentityContext = { aliases: [], context: "Exact independently sourced canonical address", addresses: [{
    addressLine1: "275 W Example Road Ste 440", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US", sourceKind: "netsuite_record", sourceId: "record-1", capturedAt: "2026-09-28T00:00:00Z"
  }] };
  return { finding, company, context };
}

describe("explicit ampersand and AND in complete legal names", () => {
  it.each([
    ["Acme & Sons LLC", "ACME AND SONS, L.L.C."],
    ["Acme ＆ Sons Inc.", "Acme and Sons Incorporated"],
    ["A&B Corp", "A AND B Corporation"],
    ["Acme & Sons", "Acme AND Sons LLC"],
    ["Acme and Sons Ltd", "Acme AND Sons Limited"],
  ])("preserves a conjunction and compatible suffix: %s / %s", (a, b) => {
    expect(sameRegistryLegalName(a, b)).toBe(true);
    expect(sameRegistryLegalName(b, a)).toBe(true);
  });
  it.each([
    ["Acme & Sons LLC", "Acme Sons LLC"],
    ["Acme & Sons LLC", "Acme AND AND Sons LLC"],
    ["Acme && Sons LLC", "Acme AND Sons LLC"],
    ["Acme & Sons LLC", "Acme AND Daughters LLC"],
    ["Acme & Sons LLC", "Global Acme AND Sons LLC"],
    ["Acme & Sons LLC", "Acme AND Sons Services LLC"],
    ["Acme & Sons LLC", "Acme AND Sons Inc"],
    ["Acme & Sons LLP", "Acme AND Sons LLC"],
    ["Acme & Sons PC", "Acme AND Sons PLLC"],
    ["Candy LLC", "C&Y LLC"],
    ["AAND B LLC", "A & B LLC"],
    ["Acme & Sons LLC", "Acme plus Sons LLC"],
    ["Acme & Sons LLC", "Acme & Son LLC"],
    ["", "&"],
  ])("preserves substantive words, conjunction count and suffix distinctions: %s / %s", (a, b) => {
    expect(sameRegistryLegalName(a, b)).toBe(false);
    expect(sameRegistryLegalName(b, a)).toBe(false);
  });
  it("requires the independently sourced complete address and leaves source bytes/hashes unchanged", () => {
    const { finding, company, context } = fixture();
    const before = JSON.stringify({ finding, company, context });
    const hash = registryContentHash(finding.profile, finding.sourceUrl, finding.detail);
    expect(verifyRegistryIdentity(finding.profile, company, context, [], now)?.method).toBe("exact_legal_name_address");
    expect(verifyRegistryIdentity(finding.profile, company, { ...context, addresses: [] }, [], now)).toBeNull();
    expect(JSON.stringify({ finding, company, context })).toBe(before);
    expect(registryContentHash(finding.profile, finding.sourceUrl, finding.detail)).toBe(hash);
  });
  it.each([
    { addressLine1: "275 W Example Road Ste 441" },
    { addressLine1: "275 W Example Road" },
    { addressLine1: "276 W Example Road Ste 440" },
    { addressLine1: "275 E Example Road Ste 440" },
    { addressLine2: "Floor 2" },
    { state: "CA" },
    { postalCode: "78702" },
    { city: "Dallas", postalCode: "75201" },
    { countryCode: "CA" },
  ])("does not relax full-address/jurisdiction requirements: %j", change => {
    const { finding, company, context } = fixture();
    expect(verifyRegistryIdentity(finding.profile, company, { ...context, addresses: [{ ...context.addresses[0], ...change }] }, [], now)).toBeNull();
  });
  it.each(["Example Strategies Solutions LLC", "Example Strategies AND AND Solutions LLC", "Example Strategies & Solutions Inc", "Other Strategies & Solutions LLC"])("still rejects a changed complete legal name at admission: %s", name => {
    const { finding, context } = fixture();
    expect(verifyRegistryIdentity(finding.profile, { name }, context, [], now)).toBeNull();
  });
  it("preserves the existing postal-city alias policy, without adding city normalization", () => {
    const { finding, company, context } = fixture();
    expect(verifyRegistryIdentity(finding.profile, company, { ...context, addresses: [{ ...context.addresses[0], city: "Postal city alias" }] }, [], now)?.method).toBe("exact_legal_name_address");
  });
  it("does not replace ampersands in street fingerprints or source text", () => {
    expect(registryStreet({ addressLine1: "12 A & B Road" })).toBe("12 a b rd");
    expect(registryStreet({ addressLine1: "12 A AND B Road" })).toBe("12 a and b rd");
    const { finding, company, context } = fixture();
    finding.profile.identity.addressLine1 = "12 A & B Road";
    expect(verifyRegistryIdentity(finding.profile, company, { ...context, addresses: [{ ...context.addresses[0], addressLine1: "12 A AND B Road" }] }, [], now)).toBeNull();
  });
});
