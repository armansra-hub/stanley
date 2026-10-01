import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import fixtures from "../../test/fixtures/registry-official-api.json";
import { parseRegistryFinding, registryContentHash, stableRegistryJson } from "./registryProfiles";
import { registrySamCanonicalHash } from "./registrySam";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import type { RegistryOfficialApiEntry } from "./registryOfficialApi";

const now = new Date("2026-10-01T10:30:00Z"), reviewedAt = "2026-10-01T10:25:00Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function setup(index = 0) {
  const f = structuredClone(fixtures.cases[index]), context = { ...f.context, context: "" } as CompanyIdentityContext;
  const entry = f.entry as unknown as RegistryOfficialApiEntry;
  entry.canonicalIdentitySha256 = registrySamCanonicalHash(f.company, context);
  vi.resetModules(); vi.doMock("./registryOfficialApiEntries.json", () => ({ default: { version: 1, entries: [entry] } }));
  const api = await import("./registryOfficialApi"), route = await import("./registryOfficialHistory");
  const row = parseRegistryFinding({ ...f.finding, registryProfile: f.finding.profile, source: "registry", kind: "ops_profile" }, now);
  const proof = () => {
    const bare = { schema: "official_api_roles_v1" as const, entryId: entry.id, entrySha256: api.registryOfficialApiEntry(entry.id).sha256, canonicalIdentitySha256: entry.canonicalIdentitySha256 };
    const evidenceSha256 = api.registryOfficialApiEvidenceHash(row, bare);
    return { ...bare, reader: { taskId: "/test/final-primary", reviewedAt, evidenceSha256 }, reviewer: { taskId: "/test/final-independent", reviewedAt, evidenceSha256 } };
  };
  const check = (p = proof()) => route.verifyRegistryOfficialHistory(row, p, f.company, context, now);
  const mutateRaw = (delta: Record<string, string | undefined>) => { entry.source.rawRow = JSON.stringify({ ...JSON.parse(entry.source.rawRow), ...delta }); entry.source.rawRowSha256 = sha(entry.source.rawRow); entry.source.byteLength = Buffer.byteLength(entry.source.rawRow); };
  const rebindContext = () => { entry.canonicalIdentitySha256 = registrySamCanonicalHash(f.company, context); };
  return { ...f, context, entry, row, api, route, proof, check, mutateRaw, rebindContext };
}
describe("reviewed official API role capability", () => {
  it.each([0, 1, 2, 3, 4])("accepts real retained fixture %i with explicitly test-only witnesses", async i => {
    const f = await setup(i), before = JSON.stringify(f.row), content = registryContentHash(f.row.profile, f.row.sourceUrl, f.row.detail);
    const result = f.check(); expect(result.method).toBe("reviewed_official_registration_history");
    expect(result.officialHistory?.targetAddress).toMatchObject({ role: i < 3 ? "principal_street" : "carrier_physical", addressLine1: f.row.profile.identity.addressLine1 });
    expect(result.officialHistory?.scope).toContain("not operating locations");
    expect(JSON.stringify(f.row)).toBe(before); expect(registryContentHash(f.row.profile, f.row.sourceUrl, f.row.detail)).toBe(content);
    const { reader, reviewer, ...bare } = f.proof(); expect(f.route.registryOfficialHistoryEvidenceHash(f.row, bare)).toBe(reader.evidenceSha256);
  });
  it.each(["companyId", "internalId", "sourceUrl", "evidence", "detail"])("rejects changed final %s with old witnesses", async key => {
    const f = await setup(), p = f.proof(); (f.row as unknown as Record<string, unknown>)[key] += "changed"; expect(() => f.check(p)).toThrow();
  });
  it.each(["identity", "facts", "sourceRow", "observedAt", "sourceAsOf", "recordId"])("rejects changed original %s after refreshed final witnesses", async key => {
    const f = await setup();
    if (key === "identity") f.row.profile.identity.addressLine1 = "other";
    else if (key === "facts") f.row.profile.facts[0].value = "other";
    else if (key === "sourceRow") f.row.profile.provenance.sourceRow.legalName = "other";
    else (f.row.profile as unknown as Record<string, unknown>)[key] = "other";
    expect(() => f.check()).toThrow();
  });
  it.each(["?entityid=20031150417&entityid=20031150417", "?entityid=20031150417&unknown=1", "?entityid=20031150417#fragment", "?entityid=99999999999"])("rejects altered original CO URL %s even when target pin is changed", async suffix => {
    const f = await setup(); f.row.sourceUrl = f.entry.target.sourceUrl = "https://data.colorado.gov/resource/4ykn-tg5h.json" + suffix; expect(() => f.check()).toThrow(/URL/);
  });
  it.each(["&query_string=1632717", "&unknown=1", "#fragment", "ID"])("rejects altered original SAFER URL %s with revised target pin", async suffix => {
    const f = await setup(3); f.row.sourceUrl = f.entry.target.sourceUrl = suffix === "ID" ? f.row.sourceUrl.replace("1632717", "999") : f.row.sourceUrl + suffix; expect(() => f.check()).toThrow(/URL/);
  });
  it.each([{ legal_name: "WINDHAVEN INTERNATIONAL INC" }, { dot_number: "999999" }, { phy_street: "1525 W LAKE SHORE DR" }, { phy_city: "Woodstock" }, { phy_zip: "60098-6917" }, { dba_name: "NEW DBA" }])("rejects changed source ID/legal/physical/DBA despite fresh catalog and witnesses %j", async delta => {
    const f = await setup(3); f.mutateRaw(delta); expect(() => f.check()).toThrow();
  });
  it.each([{ mailingaddress1: "PO Box 100953" }, { mailingaddress2: "Unit 1" }, { mailingcity: "Denvar" }, { mailingstate: "CA" }, { mailingzipcode: "80251" }, { mailingcountry: "CA" }])("rejects source mailing conflict %j", async delta => {
    const f = await setup(); f.mutateRaw(delta); expect(() => f.check()).toThrow(/anchor/);
  });
  it("preserves explicit postal extension conflicts and rejects missing units", async () => {
    const f = await setup(3); f.mutateRaw({ carrier_mailing_zip: "60098-1111" }); expect(() => f.check()).toThrow(/anchor/);
  });
  it.each(["role", "sourceId", "no_anchor", "duplicate_anchor", "agent_to_carrier"])("rejects role confusion %s", async kind => {
    const f = await setup(1);
    if (f.entry.anchor.mode !== "address_role") throw Error("fixture");
    if (kind === "role") f.entry.anchor.role = "entity_mailing";
    if (kind === "sourceId") f.entry.anchor.sourceId = "other";
    if (kind === "no_anchor") f.context.addresses = [];
    if (kind === "duplicate_anchor") f.context.addresses.push({ ...f.context.addresses[0] });
    if (kind === "agent_to_carrier") f.entry.anchor.role = "carrier_mailing";
    f.rebindContext(); expect(() => f.check()).toThrow();
  });
  it.each(["other.test", "gmail.com", "sub.gmail.com", "tenant.onmicrosoft.com", "host.wordpress.com"])("rejects noncorporate or changed email domain %s", async domain => {
    const f = await setup(4); f.company.domain = domain; f.entry.canonicalDomain = domain; f.rebindContext(); f.mutateRaw({ email_address: "a@" + domain });
    if (domain === "other.test") { f.company.domain = fixtures.cases[4].company.domain; f.rebindContext(); }
    expect(() => f.check()).toThrow();
  });
  it.each(["A <x@ggenterprises.biz>", "x@ggenterprises.biz, y@ggenterprises.biz", "x@sub.ggenterprises.biz", "x@ggenterprises.biz.evil.test", "x@ggenterprises.biz.", ".x@ggenterprises.biz", "x..x@ggenterprises.biz"])("rejects malformed or nonexact email %s", async email => {
    const f = await setup(4); f.mutateRaw({ email_address: email }); expect(() => f.check()).toThrow(/email/);
  });
  it("rejects phone-only contact and Colorado email mode", async () => {
    for (const i of [0, 4]) { const f = await setup(i); f.entry.anchor = { mode: "company_email_domain" }; f.mutateRaw({ email_address: "", phone: "5555555555" }); expect(() => f.check()).toThrow(); }
  });
  it.each(["GROWTH PARTNERS INC", "Other LLC"])("rejects conflicting known alias %s even with repinned canonical context", async name => {
    const f = await setup(); f.context.aliases.push(name); f.rebindContext(); expect(() => f.check()).toThrow(/operator conflict/);
  });
  it("requires positive canonical name or whole raw DBA despite matching email", async () => {
    const f = await setup(4); f.company.name = "G&G"; f.rebindContext(); expect(() => f.check()).toThrow(/operator conflict/);
  });
  it.each(["same_actor", "early_source", "early_original", "bad_receipt", "changed_hash", "same_final", "early_final", "future_final", "unknown_proof", "wrong_entry", "raw_hash", "capture_url"])("rejects broken provenance or witness %s", async kind => {
    const f = await setup(); let p;
    if (kind === "same_actor") f.entry.sourceReviewer.taskId = f.entry.sourceReader.taskId;
    if (kind === "early_source") f.entry.sourceReviewer.reviewedAt = "2026-09-01T00:00:00Z";
    if (kind === "early_original") f.entry.originalReviews.independent.reviewedAt = "2026-10-01T10:29:00Z";
    if (kind === "bad_receipt") f.entry.originalReviews.primary.receiptSha256 = "unknown";
    if (kind === "raw_hash") f.entry.source.rawRowSha256 = "0".repeat(64);
    if (kind === "capture_url") f.entry.source.requestedUrl = f.entry.source.finalUrl = f.entry.source.requestedUrl.replace("data.colorado.gov", "example.com");
    p = f.proof();
    if (kind === "changed_hash") p.reviewer.evidenceSha256 = "0".repeat(64);
    if (kind === "same_final") p.reviewer.taskId = p.reader.taskId;
    if (kind === "early_final") p.reviewer.reviewedAt = "2026-10-01T10:00:00Z";
    if (kind === "future_final") p.reviewer.reviewedAt = "2026-10-01T10:32:00Z";
    if (kind === "unknown_proof") Object.assign(p, { rawRow: f.entry.source.rawRow });
    if (kind === "wrong_entry") p.entryId = "unknown";
    expect(() => f.check(p)).toThrow();
  });
  it("returns a copy rather than mutable trusted entry", async () => { const f = await setup(); f.api.registryOfficialApiEntry(f.entry.id).entry.source.rawRow = "other"; expect(f.api.registryOfficialApiEntry(f.entry.id).entry.source.rawRow).toBe(f.entry.source.rawRow); });
});
