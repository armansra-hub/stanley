import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { parseRegistryFinding, registryContentHash, verifyRegistryIdentity } from "./registryProfiles";
import { registrySamCanonicalHash, registrySamEvidenceHash, SAM_SNAPSHOT, verifyRegistrySam, type RegistrySamCorroboration } from "./registrySam";

// Synthetic public-source shapes only: no production records, source files,
// credentials, network access or actual source-review attestations.
const now = new Date("2026-09-30T12:00:00Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const identity = { legalName: "Example Transport Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701-0123", countryCode: "US" };
  const sourceRow = { ...identity, usdot_number: "12345", drivers: 12 }, evidence = JSON.stringify(sourceRow);
  const row = parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "registry", kind: "ops_profile",
    sourceUrl: "https://data.transportation.gov/resource/synthetic.json", evidence, detail: "Reported drivers are not total employees.",
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: "2026-09-28", observedAt: "2026-09-29T12:00:00Z",
      identity, facts: [{ field: "usdot_number", value: "12345" }, { field: "drivers", value: 12 }],
      provenance: { rowSha256: sha(evidence), quote: evidence, sourceRow } } }, now);
  const company = { id: row.companyId, netsuite_internal_id: row.internalId, name: "Example Transit", domain: "example.test", website_raw: "https://www.example.test/" };
  const context: CompanyIdentityContext = { aliases: [], addresses: [], context: "" };
  const fields = Array<string>(142).fill("");
  fields[0] = "AAAA1111BBBB"; fields[3] = "ABCDE"; fields[5] = "A";
  fields[8] = "20270701"; fields[9] = "20260701";
  fields[11] = "Example Transport Inc"; fields[12] = "Example Transit";
  fields[15] = "123 Main Street"; fields[16] = "Suite 4"; fields[17] = "Austin";
  fields[18] = "TX"; fields[19] = "78701"; fields[20] = "0123"; fields[21] = "USA";
  fields[26] = "https://www.example.test/"; fields[141] = "!end";
  return { row, company, context, fields };
}
type Fixture = ReturnType<typeof fixture>;
function proof(f: Fixture, overrides: Partial<Omit<RegistrySamCorroboration, "reader" | "reviewer">> = {}): RegistrySamCorroboration {
  const rawRow = f.fields.join("|") + "\r\n";
  const evidence = { schema: SAM_SNAPSHOT.schema, archiveSha256: SAM_SNAPSHOT.archiveSha256, archiveMember: SAM_SNAPSHOT.archiveMember,
    lineNumber: 2, sourceAsOf: SAM_SNAPSHOT.sourceAsOf, observedAt: "2026-09-29T13:00:00Z", rawRow, rawRowSha256: sha(rawRow),
    canonicalIdentitySha256: registrySamCanonicalHash(f.company, f.context), ...overrides };
  const evidenceSha256 = registrySamEvidenceHash(f.row, evidence);
  return { ...evidence,
    reader: { taskId: "/unit-test/synthetic-reader", reviewedAt: "2026-09-29T14:00:00Z", evidenceSha256 },
    reviewer: { taskId: "/unit-test/synthetic-reviewer", reviewedAt: "2026-09-29T14:01:00Z", evidenceSha256 } };
}
const verify = (f: Fixture, p = proof(f)) => verifyRegistrySam(f.row, p, f.company, f.context, now);

describe("retained SAM corroboration", () => {
  it("binds exact own-domain, target operator and full physical address while preserving original observations", () => {
    const f = fixture(), before = JSON.stringify(f), p = proof(f), contentHash = registryContentHash(f.row.profile, f.row.sourceUrl, f.row.detail);
    const result = verify(f, p);
    expect(result.method).toBe("reviewed_sam_domain_legal_address");
    expect(result.sam).toMatchObject({ uei: "AAAA1111BBBB", physicalAddress: { addressLine1: "123 Main Street", addressLine2: "Suite 4", postalCode: "78701-0123" }, rawRow: p.rawRow, sourceAsOf: SAM_SNAPSHOT.sourceAsOf });
    expect(result.website).toBeUndefined();
    expect(JSON.stringify(f)).toBe(before);
    expect(registryContentHash(f.row.profile, f.row.sourceUrl, f.row.detail)).toBe(contentHash);
  });
  it.each([
    [26, "unrelated.test", "domain"], [26, "example.test.attacker.test", "domain"], [26, "other.example.test", "domain"],
    [26, "https://attacker@example.test/", "physical record"], [26, "https://linkedin.com/company/example", "physical record"],
    [11, "Example Transport LLC", "operators"], [11, "Other Transport Inc", "operators"],
    [15, "124 Main Street", "physical address"], [16, "Suite 5", "physical address"], [16, "", "physical address"],
    [19, "78702", "physical address"], [20, "0124", "physical address"],
    [18, "OK", "physical address"], [17, "Dallas", "physical address"], [21, "CAN", "physical record"],
  ])("rejects a conflicting SAM field %s=%s even with a newly bound synthetic proof", (index, value, error) => {
    const f = fixture(); f.fields[Number(index)] = String(value);
    expect(() => verify(f)).toThrow(String(error));
  });
  it("does not let a DBA override a different target legal operator", () => {
    const f = fixture(); f.fields[12] = f.row.profile.identity.legalName; f.fields[11] = "Different Operator Inc";
    expect(() => verify(f)).toThrow("operators");
  });
  it.each(["canonical alias", "explicit corporate company name"])("keeps a known conflicting %s held", kind => {
    const f = fixture();
    if (kind === "canonical alias") f.context.aliases = ["Different Operator LLC"];
    else f.company.name = "Different Operator LLC";
    expect(() => verify(f)).toThrow("known canonical legal");
  });
  it.each(["detail", "fact", "target observation", "source evidence", "canonical identity", "raw row", "raw row plus new row hash"])("invalidates an existing approval when %s changes", changed => {
    const f = fixture(), p = proof(f);
    if (changed === "detail") f.row.detail = "Changed interpretation";
    if (changed === "fact") f.row.profile.facts[1].value = 99;
    if (changed === "target observation") f.row.profile.observedAt = "2026-09-29T12:30:00Z";
    if (changed === "source evidence") f.row.evidence += " changed";
    if (changed === "canonical identity") f.context.aliases = ["Example Transport Inc"];
    if (changed.startsWith("raw row")) p.rawRow = p.rawRow.replace("123 Main", "124 Main");
    if (changed === "raw row plus new row hash") p.rawRowSha256 = sha(p.rawRow);
    expect(() => verify(f, p)).toThrow(/review|identity changed|invalid retained/);
  });
  it("requires distinct reader identities and correct exact evidence bindings", () => {
    const f = fixture(), p = proof(f); p.reviewer.taskId = p.reader.taskId;
    expect(() => verify(f, p)).toThrow("independent review");
    const different = proof(f); different.reviewer.evidenceSha256 = "f".repeat(64);
    expect(() => verify(f, different)).toThrow("review");
  });
  it.each(["reader", "reviewer"] as const)("requires %s to follow target collection when it is later than SAM", role => {
    const f = fixture(); f.row.profile.observedAt = "2026-09-29T15:00:00Z";
    const p = proof(f); p.reader.reviewedAt = p.reviewer.reviewedAt = "2026-09-29T15:00:00Z";
    p[role].reviewedAt = "2026-09-29T14:59:59.999Z";
    expect(() => verify(f, p)).toThrow("review");
    p[role].reviewedAt = "2026-09-29T15:00:00Z";
    expect(verify(f, p).method).toBe("reviewed_sam_domain_legal_address");
  });
  it.each(["reader", "reviewer"] as const)("requires %s to follow SAM collection when it is later than target", role => {
    const f = fixture(), p = proof(f); p.reader.reviewedAt = p.reviewer.reviewedAt = "2026-09-29T13:00:00Z";
    p[role].reviewedAt = "2026-09-29T12:59:59.999Z";
    expect(() => verify(f, p)).toThrow("review");
    p[role].reviewedAt = "2026-09-29T13:00:00Z";
    expect(verify(f, p).method).toBe("reviewed_sam_domain_legal_address");
  });
  it("rejects stale or future reviews and an unpinned archive", () => {
    const f = fixture();
    for (const reviewedAt of ["2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z"]) {
      const p = proof(f); p.reviewer.reviewedAt = reviewedAt; expect(() => verify(f, p)).toThrow("review");
    }
    expect(() => verify(f, proof(f, { archiveSha256: "f".repeat(64) }))).toThrow("invalid retained");
  });
  it("cannot turn a stored SAM verification into a legacy prior-binding bypass", () => {
    const f = fixture(), old = structuredClone(f.row.profile); old.verification = verify(f);
    old.publication = { contentHash: "a".repeat(64), eventId: "synthetic-event", publishedAt: now.toISOString() };
    expect(verifyRegistryIdentity(f.row.profile, f.company, f.context, [old], now)).toBeNull();
  });
});
