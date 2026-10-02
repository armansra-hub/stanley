import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const now = new Date("2026-09-30T00:00:00Z"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const registryAddress = { legalName: "Acme Inc", addressLine1: "123 Main Street", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const siteAddress = { addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" }, context = { aliases: [], addresses: [], context: "private notes excluded" };
const source = "Acme Inc Contact 123 Main Street Suite 4 Austin TX 78701. USDOT #12345.";
function row(dataset = "fmcsa", id = "12345") {
  const field = dataset === "fmcsa" ? "usdot_number" : "ein", sourceRow = { ...registryAddress, [field]: id }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", internalId: "123", source: "registry", kind: "ops_profile",
    sourceUrl: dataset === "fmcsa" ? "https://data.transportation.gov/resource/public.json" : "https://www.irs.gov/pub/irs-soi/eo2.csv", evidence,
    registryProfile: { version: 1, dataset, recordId: id, sourceAsOf: null, observedAt: now.toISOString(), identity: registryAddress,
      facts: [{ field, value: id }], provenance: { rowSha256: sha(evidence), quote: evidence, sourceRow } } }, now);
}
function proof(item = row(), html = source, overrides: Partial<Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">> = {}): RegistryWebsiteCorroboration {
  const visible = htmlToVisibleText(html);
  const evidence: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer"> = {
    mode: "registry_identifier", identifier: { kind: item.profile.dataset === "fmcsa" ? "usdot" : "ein", value: item.profile.recordId },
    sourceUrl: "https://acme.com/", normalizedVisibleTextSha256: sha(visible), quote: visible, quoteSha256: sha(visible), subject: "Acme Inc", address: siteAddress, ...overrides,
  };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, evidence);
  return { ...evidence, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string) => ({ status: 200, finalUrl: "https://acme.com/", contentType: "text/html", body });
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue(page(source)); });
describe("exact public registry identifiers on a reviewed own-company website", () => {
  it("identifies the source row without claiming differing addresses are equivalent or changing facts", async () => {
    const item = row(), before = JSON.stringify(item.profile), hash = registryContentHash(item.profile, item.sourceUrl);
    const result = await registryWebsiteVerifier()(item, proof(item), company, context, now);
    expect(result.website).toMatchObject({ binding: "exact_usdot_legal_subject", registryAddress, websiteAddress: siteAddress, addressRelationship: "separate_observations_not_address_equivalence" });
    expect(JSON.stringify(item.profile)).toBe(before);
    expect(registryContentHash({ ...item.profile, verification: result }, item.sourceUrl)).toBe(hash);
    expect(JSON.stringify(result)).not.toContain("private notes");
    const html = "Acme Inc Contact 90 New Road Suite 7 Dallas TX 75201. USDOT12345";
    fetch.mockResolvedValueOnce(page(html));
    const moved = await registryWebsiteVerifier()(item, proof(item, html, { address: { ...siteAddress, addressLine1: "90 New Road", addressLine2: "Suite 7", city: "Dallas", postalCode: "75201" } }), company, context, now);
    expect(moved.website?.registryAddress).toEqual(registryAddress);
    expect(moved.website?.websiteAddress).toMatchObject({ addressLine1: "90 New Road" });
  });
  it("binds a labelled EIN to the exact exempt-organization record, including leading zeroes", async () => {
    const item = row("irs_exempt", "012345678"), html = source.replace("USDOT #12345", "EIN: 01-2345678");
    fetch.mockResolvedValueOnce(page(html));
    expect((await registryWebsiteVerifier()(item, proof(item, html), company, context, now)).website?.binding).toBe("exact_ein_legal_subject");
  });
  it.each(["Phone12345", "MC #12345", "USDOT123456", "USDOT12345X"])("rejects an unrelated or inexact number: %s", async label => {
    const html = source.replace("USDOT #12345", label);
    await expect(registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).rejects.toThrow("identifier");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([" Other carrier USDOT54321.", " Acme LLC legal notice.", " Our customer's USDOT12345."])("reads beyond the selected passage and rejects conflicting page context: %s", async extra => {
    const html = source + extra; fetch.mockResolvedValueOnce(page(html));
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { quote: source, quoteSha256: sha(source) }), company, context, now)).rejects.toThrow(/conflicting|ambiguous/);
  });
  it.each(["Acme LLC", "Acme"])("requires the source legal form beside its number: %s", async subject => {
    const html = source.replace("Acme Inc", subject);
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { subject }), company, context, now)).rejects.toThrow(/subject/);
  });
  it("rejects mismatching dataset, original row, record ID and fact independently", () => {
    const item = row();
    expect(() => parseRegistryWebsiteCorroboration(proof(item, source, { identifier: { kind: "ein", value: "000012345" } }), item, now)).toThrow("exact source");
    const wrongRow = row(); wrongRow.profile.provenance.sourceRow.usdot_number = "99999";
    expect(() => parseRegistryWebsiteCorroboration(proof(wrongRow), wrongRow, now)).toThrow("exact source");
    const wrongId = row(); wrongId.profile.recordId = "99999";
    expect(() => parseRegistryWebsiteCorroboration(proof(wrongId), wrongId, now)).toThrow("exact source");
    const wrongFact = row(); wrongFact.profile.facts = [];
    expect(() => parseRegistryWebsiteCorroboration(proof(wrongFact), wrongFact, now)).toThrow("exact source");
  });
  it("requires separate current exact-mode attestations, including when the verifier is called directly", async () => {
    const item = row(), valid = proof(item), { mode, identifier, reader, reviewer, ...oldEvidence } = valid;
    const oldHash = registryWebsiteEvidenceHash(item, oldEvidence);
    await expect(registryWebsiteVerifier()(item, { ...valid, reviewer: valid.reader }, company, context, now)).rejects.toThrow("independent");
    await expect(registryWebsiteVerifier()(item, { ...valid, reader: { ...reader, evidenceSha256: oldHash }, reviewer: { ...reviewer, evidenceSha256: oldHash } }, company, context, now)).rejects.toThrow("bind");
    await expect(registryWebsiteVerifier()(item, valid, company, context, new Date("2026-10-10T00:00:00Z"))).rejects.toThrow("bind");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("binds exact curated facts, source URL, interpretation, original evidence and observation date even when rowSha256 is unchanged", () => {
    const original = row(), attested = proof(original);
    const changes: Array<(item: ReturnType<typeof row>) => void> = [
      item => {
        item.profile.facts.push({ field: "power_units", label: "Reported power units", value: 999, unit: "power units" });
        item.profile.provenance.sourceRow.power_units = 999;
        item.evidence = JSON.stringify(item.profile.provenance.sourceRow);
        item.profile.provenance.quote = item.evidence;
      },
      item => { item.profile.provenance.sourceRow.carrier_operation = "A"; },
      item => { item.profile.sourceAsOf = "2026-01-01"; },
      item => { item.sourceUrl = "https://data.transportation.gov/resource/changed.json"; },
      item => { item.detail = "A different interpretation"; },
      item => { item.evidence += " Different retained source evidence."; },
      item => { item.profile.observedAt = "2026-09-29T23:59:00Z"; },
    ];
    for (const change of changes) {
      const changed = row(); change(changed);
      expect(changed.profile.provenance.rowSha256).toBe(original.profile.provenance.rowSha256);
      expect(() => parseRegistryWebsiteCorroboration(attested, changed, now)).toThrow("bind exact");
    }
  });
  it("rejects a separately parsed 2-to-999 fleet change with the same original row hash", () => {
    const base = row();
    const parsedUnits = (units: number, rowSha256: string) => {
      const sourceRow = { ...base.profile.provenance.sourceRow, power_units: units }, evidence = JSON.stringify(sourceRow);
      return parseRegistryFinding({ companyId: base.companyId, internalId: base.internalId, source: "registry", kind: "ops_profile", sourceUrl: base.sourceUrl, evidence,
        registryProfile: { ...base.profile, facts: [{ field: "usdot_number", value: "12345" }, { field: "power_units", value: units }], provenance: { sourceRow, quote: evidence, rowSha256 } } }, now);
    };
    const before = parsedUnits(2, base.profile.provenance.rowSha256), after = parsedUnits(999, base.profile.provenance.rowSha256);
    expect(() => parseRegistryWebsiteCorroboration(proof(before), after, now)).toThrow("bind exact");
  });
  it("preserves narrow address-mode hashes but refuses an incomplete identifier-mode hash input", () => {
    const item = row(), full = proof(item), { mode, identifier, reader, reviewer, ...legacy } = full;
    const narrow = { companyId: item.companyId, internalId: item.internalId, profile: item.profile };
    expect(registryWebsiteEvidenceHash(narrow, legacy)).toBe(registryWebsiteEvidenceHash(item, legacy));
    expect(() => registryWebsiteEvidenceHash(narrow, { ...legacy, mode, identifier })).toThrow("complete parsed publication content");
  });
  it.each(["Not Acme Inc", "SuperAcme Inc", "Acme Incidental", "Global Acme Inc", "We are not Acme Inc"])("rejects a substring, prefixed or negated subject: %s", async subject => {
    const html = source.replace("Acme Inc", subject);
    await expect(registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).rejects.toThrow(/boundaries|negated|prefix/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([" Not Acme Inc owns this number.", " Global Acme Inc."])("holds conflicting full-page subject scope outside the chosen quote: %s", async extra => {
    fetch.mockResolvedValueOnce(page(source + extra));
    await expect(registryWebsiteVerifier()(row(), proof(row(), source + extra, { quote: source, quoteSha256: sha(source) }), company, context, now)).rejects.toThrow(/negated|prefix/);
  });
  it("still rejects missing literal address, noncanonical source, changed body and off-domain redirect", async () => {
    const item = row();
    await expect(registryWebsiteVerifier()(item, proof(item, source, { address: { ...siteAddress, addressLine2: "Suite 9" } }), company, context, now)).rejects.toThrow("complete address");
    await expect(registryWebsiteVerifier()(item, proof(item, source, { sourceUrl: "https://other.com/" }), company, context, now)).rejects.toThrow("own-domain");
    fetch.mockResolvedValueOnce(page(source + " Changed"));
    await expect(registryWebsiteVerifier()(item, proof(item), company, context, now)).rejects.toThrow("changed");
    fetch.mockResolvedValueOnce({ ...page(source), finalUrl: "https://other.com/" });
    await expect(registryWebsiteVerifier()(item, proof(item), company, context, now)).rejects.toThrow("own-domain");
  });
});


describe("closed USDOT colon/hash punctuation", () => {
  it.each(["USDOT: #12345", "USDOT:#12345", "US DOT number: # 12345", "U.S. DOT no.: #12345", "DOT: 12345", "USDOT #12345", "USDOT12345"])("accepts the exact labelled identifier with closed punctuation: %s", async label => {
    const item = row(), html = source.replace("USDOT #12345", label);
    const before = JSON.stringify(item); fetch.mockResolvedValueOnce(page(html));
    const result = await registryWebsiteVerifier()(item, proof(item, html), company, context, now);
    expect(result.website?.binding).toBe("exact_usdot_legal_subject");
    expect(JSON.stringify(item)).toBe(before);
  });
  it.each(["USDOT:: #12345", "USDOT ##12345", "USDOT #:12345", "USDOT: # #12345", "USDOT: #12345X", "MC: #12345", "Phone: #12345"])("rejects malformed punctuation or unrelated/inexact identifiers: %s", async label => {
    const html = source.replace("USDOT #12345", label);
    await expect(registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).rejects.toThrow("identifier");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a second conflicting colon/hash identifier outside the selected passage", async () => {
    const quote = source.replace("USDOT #12345", "USDOT: #12345"), html = quote + " Other carrier USDOT: #54321.";
    fetch.mockResolvedValueOnce(page(html));
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { quote, quoteSha256: sha(quote) }), company, context, now)).rejects.toThrow("conflicting");
  });
  it("keeps the 650-character legal-subject scope", async () => {
    const html = "Acme Inc Contact 123 Main Street Suite 4 Austin TX 78701. " + "x".repeat(660) + ". USDOT: #12345.";
    await expect(registryWebsiteVerifier()(row(), proof(row(), html), company, context, now)).rejects.toThrow("not beside");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the full-page legal-form conflict hold", async () => {
    const quote = source.replace("USDOT #12345", "USDOT: #12345"), html = quote + " Acme LLC legal notice.";
    fetch.mockResolvedValueOnce(page(html));
    await expect(registryWebsiteVerifier()(row(), proof(row(), html, { quote, quoteSha256: sha(quote) }), company, context, now)).rejects.toThrow("conflicting legal forms");
  });
  it("does not change EIN label punctuation", async () => {
    const item = row("irs_exempt", "012345678"), html = source.replace("USDOT #12345", "EIN: #01-2345678");
    await expect(registryWebsiteVerifier()(item, proof(item, html), company, context, now)).rejects.toThrow("identifier");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps original-row and attestation-content bindings", async () => {
    const item = row(), html = source.replace("USDOT #12345", "USDOT: #12345"), attested = proof(item, html);
    item.detail = "changed interpretation";
    await expect(registryWebsiteVerifier()(item, attested, company, context, now)).rejects.toThrow("bind exact");
    const wrong = row(); wrong.profile.provenance.sourceRow.usdot_number = "99999";
    expect(() => parseRegistryWebsiteCorroboration(proof(wrong, html), wrong, now)).toThrow("exact source");
  });
});
