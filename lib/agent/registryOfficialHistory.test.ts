import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import fixture from "../../test/fixtures/registry-official-history.json";
import { parseRegistryFinding, registryContentHash, verifyRegistryIdentity, type RegistryFinding } from "./registryProfiles";
import { registryOfficialHistoryBundle, registryOfficialHistoryCanonicalHash, registryOfficialHistoryEvidenceHash,
  verifyRegistryOfficialHistory, type RegistryOfficialHistoryCorroboration } from "./registryOfficialHistory";

const now = new Date("2026-10-01T04:00:00Z"), reviewedAt = "2026-10-01T03:00:00Z";
const company = fixture.company, context = fixture.context as CompanyIdentityContext;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function row(index = 0) { return parseRegistryFinding(structuredClone(fixture.findings[index]), now); }
function proof(r: RegistryFinding, c = company, ctx = context, key: RegistryOfficialHistoryCorroboration["addressEntryKey"] = "university_mailing_2006") {
  const bundle = registryOfficialHistoryBundle();
  const p = { schema: "colorado_sos_history_v1" as const, bundleId: bundle.id, bundleSha256: bundle.sha256,
    canonicalIdentitySha256: registryOfficialHistoryCanonicalHash(c, ctx), addressEntryKey: key };
  const evidenceSha256 = registryOfficialHistoryEvidenceHash(r, p);
  return { ...p, reader: { taskId: "/unit-test/reader", reviewedAt, evidenceSha256 }, reviewer: { taskId: "/unit-test/reviewer", reviewedAt, evidenceSha256 } };
}
function changeIdentity(r: RegistryFinding, fields: Partial<RegistryFinding["profile"]["identity"]>) {
  const raw = JSON.parse(r.evidence.split("\n")[0]);
  const keys = { legalName: "organizationname", addressLine1: "address1", addressLine2: "address2", city: "city", state: "state", postalCode: "zipcode" };
  for (const [key, value] of Object.entries(fields)) { const k = keys[key as keyof typeof keys]; if (k) raw[k] = value; }
  r.evidence = JSON.stringify(raw) + "\n" + r.evidence.split("\n")[1];
  Object.assign(r.profile.identity, fields); Object.assign(r.profile.provenance.sourceRow, fields);
  r.profile.provenance.quote = r.evidence; r.profile.provenance.rowSha256 = sha(JSON.stringify(raw));
}
describe("reviewed official Colorado registration/address history", () => {
  it.each([0, 1])("admits the exact public original candidate %i without rewriting source facts or hashes", i => {
    const r = row(i), before = JSON.stringify(r), hash = registryContentHash(r.profile, r.sourceUrl, r.detail);
    const result = verifyRegistryOfficialHistory(r, proof(r, company, context, i ? "girard_principal_observed_20261001" : "university_mailing_2006"), company, context, now);
    expect(result.method).toBe("reviewed_official_registration_history");
    expect(result.officialHistory?.addressEntry).toMatchObject({ role: i ? "principal_street" : "principal_mailing", sourceAsOf: i ? "2026-10-01" : "2006-01-03" });
    expect(JSON.stringify(r)).toBe(before); expect(registryContentHash(r.profile, r.sourceUrl, r.detail)).toBe(hash);
    expect(result.officialHistory?.bundle).toMatchObject({ entityId: "19961162961", sourceReviewer: { receiptSha256: "9f011428a1e8458300fd0ecfcfc08daff7d92503509c777827af02b3cc15ff9c" } });
  });
  it.each([
    { city: "Dever" }, { city: "Eenver" }, { city: "Kansas City" }, { postalCode: "80202" },
    { addressLine1: "2075 S UNIVERSITY" }, { addressLine1: "2076 S UNIVERSITY #289" },
    { addressLine1: "2075 N UNIVERSITY #289" }, { addressLine1: "2075 S UNIVERSITY #288" },
    { legalName: "ALLIANCE LEASING LLC" }, { legalName: "UNRELATED CORP." }, { countryCode: "CA" as const },
  ])("rejects a newly witnessed incompatible original identity %j", delta => {
    const r = row(); changeIdentity(r, delta);
    expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, now)).toThrow();
  });
  it("does not treat missing BLVD as a general equivalence or switch an address role", () => {
    const r = row(); changeIdentity(r, { addressLine1: "2075 S UNIVERSITY BLVD #289" });
    expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, now)).toThrow(/dated address/);
    const good = row(); expect(() => verifyRegistryOfficialHistory(good, proof(good, company, context, "girard_principal_observed_20261001"), company, context, now)).toThrow(/dated address/);
    good.profile.dataset = "fmcsa";
    expect(() => verifyRegistryOfficialHistory(good, proof(good), company, context, now)).toThrow(/UCC/);
  });
  it.each(["city", "state", "postalCode", "addressLine1", "countryCode", "sourceId"])("rejects missing canonical anchor %s even after reattestation", field => {
    const ctx = structuredClone(context); delete (ctx.addresses[0] as unknown as Record<string, unknown>)[field];
    const r = row(); expect(() => verifyRegistryOfficialHistory(r, proof(r, company, ctx), company, ctx, now)).toThrow(/anchor/);
  });
  it.each(["name", "domain", "id", "netsuite_internal_id"])("rejects newly witnessed unrelated canonical %s", field => {
    const c = { ...company, [field]: field === "name" ? "Unrelated" : "unrelated.test" };
    const r = row(); expect(() => verifyRegistryOfficialHistory(r, proof(r, c), c, context, now)).toThrow();
  });
  it("rejects known contradictory aliases and altered canonical provenance with stale witnesses", () => {
    const r = row(), ctx = structuredClone(context); ctx.aliases.push("Alliance Leasing LLC");
    expect(() => verifyRegistryOfficialHistory(r, proof(r, company, ctx), company, ctx, now)).toThrow(/operator/);
    const p = proof(r); ctx.aliases.pop(); ctx.addresses[0].capturedAt = "2026-08-01T00:00:00Z";
    expect(() => verifyRegistryOfficialHistory(r, p, company, ctx, now)).toThrow(/canonical/);
  });
  it.each(["detail", "sourceUrl", "evidence", "observedAt", "rowSha256"])("binds final content/provenance %s", field => {
    const r = row(), p = proof(r);
    if (field === "observedAt") r.profile.observedAt = "2026-09-30T00:00:00Z";
    else if (field === "rowSha256") r.profile.provenance.rowSha256 = "0".repeat(64);
    else (r as unknown as Record<string, unknown>)[field] += " changed";
    expect(() => verifyRegistryOfficialHistory(r, p, company, context, now)).toThrow(/review/);
  });
  it.each(["bundleSha256", "bundleId", "addressEntryKey", "schema"])("rejects a changed bundle selector %s", field => {
    const r = row(), p = { ...proof(r), [field]: "unknown" };
    expect(() => verifyRegistryOfficialHistory(r, p, company, context, now)).toThrow(/bundle/);
  });
  it("rejects caller-supplied transcription, roles, source hashes and PDF URLs", () => {
    const r = row();
    for (const key of ["address", "addressRole", "bodySha256", "sourceUrl", "entityId"]) {
      expect(() => verifyRegistryOfficialHistory(r, { ...proof(r), [key]: "invented" }, company, context, now)).toThrow(/bundle/);
    }
  });
  it("requires exact original country, raw debtor hash and target/filing identifiers", () => {
    for (const mutate of [(d: Record<string, string>) => { delete d.country; }, (d: Record<string, string>) => { d.country = "Canada"; }, (d: Record<string, string>) => { d.debtorid = "other"; }]) {
      const r = row(), raw = JSON.parse(r.evidence.split("\n")[0]); mutate(raw);
      r.evidence = JSON.stringify(raw) + "\n" + r.evidence.split("\n")[1]; r.profile.provenance.quote = r.evidence; r.profile.provenance.rowSha256 = sha(JSON.stringify(raw));
      expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, now)).toThrow(/UCC/);
    }
    const r = row(); r.profile.provenance.rowSha256 = "0".repeat(64);
    expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, now)).toThrow(/UCC/);
  });
  it("rejects same-task, changed hash, too early, future and stale witnesses", () => {
    const r = row();
    for (const delta of [{ taskId: "/unit-test/reader" }, { evidenceSha256: "0".repeat(64) },
      { reviewedAt: "2026-10-01T02:00:00Z" }, { reviewedAt: "2026-10-01T05:00:00Z" }]) {
      const p = proof(r); Object.assign(p.reviewer, delta);
      expect(() => verifyRegistryOfficialHistory(r, p, company, context, now)).toThrow();
    }
    expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, new Date("2026-10-09T00:00:00Z"))).toThrow(/review/);
    r.profile.observedAt = "2026-10-01T03:30:00Z";
    expect(() => verifyRegistryOfficialHistory(r, proof(r), company, context, now)).toThrow(/review/);
  });
  it("cannot bypass future review by reusing a stored history verification", () => {
    const r = row(), verified = { ...r.profile, verification: verifyRegistryOfficialHistory(r, proof(r), company, context, now) };
    expect(verifyRegistryIdentity(r.profile, company, context, [verified])).toBeNull();
  });
  it("does not expose mutable bundle state", () => {
    const meta = registryOfficialHistoryBundle(); (meta as { id: string }).id = "changed"; meta.addressEntryKeys.length = 0;
    expect(registryOfficialHistoryBundle().addressEntryKeys).toHaveLength(2);
    const r = row(); expect(verifyRegistryOfficialHistory(r, proof(r), company, context, now).method).toBe("reviewed_official_registration_history");
  });
});
