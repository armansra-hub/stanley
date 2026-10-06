import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import locations from "./registryCmraLocations.json";
import { reviewedCmraLocation, verifyCmraMailboxAddress, type CmraLocationReference } from "./registryCmraMailbox";
import { parseRegistryFinding, registryContentHash, sameRegistryStreet, stableRegistryJson, validatePublishedRegistryAnchors, type RegistryProfile } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";
import { registryWebsiteText } from "./registryWebsiteText";

// All companies, registry rows and final witnesses in this file are synthetic.
// The public location catalog is real reviewed format evidence, not a box roster.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = new Date("2026-10-06T12:00:00.000Z");
const reference: CmraLocationReference = { schema: "reviewed_cmra_location_reference_v1",
  locationId: locations.locations[0].id, locationSha256: sha(stableRegistryJson(locations.locations[0])) };
const original = { legalName: "Example Strategy", addressLine1: "3389 Sheridan St PMB 137", city: "Hollywood", state: "FL", postalCode: "33021", countryCode: "US" as const };
const address = { addressLine1: "3389 Sheridan St. #137", city: "Hollywood", state: "FL", postalCode: "33021", countryCode: "US" as const };
const company = { name: "Example Strategy", domain: "example.com" };
const context = { aliases: [], context: "", addresses: [{ addressLine1: "10 Unrelated Road", state: "TX", postalCode: "76009", sourceKind: "netsuite_record" as const, sourceId: "synthetic-record", capturedAt: "2026-07-28T00:00:00Z" }] };
const html = "<footer>Example Strategy 3389 Sheridan St. #137 Hollywood FL 33021</footer>";
function row(identity: RegistryProfile["identity"] = original) {
  const sourceRow = { ...identity, entity_status: "Good Standing" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ source: "registry", kind: "ops_profile", internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceUrl: "https://data.colorado.gov/resource/test.json?entityid=123", detail: "Synthetic final analysis.", evidence,
    registryProfile: { version: 1, dataset: "co_sos", recordId: "123", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T12:00:00.1234567Z",
      identity, facts: [{ field: "entity_status", value: "Good Standing" }], provenance: { rowSha256: sha(evidence), quote: evidence, sourceRow } } }, now);
}
function proof(item = row(), body = html, overrides: Partial<RegistryWebsiteCorroboration> = {}): RegistryWebsiteCorroboration {
  const visible = registryWebsiteText(body);
  const raw = { mode: "cmra_mailbox_address" as const, cmraLocation: reference, observedAt: "2026-10-06T11:30:00.000Z",
    sourceUrl: "https://example.com/privacy/", normalizedVisibleTextSha256: sha(visible), quote: visible, quoteSha256: sha(visible), subject: "Example Strategy", address, ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, raw);
  return { ...raw, reader: { taskId: "/test/reader", reviewedAt: "2026-10-06T11:40:00.000Z", evidenceSha256 },
    reviewer: { taskId: "/test/independent", reviewedAt: "2026-10-06T11:41:00.000Z", evidenceSha256 } };
}
function resign(p: RegistryWebsiteCorroboration, item = row()) {
  const { reader, reviewer, ...bare } = p, evidenceSha256 = registryWebsiteEvidenceHash(item, bare);
  return { ...bare, reader: { ...reader, evidenceSha256 }, reviewer: { ...reviewer, evidenceSha256 } };
}
const page = (body = html, finalUrl = "https://example.com/privacy/") => ({ status: 200, finalUrl, body, contentType: "text/html" });
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue(page()); });

describe("opt-in reviewed CMRA mailbox correspondence", () => {
  it("accepts the same literal box at the reviewed location and keeps every address role", async () => {
    const item = row(), p = proof(item), before = stableRegistryJson({ item, context });
    const result = await registryWebsiteVerifier()(item, p, company, context, now);
    expect(result.website).toMatchObject({ mode: "cmra_mailbox_address", binding: "reviewed_cmra_mailbox_correspondence", registryAddress: original,
      websiteAddress: address, priorAddresses: context.addresses,
      cmraVerification: { mailboxNumber: "137", providerAddress: locations.locations[0].address, sourceRole: locations.locations[0].sourceRole } });
    expect(result.website?.addressRelationship).toContain("not_occupancy");
    expect(result.sourceIds).toContain(`cmra-location:${reference.locationId}:sha256:${reference.locationSha256}`);
    expect(fetch).toHaveBeenCalledTimes(1); // No runtime USPS/provider crawl.
    expect(stableRegistryJson({ item, context })).toBe(before);
  });
  it("is reusable for another named company and literal box; no company allowlist", async () => {
    const item = row({ ...original, legalName: "Another Business", addressLine1: "3389 Sheridan St PMB 204" });
    const body = "<p>Another Business 3389 Sheridan St #204 Hollywood FL 33021</p>";
    fetch.mockResolvedValue(page(body));
    await expect(registryWebsiteVerifier()(item, proof(item, body, { subject: "Another Business", address: { ...address, addressLine1: "3389 Sheridan St #204" } }), { ...company, name: "Another Business" }, context, now)).resolves.toBeTruthy();
  });
  it("supports a separate customer-box line but no provider secondary unit", () => {
    expect(verifyCmraMailboxAddress(reference, { ...original, addressLine1: "3389 Sheridan Street", addressLine2: "PMB137" },
      { ...address, addressLine1: "3389 Sheridan St.", addressLine2: "#137" }, "Example Strategy 3389 Sheridan St. #137 Hollywood FL 33021").mailboxNumber).toBe("137");
  });
  it("does not change the ordinary global comparison or silently activate the new mode", async () => {
    expect(sameRegistryStreet(original, address)).toBe(false);
    const p = proof(); delete p.mode; delete p.cmraLocation; delete p.observedAt;
    await expect(registryWebsiteVerifier()(row(), resign(p), company, context, now)).rejects.toThrow("street or unit differs");
  });
  it.each([
    ["unknown ID", { ...reference, locationId: "caller-provider" }],
    ["different hash", { ...reference, locationSha256: "a".repeat(64) }],
    ["caller facts", { ...reference, providerAddress: address }],
    ["missing schema", { locationId: reference.locationId, locationSha256: reference.locationSha256 }],
  ])("rejects %s location references", (_name, ref) => expect(() => reviewedCmraLocation(ref)).toThrow());
  it.each([
    ["different box", { ...address, addressLine1: "3389 Sheridan St #138" }],
    ["leading zero box", { ...address, addressLine1: "3389 Sheridan St #0137" }],
    ["bare number", { ...address, addressLine1: "3389 Sheridan St 137" }],
    ["suite", { ...address, addressLine1: "3389 Sheridan St Suite 137" }],
    ["unit", { ...address, addressLine1: "3389 Sheridan St Unit 137" }],
    ["PO Box", { ...address, addressLine1: "PO Box 137" }],
    ["extra provider suite", { ...address, addressLine1: "3389 Sheridan St Suite 4 #137" }],
    ["extra line2 suite", { ...address, addressLine2: "Suite 4" }],
    ["extra line2 box", { ...address, addressLine2: "#137" }],
    ["missing direction", { ...address, addressLine1: "3389 N Sheridan St #137" }],
    ["different street", { ...address, addressLine1: "3390 Sheridan St #137" }],
    ["different city", { ...address, city: "Miami" }],
    ["different state", { ...address, state: "TX" }],
    ["different ZIP", { ...address, postalCode: "33022" }],
    ["unsupported ZIP+4", { ...address, postalCode: "33021-1234" }],
    ["missing country", { ...address, countryCode: undefined }],
    ["Canada", { ...address, countryCode: "CA" as const }],
  ])("rejects %s without deleting address tokens", (_name, a) => {
    expect(() => verifyCmraMailboxAddress(reference, original, a, "Example Strategy " + [a.addressLine1, "addressLine2" in a ? a.addressLine2 : undefined].filter(Boolean).join(" ") + " Hollywood FL 33021")).toThrow();
  });
  it.each([
    { ...original, countryCode: undefined }, { ...original, addressLine1: "3389 Sheridan St #137" },
    { ...original, addressLine1: "3389 Sheridan St PMB 0137" }, { ...original, addressLine2: "Suite 4" },
    { ...original, addressLine1: "3389 Sheridan St Unit 4 PMB 137" }, { ...original, city: undefined },
  ])("requires the complete original PMB address %#", p => expect(() => verifyCmraMailboxAddress(reference, p, address, registryWebsiteText(html))).toThrow());
  it.each([
    "Example Strategy 3389 Sheridan St. 137 Hollywood FL 33021", "Example Strategy 3389 Sheridan St. #1370 Hollywood FL 33021",
    "Example Strategy 3389 Sheridan St. #137-2 Hollywood FL 33021", "Example Strategy 3389 Sheridan St. #137 Suite 4 Hollywood FL 33021",
    "Example Strategy 3389 Sheridan St. #137, Suite 4 Hollywood FL 33021", "Example Strategy 3389 Sheridan St. #137 Room 4 Hollywood FL 33021",
    "Example Strategy 3389 Sheridan St. #137.2 Hollywood FL 33021",
  ])("requires the literal whole website box address in the quote %#", quote => expect(() => verifyCmraMailboxAddress(reference, original, address, quote)).toThrow());
  it.each([
    "Example Strategy 3389 Sheridan St. #137, Hollywood, FL, 33021",
    "Example Strategy 3389 Sheridan St. #137\nHollywood FL, 33021",
  ])("accepts complete comma/newline address separators %#", quote => expect(verifyCmraMailboxAddress(reference, original, address, quote).mailboxNumber).toBe("137"));
  it.each(["crmDomainReference", "canonicalRedirect", "operatorPage", "operatorRelationship", "normalization", "identifier"]) ("rejects mixed %s mode", key => {
    const p = proof(); (p as unknown as Record<string, unknown>)[key] = {};
    expect(() => parseRegistryWebsiteCorroboration(resign(p), row(), now)).toThrow();
  });
  it("rejects location metadata outside the opt-in mode", () => {
    const p = proof(); delete p.mode;
    expect(() => parseRegistryWebsiteCorroboration(resign(p), row(), now)).toThrow();
  });
  it("binds complete original row/content and proof, not just a row ID", () => {
    const item = row(), p = proof(item);
    for (const mutate of [(r: typeof item) => { r.detail = "Changed analysis"; }, (r: typeof item) => { r.evidence += " "; },
      (r: typeof item) => { r.profile.facts[0].value = "Delinquent"; }, (r: typeof item) => { r.internalId = "124"; }]) {
      const changed = structuredClone(item); mutate(changed);
      expect(() => parseRegistryWebsiteCorroboration(p, changed, now)).toThrow();
    }
    const changed = structuredClone(p); changed.quote += "."; changed.quoteSha256 = sha(changed.quote);
    expect(() => parseRegistryWebsiteCorroboration(changed, item, now)).toThrow();
  });
  it.each([
    ["page after primary by 100ns", (p: RegistryWebsiteCorroboration) => { p.observedAt = "2026-10-06T11:40:00.0000001Z"; }],
    ["independent before primary by 100ns", (p: RegistryWebsiteCorroboration) => { p.reader.reviewedAt = "2026-10-06T11:40:00.0000001Z"; p.reviewer.reviewedAt = "2026-10-06T11:40:00.0000000Z"; }],
    ["before location source review", (p: RegistryWebsiteCorroboration) => { p.observedAt = "2026-10-06T10:00:00Z"; p.reader.reviewedAt = "2026-10-06T11:24:13.0279999Z"; }],
    ["unsupported precision", (p: RegistryWebsiteCorroboration) => { p.observedAt = "2026-10-06T11:30:00.00000001Z"; }],
    ["invalid Gregorian day", (p: RegistryWebsiteCorroboration) => { p.observedAt = "2026-02-30T11:30:00.000Z"; }],
    ["unsupported offset", (p: RegistryWebsiteCorroboration) => { p.observedAt = "2026-10-06T11:30:00.000+00:00"; }],
    ["future by 100ns", (p: RegistryWebsiteCorroboration) => { p.reviewer.reviewedAt = "2026-10-06T12:01:00.0000001Z"; }],
    ["same actor", (p: RegistryWebsiteCorroboration) => { p.reviewer.taskId = p.reader.taskId; }],
  ])("rejects %s", (_name, mutate) => { const p = proof(); mutate(p); expect(() => parseRegistryWebsiteCorroboration(resign(p), row(), now)).toThrow(); });
  it("accepts genuine seven-digit source precision and equal final-read times", () => {
    const p = proof(); p.observedAt = "2026-10-06T11:39:59.9999999Z"; p.reviewer.reviewedAt = p.reader.reviewedAt;
    expect(parseRegistryWebsiteCorroboration(resign(p), row(), now).observedAt).toBe(p.observedAt);
  });
  it("rejects stale final reviews", () => expect(() => parseRegistryWebsiteCorroboration(proof(), row(), new Date("2026-10-14T12:00:00Z"))).toThrow());
  it("still rejects a different company despite shared CMRA location", async () => {
    await expect(registryWebsiteVerifier()(row(), proof(), { ...company, name: "Unrelated Company" }, context, now)).rejects.toThrow("subject");
  });
  it("still rejects an off-domain source", async () => {
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { sourceUrl: "https://example.org/privacy/" }), company, context, now)).rejects.toThrow("own-domain");
  });
  it("rejects a redirected company page", async () => {
    fetch.mockResolvedValue(page(html, "https://example.com/changed/"));
    await expect(registryWebsiteVerifier()(row(), proof(), company, context, now)).rejects.toThrow("redirected");
  });
  it("retains the exact whole-page live hash and quote gates", async () => {
    fetch.mockResolvedValue(page(html + "<p>Changed footer</p>"));
    await expect(registryWebsiteVerifier()(row(), proof(), company, context, now)).rejects.toThrow("changed or exact reviewed quote missing");
  });
  it("does not create a transitive published-address anchor; old ordinary anchors still work", async () => {
    const f = row(), verification = await registryWebsiteVerifier()(f, proof(f), company, context, now);
    const publication = { contentHash: registryContentHash(f.profile, f.sourceUrl, f.detail), eventId: "synthetic-event", publishedAt: now.toISOString() };
    const saved = { id: "synthetic-row", company_id: f.companyId, netsuite_internal_id: f.internalId, source: "registry", kind: "ops_profile",
      label: f.label, detail: f.detail, evidence: f.evidence, evidence_url: f.sourceUrl, registry_profile: { ...f.profile, verification, publication } };
    const receipt = { id: saved.id, companyId: f.companyId, internalId: f.internalId, profileKey: f.label, ...publication, eventVerified: true };
    expect(validatePublishedRegistryAnchors([saved], [receipt], now)).toEqual([]);
    const ordinary = structuredClone(saved); ordinary.registry_profile.verification.website = { mode: undefined };
    expect(validatePublishedRegistryAnchors([ordinary], [receipt], now)).toHaveLength(1);
  });
});
