import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { htmlToVisibleText } from "@/lib/sources/siteDiscovery";
import { parseRegistryFinding, registryContentHash } from "./registryProfiles";
import { parseRegistryWebsiteCorroboration, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";
import fixture from "./rise-fixture.json";

const now = new Date("2026-10-02T16:40:00Z"), sha = (x: string) => createHash("sha256").update(x).digest("hex");
const full = fixture.source.text, quote = fixture.source.identityQuote;
const company = { name: fixture.company.name, domain: fixture.company.domain }, context = { aliases: fixture.company.legalNames, addresses: fixture.company.addresses as never[], context: "private context omitted" };
const address = { addressLine1: "510 Burrard St.", addressLine2: "Suite #820", city: "Vancouver", state: "BC", postalCode: "V6C 3A8", countryCode: "CA" as const };
const row = () => parseRegistryFinding(structuredClone(fixture.finding), now);
type Bare = Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">;
function proof(item = row(), body = full, overrides: Partial<Bare> = {}): RegistryWebsiteCorroboration {
  const bare: Bare = { mode: "registry_identifier", identifier: { kind: "cra_charity_registration", value: "763368099RR0001" }, sourceUrl: fixture.source.capture.finalUrl,
    normalizedVisibleTextSha256: sha(body), quote, quoteSha256: sha(quote), subject: "Rise Women’s Legal Centre", address, ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item, bare);
  return { ...bare, reader: { taskId: "/test/cra-primary", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/cra-independent", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (text = full) => ({ status: 200, finalUrl: fixture.source.capture.finalUrl, contentType: "text/html", body: `<main>${text}</main>` });
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue(page()); });

describe("CRA exact charity account and financial-period website association", () => {
  it("accepts the actual complete retained Rise page and preserves both address roles and all raw fields", async () => {
    expect(htmlToVisibleText(page().body)).toBe(full);
    const item = row(), before = JSON.stringify(item), contentHash = registryContentHash(item.profile, item.sourceUrl, item.detail);
    const verified = await registryWebsiteVerifier()(item, proof(item), company, context, now);
    expect(verified.website).toMatchObject({ binding: "exact_cra_charity_registration_legal_subject", registryAddress: item.profile.identity, websiteAddress: address, addressRelationship: "separate_observations_not_address_equivalence" });
    expect(item.profile.identity.addressLine1).toBe("PO BOX 3761 STN TERMINAL");
    expect(item.profile.recordId).toBe("763368099RR0001:2024-03-31");
    expect(JSON.stringify(item)).toBe(before);
    expect(registryContentHash({ ...item.profile, verification: verified }, item.sourceUrl, item.detail)).toBe(contentHash);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(verified)).not.toContain("private context omitted");
  });
  it.each(["763368099RR0001", "763368099 RR0001", "763368099RR 0001", "763368099 RR 0001", "763368099\u00a0RR\u00a00001"])("removes formatting spaces only from %s", async value => {
    const body = full.replaceAll("763368099 RR 0001", value), q = htmlToVisibleText(quote.replace("763368099 RR 0001", value)), normalized = htmlToVisibleText(page(body).body); fetch.mockResolvedValueOnce(page(body));
    expect((await registryWebsiteVerifier()(row(), proof(row(), normalized, { quote: q, quoteSha256: sha(q) }), company, context, now)).website?.binding).toBe("exact_cra_charity_registration_legal_subject");
  });
  it.each(["763368099", "763368099RR0002", "763368099RT0001", "0763368099RR0001", "763368099RR001", "763368099RR00010", "763368099RR0001X", "763368099RR0001/2", "763368099RR0001.2", "763368099-RR-0001", "763368099rr0001"])("rejects incomplete, different or reformatted charity account %s", async value => {
    const body = full.replaceAll("763368099 RR 0001", value), q = quote.replace("763368099 RR 0001", value);
    await expect(registryWebsiteVerifier()(row(), proof(row(), body, { quote: q, quoteSha256: sha(q) }), company, context, now)).rejects.toThrow(/identifier/);
    expect(fetch).not.toHaveBeenCalled();
  });
  const changes: Array<[string, (x: ReturnType<typeof row>) => void]> = [
    ["dataset", x => { x.profile.dataset = "irs_exempt"; }], ["US authority", x => { x.sourceUrl = "https://www.irs.gov/a.csv"; }],
    ["authority lookalike", x => { x.sourceUrl = "https://open.canada.ca.example.com/a.csv"; }], ["missing suffix", x => { x.profile.recordId = "763368099RR0001"; }],
    ["different suffix", x => { x.profile.recordId = "763368099RR0001:2023-03-31"; }], ["impossible date", x => { x.profile.recordId = "763368099RR0001:2024-02-30"; }],
    ["source date", x => { x.profile.sourceAsOf = "2024-03-30"; }], ["null source date", x => { x.profile.sourceAsOf = null; }],
    ["source fiscal scalar", x => { x.profile.provenance.sourceRow.tax_period = "2023-03-31"; }], ["source account scalar", x => { x.profile.provenance.sourceRow.registration_number = "763368099RR0002"; }],
    ["source country", x => { x.profile.provenance.sourceRow.countryCode = "US"; }], ["identity country", x => { x.profile.identity.countryCode = "US"; }], ["absent country", x => { delete x.profile.identity.countryCode; }],
    ["foreign province", x => { x.profile.identity.state = "WA"; }], ["foreign postal", x => { x.profile.identity.postalCode = "98101"; }],
    ["missing account fact", x => { x.profile.facts = x.profile.facts.filter(f => f.field !== "registration_number"); }],
    ["duplicate account fact", x => { x.profile.facts.push(structuredClone(x.profile.facts.find(f => f.field === "registration_number")!)); }],
    ["missing period fact", x => { x.profile.facts = x.profile.facts.filter(f => f.field !== "tax_period"); }],
    ["wrong period fact", x => { x.profile.facts.find(f => f.field === "tax_period")!.value = "2023-03-31"; }],
    ["raw financial hash", x => { x.profile.provenance.rowSha256 = "0".repeat(64); }],
    ["raw financial account", x => { const at = x.evidence.indexOf("\n") + 1; x.evidence = x.evidence.slice(0, at) + x.evidence.slice(at).replace("763368099RR0001", "763368099RR0002"); x.profile.provenance.quote = x.evidence; }],
    ["raw mailing station", x => { x.evidence = x.evidence.replace("STN TERMINAL", "STN OTHER"); x.profile.provenance.quote = x.evidence; }],
    ["raw country", x => { x.evidence = x.evidence.replace(",CA\n", ",US\n"); x.profile.provenance.quote = x.evidence; }],
    ["second raw record", x => { x.evidence += x.evidence; x.profile.provenance.quote = x.evidence; }]
  ];
  it.each(changes)("rejects %s even with freshly bound synthetic witnesses", (_label, change) => {
    const item = row(); change(item); expect(() => parseRegistryWebsiteCorroboration(proof(item), item, now)).toThrow(/CRA|identifier/);
  });
  it.each(["Phone", "Business number", "EIN", "Unlabelled number"])("requires the explicit charity-registration label, not %s", async label => {
    const q = quote.replace("charitable registration number", label); await expect(registryWebsiteVerifier()(row(), proof(row(), q, { quote: q, quoteSha256: sha(q) }), company, context, now)).rejects.toThrow(/identifier/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([" Charitable registration number 763368099RR0002.", " Charitable registration number 763368099RR0001X.", " Our customer's charitable registration number 763368099RR0001.", " Our former charitable registration number 763368099RR0001.", " Not our charitable registration number 763368099RR0001."])("rejects full-page contradiction outside the exact quote: %s", async extra => {
    const body = full + extra; fetch.mockResolvedValueOnce(page(body)); await expect(registryWebsiteVerifier()(row(), proof(row(), body), company, context, now)).rejects.toThrow(/conflicting|ambiguous|historical|negated/);
  });
  it.each(["Not Rise Women’s Legal Centre", "Global Rise Women’s Legal Centre", "Rise Women’s Legal Centre Foundation", "Rise Women’s Legal"])("rejects mismatched or partial legal subject %s", async subject => {
    const q = quote.replace("Rise Women’s Legal Centre", subject); await expect(registryWebsiteVerifier()(row(), proof(row(), q, { quote: q, quoteSha256: sha(q), subject }), company, context, now)).rejects.toThrow(/subject/);
  });
  it("requires a complete literal Canadian website address while preserving the differing source mailing address", async () => {
    await expect(registryWebsiteVerifier()(row(), proof(row(), full, { address: undefined }), company, context, now)).rejects.toThrow(/address/);
    await expect(registryWebsiteVerifier()(row(), proof(row(), full, { address: { ...address, countryCode: "US" } }), company, context, now)).rejects.toThrow(/Canadian/);
    await expect(registryWebsiteVerifier()(row(), proof(row(), full, { address: { ...address, addressLine2: "Suite #821" } }), company, context, now)).rejects.toThrow(/complete address/);
  });
  it("retains full content, independent witnesses, canonical subject/domain and changed-page rejection", async () => {
    const item = row(), valid = proof(item); item.detail = "changed analysis";
    await expect(registryWebsiteVerifier()(item, valid, company, context, now)).rejects.toThrow(/bind exact/);
    await expect(registryWebsiteVerifier()(row(), { ...valid, reviewer: valid.reader }, company, context, now)).rejects.toThrow(/independent/);
    await expect(registryWebsiteVerifier()(row(), valid, { ...company, name: "Other Centre" }, context, now)).rejects.toThrow(/subject/);
    await expect(registryWebsiteVerifier()(row(), valid, { ...company, domain: "other.ca" }, context, now)).rejects.toThrow(/own-domain/);
    fetch.mockResolvedValueOnce(page(full + " Changed")); await expect(registryWebsiteVerifier()(row(), valid, company, context, now)).rejects.toThrow(/changed/);
    fetch.mockResolvedValueOnce({ ...page(), finalUrl: "https://other.ca/" }); await expect(registryWebsiteVerifier()(row(), valid, company, context, now)).rejects.toThrow(/own-domain/);
  });
});
