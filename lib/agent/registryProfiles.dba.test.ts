import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { parseRegistryFinding, registryContentHash, verifyRegistryIdentity, type RegistryProfile } from "./registryProfiles";

const now = new Date("2026-09-30T12:00:00Z");
const marker = "\nOriginal public source row: ";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// Exact retained public census row for the C1 Freight admission regression.
const rawRow = { carrier_operation: "C", dba_name: "C1 FREIGHT", docket1: "1256106", docket1_status_code: "A", docket1prefix: "MC",
  dot_number: "3647707", legal_name: "ALL STATES BROKERAGE LLC", mcs150_date: "20260508", mcs150_mileage: "0", mcs150_mileage_year: "0",
  phy_city: "JOLIET", phy_country: "US", phy_state: "IL", phy_street: "175 MCDONALD AVE STE A3", phy_zip: "60431", power_units: "0", status_code: "A" };
const identity = { legalName: rawRow.legal_name, addressLine1: rawRow.phy_street, city: rawRow.phy_city, state: rawRow.phy_state, postalCode: rawRow.phy_zip, countryCode: "US" as const };
const company = { name: "C1 Freight" };
const context: CompanyIdentityContext = { aliases: [], context: "", addresses: [{ addressLine1: "175 Mcdonald Ave Ste A3", city: "Joliet", state: "IL", postalCode: "60431", countryCode: "US", sourceKind: "netsuite_record", sourceId: "record-1", capturedAt: "2026-07-28T00:00:00Z" }] };
const sourceUrl = "https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=3647707";

function fixture(): RegistryProfile {
  const sourceRow = { ...identity, usdot_number: "3647707", power_units: 0, operating_status: "A", carrier_operation: "C" };
  const raw = JSON.stringify(rawRow), quote = JSON.stringify(sourceRow) + marker + raw;
  return parse({ version: 1, dataset: "fmcsa", recordId: "3647707", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T23:14:04.578298+00:00", identity,
    facts: [{ field: "usdot_number", label: "USDOT number", value: "3647707" }, { field: "power_units", label: "Reported power units", value: 0, unit: "power units" },
      { field: "operating_status", label: "Operating status", value: "A" }, { field: "carrier_operation", label: "Carrier operation", value: "C" }],
    provenance: { rowSha256: sha(raw), quote, sourceRow } });
}
function parse(profile: RegistryProfile): RegistryProfile {
  return parseRegistryFinding({ internalId: "198039577", companyId: "d4c32316-9d3f-4648-ada4-bb763cd5998e", kind: "ops_profile", source: "registry",
    evidence: profile.provenance.quote, sourceUrl, registryProfile: profile }, now).profile;
}
function replaceRaw(profile: RegistryProfile, raw: string, updateHash = true): RegistryProfile {
  return { ...profile, provenance: { ...profile.provenance, quote: profile.provenance.quote.split(marker)[0] + marker + raw,
    rowSha256: updateHash ? sha(raw) : profile.provenance.rowSha256 } };
}

describe("FMCSA retained original DBA admission", () => {
  it("admits the exact C1 DBA and canonical suite address without changing any source or fingerprint", () => {
    const profile = fixture();
    expect(profile.provenance.rowSha256).toBe("0e90a3dfe72467fc10d6b40271e0de7fb1bf12c71139bdb41630f7a5cdc47fbe");
    const before = JSON.stringify([profile, context]), hash = registryContentHash(profile, sourceUrl);
    const verification = verifyRegistryIdentity(profile, company, context, [], now);
    expect(verification).toEqual({ method: "exact_registry_dba_address", verifiedAt: now.toISOString(), sourceIds: ["record-1"] });
    expect(JSON.stringify([profile, context])).toBe(before);
    expect(registryContentHash({ ...profile, verification: verification! }, sourceUrl)).toBe(hash);
    expect(profile.identity.legalName).toBe("ALL STATES BROKERAGE LLC");
    expect(context.aliases).toEqual([]);
  });

  it("allows formatting and canonical address line splits without deleting suite or country evidence", () => {
    const ctx = { ...context, addresses: [{ ...context.addresses[0], addressLine1: "175 Mcdonald Avenue", addressLine2: "Suite A3", postalCode: "60431-1000" }] };
    expect(verifyRegistryIdentity(fixture(), { name: " C1. Freight " }, ctx, [], now)?.method).toBe("exact_registry_dba_address");
  });

  it("rejects changed original bytes even when the DBA, legal operator and address still match", () => {
    const profile = fixture();
    const changed = replaceRaw(profile, JSON.stringify({ ...rawRow, docket1: "9999999" }), false);
    expect(verifyRegistryIdentity(parse(changed), company, context, [], now)).toBeNull();
    const reformatted = replaceRaw(profile, JSON.stringify(rawRow, null, 2), false);
    expect(verifyRegistryIdentity(parse(reformatted), company, context, [], now)).toBeNull();
  });

  it.each([
    ["dot_number", "3647708"], ["legal_name", "OTHER BROKERAGE LLC"], ["phy_street", "175 MCDONALD AVE STE A4"],
    ["phy_city", "CHICAGO"], ["phy_state", "IN"], ["phy_zip", "60432"], ["phy_country", "CA"],
  ])("binds the original %s to the curated identity even when other values occur in the excerpt", (field, value) => {
    const changed = replaceRaw(fixture(), JSON.stringify({ ...rawRow, [field]: value }));
    // The unchanged curated prefix passes parsing; it cannot substitute for the original-row binding.
    expect(verifyRegistryIdentity(parse(changed), company, context, [], now)).toBeNull();
  });

  it.each(["C1", "C1 Freight West", "C1 Freight LLC", "C1 Freight Company", "Freight C1", "中文 C1 Freight"])("requires the entire canonical brand, not a suffix or alias expansion: %s", name => {
    expect(verifyRegistryIdentity(fixture(), { name }, { ...context, aliases: ["C1 Freight"] }, [], now)).toBeNull();
  });

  it.each(["", "OTHER DBA", "C1 FREIGHT / OTHER DBA", "C1 FREIGHT SERVICES", "---", "中文 C1 FREIGHT", "É C1 FREIGHT"])("does not select a substring or repair the literal DBA: %s", dba_name => {
    expect(verifyRegistryIdentity(parse(replaceRaw(fixture(), JSON.stringify({ ...rawRow, dba_name }))), company, context, [], now)).toBeNull();
  });

  it.each(["OTHER OPERATOR LLC", "C1 FREIGHT LLC", "ALL STATES BROKERAGE INC", "中文 C1 FREIGHT", ""])("does not override an incompatible canonical legal alias: %s", alias => {
    expect(verifyRegistryIdentity(fixture(), company, { ...context, aliases: [alias] }, [], now)).toBeNull();
  });

  it("permits the same whole DBA alias and preserves an existing exact legal-operator alias", () => {
    expect(verifyRegistryIdentity(fixture(), company, { ...context, aliases: ["C1. Freight"] }, [], now)?.method).toBe("exact_registry_dba_address");
    expect(verifyRegistryIdentity(fixture(), company, { ...context, aliases: [identity.legalName] }, [], now)?.method).toBe("exact_legal_name_address");
  });

  it.each([
    { addressLine1: "175 Mcdonald Ave" }, { addressLine1: "175 Mcdonald Ave Ste A4" }, { addressLine1: "176 Mcdonald Ave Ste A3" },
    { addressLine1: "175 N Mcdonald Ave Ste A3" }, { addressLine2: "Floor 2" }, { state: "IN" }, { postalCode: "60432" }, { countryCode: "CA" }, { sourceId: "" }, { sourceId: " " },
  ])("preserves the complete canonical street, unit, state, postal and country/source gates: %j", override => {
    expect(verifyRegistryIdentity(fixture(), company, { ...context, addresses: [{ ...context.addresses[0], ...override }] }, [], now)).toBeNull();
  });

  it("requires canonical address provenance and matching curated USDOT identifiers", () => {
    const profile = fixture();
    expect(verifyRegistryIdentity(profile, company, { ...context, addresses: [] }, [], now)).toBeNull();
    expect(verifyRegistryIdentity({ ...profile, recordId: "3647708" }, company, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity({ ...profile, facts: profile.facts.filter(fact => fact.field !== "usdot_number") }, company, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity({ ...profile, provenance: { ...profile.provenance, sourceRow: { ...profile.provenance.sourceRow, usdot_number: "3647708" } } }, company, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity({ ...profile, identity: { ...identity, addressLine2: "Suite A3" } }, company, context, [], now)).toBeNull();
    expect(verifyRegistryIdentity({ ...profile, identity: { ...identity, countryCode: undefined } }, company, context, [], now)).toBeNull();
  });

  it("requires one parseable original-row object and never repairs missing evidence", () => {
    const profile = fixture();
    for (const raw of ["{", "null", "[]", JSON.stringify("C1 FREIGHT")]) {
      expect(verifyRegistryIdentity(replaceRaw(profile, raw), company, context, [], now)).toBeNull();
    }
    for (const quote of [profile.provenance.quote.split(marker)[0], profile.provenance.quote + marker + JSON.stringify(rawRow)]) {
      expect(verifyRegistryIdentity({ ...profile, provenance: { ...profile.provenance, quote } }, company, context, [], now)).toBeNull();
    }
  });

  it("does not add another dataset or accept caller-supplied DBA/verification fields", () => {
    const profile = fixture();
    expect(verifyRegistryIdentity({ ...profile, dataset: "co_sos" }, company, context, [], now)).toBeNull();
    expect(() => parse({ ...profile, provenance: { ...profile.provenance, sourceRow: { ...profile.provenance.sourceRow, dba_name: "C1 FREIGHT" } } })).toThrow("unsupported/publicly unnecessary");
    expect(() => parse({ ...profile, verification: { method: "exact_registry_dba_address", verifiedAt: now.toISOString(), sourceIds: ["caller"] } })).toThrow("server-owned");
  });

  it("rechecks current original DBA evidence instead of trusting a prior DBA publication", () => {
    const profile = fixture();
    const old: RegistryProfile = { ...profile, verification: { method: "exact_registry_dba_address", verifiedAt: now.toISOString(), sourceIds: ["record-1"] },
      publication: { contentHash: "b".repeat(64), eventId: "prior-event", publishedAt: now.toISOString() } };
    expect(verifyRegistryIdentity(profile, company, context, [old], now)?.method).toBe("exact_registry_dba_address");
    const missing = { ...profile, provenance: { ...profile.provenance, quote: profile.provenance.quote.split(marker)[0] } };
    expect(verifyRegistryIdentity(parse(missing), company, context, [old], now)).toBeNull();
    expect(verifyRegistryIdentity(profile, company, { ...context, addresses: [] }, [old], now)).toBeNull();
  });

  it("preserves the existing direct legal-operator admission", () => {
    expect(verifyRegistryIdentity(fixture(), { name: identity.legalName }, context, [], now)?.method).toBe("exact_legal_name_address");
  });
});
