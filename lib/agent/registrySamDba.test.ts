import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { parseRegistryFinding, registryContentHash, stableRegistryJson, verifyRegistryIdentity } from "./registryProfiles";
import { registrySamCanonicalHash, registrySamEvidenceHash, SAM_SNAPSHOT, verifyRegistrySam, type RegistrySamCorroboration } from "./registrySam";

// Synthetic fixtures and witnesses only; no source-read or publication claim.
const now = new Date("2026-10-02T12:00:00Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const identity = { legalName: "Example Services", addressLine1: "5310 Example Rd.", addressLine2: "Ste G07", city: "Arvada", state: "CO", postalCode: "80002" };
  const sourceRow = { ...identity, registration_number: "123456", filing_date: "2009-03-18", lien_type: "ucc" }, evidence = JSON.stringify(sourceRow);
  const row = parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "registry", kind: "ops_profile",
    sourceUrl: "https://data.colorado.gov/resource/synthetic.json", evidence, detail: "An old filing does not establish current debt.",
    registryProfile: { version: 1, dataset: "co_ucc", recordId: "123456:789", sourceAsOf: "2026-09-29", observedAt: "2026-09-29T23:00:00Z",
      identity, facts: [{ field: "registration_number", value: "123456" }, { field: "filing_date", value: "2009-03-18" }, { field: "lien_type", value: "ucc" }],
      provenance: { rowSha256: sha(evidence), quote: evidence, sourceRow } } }, now);
  const company = { id: row.companyId, netsuite_internal_id: row.internalId, name: "Example Services", domain: "example.test" };
  const context: CompanyIdentityContext = { aliases: [], addresses: [], context: "" };
  const fields = Array<string>(142).fill("");
  Object.assign(fields, { 0: "AAAA1111BBBB", 3: "ABCDE", 5: "A", 8: "20260912", 9: "20250916", 11: "Example Innovative Services Inc",
    12: "EXAMPLE SERVICES", 15: "5310 Example Road", 16: "STE G07", 17: "ARVADA", 18: "CO", 19: "80002", 20: "1829", 21: "USA", 26: "https://www.example.test", 141: "!end" });
  return { row, company, context, fields };
}
type Fixture = ReturnType<typeof fixture>;
function proof(f: Fixture, overrides: Partial<Omit<RegistrySamCorroboration, "reader" | "reviewer">> = {}): RegistrySamCorroboration {
  const rawRow = f.fields.join("|") + "\n";
  const bare = { schema: SAM_SNAPSHOT.schema, archiveSha256: SAM_SNAPSHOT.archiveSha256, archiveMember: SAM_SNAPSHOT.archiveMember,
    lineNumber: 2, sourceAsOf: SAM_SNAPSHOT.sourceAsOf, observedAt: "2026-09-30T12:00:00Z", rawRow, rawRowSha256: sha(rawRow),
    canonicalIdentitySha256: registrySamCanonicalHash(f.company, f.context), nameComparison: "explicit_retained_dba_v1" as const, ...overrides };
  const evidenceSha256 = registrySamEvidenceHash(f.row, bare);
  return { ...bare, reader: { taskId: "/test/reader", reviewedAt: "2026-10-02T10:00:00Z", evidenceSha256 },
    reviewer: { taskId: "/test/reviewer", reviewedAt: "2026-10-02T10:01:00Z", evidenceSha256 } };
}
const check = (f: Fixture, p = proof(f)) => verifyRegistrySam(f.row, p, f.company, f.context, now);

describe("explicit retained SAM DBA association", () => {
  it("preserves separate legal/DBA roles, original country absence and old status/expiration", () => {
    const f = fixture(), before = JSON.stringify(f), result = check(f);
    expect(result.sam).toMatchObject({ legalName: "Example Innovative Services Inc", dbaName: "EXAMPLE SERVICES",
      targetNameRole: "sam_dba", targetRecordedName: "Example Services", comparison: "exact_domain_explicit_dba_physical_address",
      expirationDateRaw: "20260912", statusAsOfSnapshot: "A", canonicalAddresses: [] });
    expect(f.row.profile.identity).not.toHaveProperty("countryCode");
    expect(JSON.stringify(f)).toBe(before);
  });
  it("keeps the default legal-to-legal branch unchanged without opt-in", () => {
    const f = fixture(), p = proof(f), { nameComparison: _mode, reader: _r, reviewer: _v, ...bare } = p;
    const digest = registrySamEvidenceHash(f.row, bare);
    expect(() => check(f, { ...bare, reader: { ...p.reader, evidenceSha256: digest }, reviewer: { ...p.reviewer, evidenceSha256: digest } })).toThrow(/operators differ/);
  });
  it.each(["Example Services Inc", "Example Services LLC", "Example Energy Services", "Example Service", "Other Services", ""])("does not remove or add debtor name tokens: %s", value => {
    const f = fixture(); f.row.profile.identity.legalName = value;
    expect(() => check(f)).toThrow(/exact canonical brand/);
  });
  it.each(["Example Services Inc", "Example Services LLC", "Different Brand", "Example", ""])("requires the complete canonical brand: %s", value => {
    const f = fixture(); f.company.name = value;
    expect(() => check(f)).toThrow(/exact canonical brand/);
  });
  it.each(["", " ", "Example Services Inc", "Example Services / Another Brand", "Different Services"])("rejects incomplete/different explicit DBA: %s", value => {
    const f = fixture(); f.fields[12] = value;
    expect(() => check(f)).toThrow(/exact canonical brand/);
  });
  it("accepts only case/punctuation normalization while preserving non-ASCII tokens", () => {
    const f = fixture(); f.fields[12] = "Éxample Services"; f.company.name = "ÉXAMPLE SERVICES"; f.row.profile.identity.legalName = "Éxample-Services";
    expect(check(f).sam?.targetNameRole).toBe("sam_dba");
    f.row.profile.identity.legalName = "Example Services";
    expect(() => check(f)).toThrow(/exact canonical brand/);
  });
  it.each(["Different Operator Inc", "Example Services Inc", "Example Innovative Services LLC"])("does not override a conflicting canonical legal alias: %s", alias => {
    const f = fixture(); f.context.aliases = [alias];
    expect(() => check(f)).toThrow(/known canonical legal/);
  });
  it("permits an exact known SAM legal alias without changing it", () => {
    const f = fixture(); f.context.aliases = [f.fields[11], f.fields[12]];
    expect(check(f).sam?.targetNameRole).toBe("sam_dba");
    expect(f.context.aliases).toEqual(["Example Innovative Services Inc", "EXAMPLE SERVICES"]);
  });
  it.each([[15, "5311 Example Rd"], [16, "STE 200"], [16, ""], [17, "Denver"], [18, "MN"], [19, "80403"], [21, "CAN"],
    [26, "unrelated.test"], [26, "other.example.test"], [26, "example.test.evil.test"], [5, "I"], [11, ""]])("retains domain/status/legal/physical field %s gate", (index, value) => {
    const f = fixture(); f.fields[Number(index)] = String(value);
    expect(() => check(f)).toThrow();
  });
  it("does not replace the physical suite with a separately supplied mailing suite", () => {
    const f = fixture(); f.fields[16] = "STE 200"; f.fields[40] = "5310 Example Road"; f.fields[41] = "STE G07";
    expect(() => check(f)).toThrow(/physical address/);
  });
  it("retains two-sided ZIP4 conflicts", () => {
    const f = fixture(); f.row.profile.identity.postalCode = "80002-1830";
    expect(() => check(f)).toThrow(/physical address/);
  });
  it.each(["fmcsa", "co_sos", "cms_nppes"])("does not silently extend this debtor-role mode to %s", dataset => {
    const f = fixture(); f.row.profile.dataset = dataset;
    expect(() => check(f)).toThrow(/recorded UCC debtor/);
  });
  it.each(["mode removed", "mode changed", "mode null", "mode undefined", "mode added field"])("rejects altered opt-in proof: %s", changed => {
    const f = fixture(), p = proof(f);
    if (changed === "mode removed") delete p.nameComparison;
    if (changed === "mode changed") Object.assign(p, { nameComparison: "loose_dba" });
    if (changed === "mode null") Object.assign(p, { nameComparison: null });
    if (changed === "mode undefined") Object.assign(p, { nameComparison: undefined });
    if (changed === "mode added field") Object.assign(p, { legalNameOverride: f.fields[11] });
    expect(() => check(f, p)).toThrow(/invalid retained|review/);
  });
  it.each(["detail", "fact", "evidence", "canonical", "raw DBA", "archive", "same reviewer", "wrong digest"])("keeps exact proof fencing for %s", change => {
    const f = fixture(), p = proof(f);
    if (change === "detail") f.row.detail = "Changed";
    if (change === "fact") f.row.profile.facts[0].value = "987654";
    if (change === "evidence") f.row.evidence += " changed";
    if (change === "canonical") f.context.aliases = [f.fields[11]];
    if (change === "raw DBA") { p.rawRow = p.rawRow.replace("EXAMPLE SERVICES", "OTHER SERVICES"); p.rawRowSha256 = sha(p.rawRow); }
    if (change === "archive") p.archiveSha256 = "f".repeat(64);
    if (change === "same reviewer") p.reviewer.taskId = p.reader.taskId;
    if (change === "wrong digest") p.reviewer.evidenceSha256 = "f".repeat(64);
    expect(() => check(f, p)).toThrow();
  });
  it("keeps omitted-nameComparison legacy evidence hashes byte-compatible", () => {
    const f = fixture(), { nameComparison: _m, reader: _r, reviewer: _v, ...bare } = proof(f);
    const oldHash = sha(stableRegistryJson({ companyId: f.row.companyId, internalId: f.row.internalId,
      contentHash: registryContentHash(f.row.profile, f.row.sourceUrl, f.row.detail), evidenceSha256: sha(f.row.evidence), observedAt: f.row.profile.observedAt, proof: bare }));
    expect(registrySamEvidenceHash(f.row, bare)).toBe(oldHash);
  });
  it("does not make the new result a prior-binding bypass", () => {
    const f = fixture(), old = structuredClone(f.row.profile); old.verification = check(f);
    old.publication = { contentHash: "a".repeat(64), eventId: "synthetic", publishedAt: now.toISOString() };
    expect(verifyRegistryIdentity(f.row.profile, f.company, f.context, [old], now)).toBeNull();
  });
});
