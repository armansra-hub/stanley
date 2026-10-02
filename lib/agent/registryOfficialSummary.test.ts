import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import fixtures from "../../test/fixtures/registry-official-summary.json";
import catalog from "./registryOfficialSummaries.json";
import { parseRegistryFinding, registryContentHash, type RegistryFinding } from "./registryProfiles";
import { registryOfficialHistoryCanonicalHash, registryOfficialHistoryEvidenceHash, registryOfficialSummaryEntry, verifyRegistryOfficialHistory } from "./registryOfficialHistory";

const now = new Date("2026-10-01T10:00:00Z"), reviewedAt = "2026-10-01T09:55:00Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function setup(index = 0) {
  const f = structuredClone(fixtures.cases[index]);
  return { f, row: parseRegistryFinding(f.finding, now), company: f.company, context: f.context as CompanyIdentityContext };
}
function proof(r: RegistryFinding, index = 0, company = setup(index).company, context = setup(index).context) {
  const meta = registryOfficialSummaryEntry(fixtures.cases[index].entryId);
  const p = { schema: "colorado_sos_summary_roles_v1" as const, entryId: meta.entry.id, entrySha256: meta.sha256,
    canonicalIdentitySha256: registryOfficialHistoryCanonicalHash(company, context), targetAddressRole: "principal_street" as const };
  const evidenceSha256 = registryOfficialHistoryEvidenceHash(r, p);
  return { ...p, reader: { taskId: "/unit-test/reader", reviewedAt, evidenceSha256 }, reviewer: { taskId: "/unit-test/reviewer", reviewedAt, evidenceSha256 } };
}
describe("reviewed Colorado entity-summary address roles", () => {
  it.each([0, 1])("admits exact retained case %i without changing original content", index => {
    const { row, company, context } = setup(index), before = JSON.stringify(row), contentHash = registryContentHash(row.profile, row.sourceUrl, row.detail);
    const result = verifyRegistryOfficialHistory(row, proof(row, index), company, context, now);
    expect(result.method).toBe("reviewed_official_registration_history");
    expect(result.officialHistory?.targetAddress).toMatchObject({ role: "principal_street", addressLine1: row.profile.identity.addressLine1 });
    expect(result.officialHistory?.canonicalAnchorRoles).toMatchObject({ mode: index ? "principal_street_plus_mailing" : "single_explicit_role" });
    expect(result.officialHistory?.scope).toContain("registered-agent addresses are not operating-location claims");
    expect(JSON.stringify(row)).toBe(before); expect(registryContentHash(row.profile, row.sourceUrl, row.detail)).toBe(contentHash);
  });
  it.each(["companyId", "internalId", "sourceUrl", "evidence", "detail", "observedAt", "rowSha256"])("rejects changed exact publication %s with old witness", field => {
    const { row, company, context } = setup(), p = proof(row);
    if (field === "observedAt") row.profile.observedAt = "2026-10-01T09:56:00Z";
    else if (field === "rowSha256") row.profile.provenance.rowSha256 = "0".repeat(64);
    else (row as unknown as Record<string, unknown>)[field] += "changed";
    expect(() => verifyRegistryOfficialHistory(row, p, company, context, now)).toThrow();
  });
  it.each([
    { legalName: "Forte Advertising, Inc." }, { addressLine1: "1422 Delgany St Ste LL4" },
    { addressLine1: "1422 Delgany St" }, { city: "Other" }, { state: "CA" },
    { postalCode: "80203" }, { countryCode: "CA" },
  ])("rejects newly witnessed replacement original %j", delta => {
    const { row, company, context } = setup(); Object.assign(row.profile.identity, delta); Object.assign(row.profile.provenance.sourceRow, delta);
    expect(() => verifyRegistryOfficialHistory(row, proof(row), company, context, now)).toThrow(/original/);
  });
  it("rejects replaced raw evidence even with internally refreshed row hash and witnesses", () => {
    const { row, company, context } = setup(), raw = JSON.parse(row.evidence); raw.entityid = "20061350491";
    row.evidence = JSON.stringify(raw); row.profile.provenance.quote = row.evidence; row.profile.provenance.rowSha256 = sha(row.evidence);
    expect(() => verifyRegistryOfficialHistory(row, proof(row), company, context, now)).toThrow(/original/);
  });
  it.each(["dataset", "recordId", "sourceAsOf"])("rejects newly witnessed changed target %s", key => {
    const { row, company, context } = setup(); (row.profile as unknown as Record<string, unknown>)[key] = key === "dataset" ? "fmcsa" : "other";
    expect(() => verifyRegistryOfficialHistory(row, proof(row), company, context, now)).toThrow(/original/);
  });
  it("rejects changed source facts and source-row fields after renewed witnesses", () => {
    for (const field of ["facts", "sourceRow"] as const) {
      const { row, company, context } = setup();
      if (field === "facts") row.profile.facts[0].value = "different"; else row.profile.provenance.sourceRow.entity_status = "different";
      expect(() => verifyRegistryOfficialHistory(row, proof(row), company, context, now)).toThrow(/original/);
    }
  });
  it.each(["name", "domain", "id", "netsuite_internal_id"])("rejects newly witnessed changed company %s", field => {
    const { row, company, context } = setup(); const changed = { ...company, [field]: "Unrelated" };
    expect(() => verifyRegistryOfficialHistory(row, proof(row, 0, changed), changed, context, now)).toThrow(/canonical/);
  });
  it.each(["addressLine1", "city", "state", "postalCode", "countryCode", "sourceId", "sourceKind", "capturedAt"])("rejects newly witnessed changed anchor %s", field => {
    const { row, company, context } = setup(); (context.addresses[0] as unknown as Record<string, unknown>)[field] = "changed";
    expect(() => verifyRegistryOfficialHistory(row, proof(row, 0, company, context), company, context, now)).toThrow(/canonical/);
  });
  it("rejects canonical alias conflict, missing/duplicate anchors and cross-company catalog selection", () => {
    for (const mutate of [(ctx: CompanyIdentityContext) => ctx.aliases.push("Other LLC"), (ctx: CompanyIdentityContext) => ctx.addresses.pop(), (ctx: CompanyIdentityContext) => ctx.addresses.push({ ...ctx.addresses[0] })]) {
      const { row, company, context } = setup(); mutate(context);
      expect(() => verifyRegistryOfficialHistory(row, proof(row, 0, company, context), company, context, now)).toThrow(/canonical/);
    }
    const { row, company, context } = setup(); expect(() => verifyRegistryOfficialHistory(row, proof(row, 1), company, context, now)).toThrow();
  });
  it.each(["215 Broadway", "PO Box 5830", "PO Box 5830 215 Broadway", "215 Broadway PO Box 5831", "215 Broadway PO Box 5830 Suite 2"])("never strips or invents Urge composition %s", line => {
    const { row, company, context } = setup(1); context.addresses[0].addressLine1 = line;
    expect(() => verifyRegistryOfficialHistory(row, proof(row, 1, company, context), company, context, now)).toThrow(/canonical/);
  });
  it("rejects unknown catalog, role, source transcription and hash supplied by caller", () => {
    const { row, company, context } = setup();
    for (const delta of [{ entryId: "unknown" }, { entrySha256: "0".repeat(64) }, { targetAddressRole: "registered_agent_street" }, { address: {} }, { sourceUrl: "https://evil.test" }, { anchorRole: "principal_mailing" }])
      expect(() => verifyRegistryOfficialHistory(row, { ...proof(row), ...delta }, company, context, now)).toThrow();
  });
  it("rejects changed/same-task/early/future/stale final witnesses", () => {
    const { row, company, context } = setup();
    for (const delta of [{ taskId: "/unit-test/reader" }, { evidenceSha256: "0".repeat(64) }, { reviewedAt: "2026-10-01T08:22:00Z" }, { reviewedAt: "2026-10-01T10:02:00Z" }]) {
      const p = proof(row); Object.assign(p.reviewer, delta); expect(() => verifyRegistryOfficialHistory(row, p, company, context, now)).toThrow(/review/);
    }
    expect(() => verifyRegistryOfficialHistory(row, proof(row), company, context, new Date("2026-10-09T00:00:00Z"))).toThrow(/review/);
  });
  it("does not expose mutable catalog state", () => {
    const meta = registryOfficialSummaryEntry(fixtures.cases[0].entryId); meta.entry.addresses.principal_street.addressLine1 = "different";
    expect(registryOfficialSummaryEntry(meta.entry.id).entry.addresses.principal_street.addressLine1).toBe("1422 Delgany St Ste LL3");
  });
  it.each(["official_url", "entity_query", "source_reader", "source_date", "role", "mail_unit"])("fails closed on corrupt trusted catalog %s", async kind => {
    const changed = structuredClone(catalog), index = kind === "mail_unit" ? 1 : 0, entry = changed.entries[index];
    if (kind === "official_url") entry.source.finalUrl = entry.source.finalUrl.replace("www.coloradosos.gov", "unrelated.test");
    if (kind === "entity_query") entry.source.finalUrl += "&entityId2=99999999999";
    if (kind === "source_reader") entry.sourceReviewer.taskId = entry.sourceReader.taskId;
    if (kind === "source_date") entry.sourceReviewer.reviewedAt = "2026-09-01T00:00:00Z";
    if (kind === "role") entry.anchor.role = "invented";
    if (kind === "mail_unit") Object.assign(entry.addresses.principal_mailing, { addressLine2: "Unit 9" });
    vi.resetModules(); vi.doMock("./registryOfficialSummaries.json", () => ({ default: changed }));
    try {
      const module = await import("./registryOfficialHistory"), { row, company, context } = setup(index), p = proof(row, index);
      p.entrySha256 = module.registryOfficialSummaryEntry(entry.id).sha256;
      const { reader, reviewer, ...bare } = p; const bound = module.registryOfficialHistoryEvidenceHash(row, bare);
      reader.evidenceSha256 = bound; reviewer.evidenceSha256 = bound;
      expect(() => module.verifyRegistryOfficialHistory(row, p, company, context, now)).toThrow();
    } finally { vi.doUnmock("./registryOfficialSummaries.json"); vi.resetModules(); }
  });
});
