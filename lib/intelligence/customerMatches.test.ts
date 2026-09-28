import { describe, expect, it } from "vitest";
import { rankCustomerMatches, CUSTOMER_PATTERNS, type CustomerMatchCandidate, type CustomerReference } from "./customerMatches";
import { OPERATING_FACETS } from "./operatingCatalog";

const now = Date.parse("2026-09-28T12:00:00Z");
const reference = (id = "teleco", facts = ["rr_c01", "rr_i01", "rr_c05"]): CustomerReference => ({
  id, name: id, domain: `${id}.test`, website: `https://${id}.test`, announcementDate: "2026-07-31",
  announcementType: "new_customer", catalogVersion: "current", completedAt: "2026-09-28", status: "verified",
  sources: [{ url: `https://${id}.test/services`, title: "Services", contentHash: "hash" }],
  answers: Object.fromEntries(OPERATING_FACETS.map(f => [f.id, { decision: facts.includes(f.id) ? "supported" : "insufficient_evidence",
    nativeResult: {}, facetVersion: "current", sourceUrls: [`https://${id}.test/services`] }])),
});
const candidate = (id = "company-1", facts = ["rr_c01", "rr_i01"]): CustomerMatchCandidate => ({ companyId: id, name: id,
  domain: `${id}.test`, subindustry: "Business Services", internalId: "123", status: "new", decisions: Object.fromEntries(facts.map(f => [f, "supported"])), whyNow: [] });
const rank = (candidates: CustomerMatchCandidate[], references = [reference()], extra = {}) => rankCustomerMatches({ candidates, references,
  asOf: "2026-09-24", referenceTotal: references.length, now, ...extra });

describe("recent-customer cached ranking", () => {
  it("offers nine views and requires complete supported combinations on both entities", () => {
    expect(CUSTOMER_PATTERNS).toHaveLength(9);
    expect(rank([candidate()]).accounts).toHaveLength(1);
    expect(rank([candidate("generic", ["rr_c01"])]).accounts).toHaveLength(0);
    expect(rank([candidate()], [reference("generic", ["rr_c01"]) ]).accounts).toHaveLength(0);
  });
  it("never turns unsupported/unknown reference traits into matches", () => {
    const r = reference(); r.answers.rr_i01.decision = "insufficient_evidence";
    expect(rank([candidate()], [r]).accounts).toHaveLength(0);
    r.answers.rr_i01.decision = "not_supported";
    expect(rank([candidate()], [r]).accounts).toHaveLength(0);
  });
  it("separates an unknown prospect trait from an explicit contradictory answer", () => {
    const unknown = rank([candidate()]).accounts[0];
    expect(unknown.reference.unknownTraits.map(t => t.id)).toEqual(["rr_c05"]);
    expect(unknown.reference.differentTraits).toEqual([]);
    const c = candidate(); c.decisions.rr_c05 = "not_supported";
    const different = rank([c]).accounts[0];
    expect(different.reference.unknownTraits).toEqual([]);
    expect(different.reference.differentTraits.map(t => t.id)).toEqual(["rr_c05"]);
  });
  it("does not match cleaning/creative industries from a name, domain or broad category", () => {
    const r = reference("cleaners", ["rr_c05", "rr_f01"]); r.subindustry = "Facilities Management & Commercial Cleaning";
    const c = candidate("Cleaning Company", ["rr_c05", "rr_f01"]);
    expect(rank([c], [r], { pattern: "facilities" }).accounts).toEqual([]);
    c.subindustry = "Facilities Management & Commercial Cleaning";
    expect(rank([c], [r], { pattern: "facilities" }).accounts[0].fit.industryBasis).toContain("Recorded CRM");
  });
  it("keeps unique companies, deduplicates buying programs and excludes renewal-only references", () => {
    const recent = reference("recent"); recent.buyingProgramId = "program"; recent.announcementDate = "2026-09-01";
    const older = reference("older"); older.buyingProgramId = "program";
    const renewal = reference("renewal"); renewal.announcementType = "renewal";
    const result = rank([candidate(), candidate()], [older, recent, renewal]);
    expect(result.total).toBe(1); expect(result.referenceCoverage.verified).toBe(1);
    expect(result.accounts[0].reference.id).toBe("recent");
    expect(result.patterns.find(p => p.id === "integrators")?.count).toBe(1);
  });
  it("does not inflate fit using unrelated category count", () => {
    const base = candidate("a"), bloated = candidate("z", [...OPERATING_FACETS.map(f => f.id)].filter(id => !["rr_c05", "rr_c06"].includes(id)));
    const result = rank([bloated, base]);
    expect(result.accounts.map(a => a.companyId)).toEqual(["a", "z"]);
  });
  it("uses actual known peer answers for the baseline, excluding unassessed companies", () => {
    const yes = candidate(), no = candidate("no", ["rr_i01"]), unknown = candidate("unknown", ["rr_i01"]);
    no.decisions.rr_c01 = "not_supported";
    const result = rank([yes, no, unknown]);
    expect(result.accounts[0].fit.rarity).toEqual({ matched: 1, assessed: 2 });
  });
  it("places dated why-now ahead within comparable fit without changing the fit facts", () => {
    const c = candidate("z"); c.whyNow = [{ id: "event", label: "Acquisition", eventDate: "2026-09-20", sourceUrl: "https://z.test/news" }];
    const result = rank([candidate("a"), c]);
    expect(result.accounts.map(a => a.companyId)).toEqual(["z", "a"]);
    expect(result.accounts[0].reference.sharedTraits).toEqual(result.accounts[1].reference.sharedTraits);
  });
  it("paginates every matching account beyond1000 without duplicates or a total limit", () => {
    const candidates = Array.from({ length: 1051 }, (_, i) => candidate(String(i).padStart(6, "0")));
    const first = rank(candidates), last = rank(candidates, [reference()], { page: 43 });
    expect(first).toMatchObject({ total: 1051, pageSize: 25, hasMore: true });
    expect(last).toMatchObject({ total: 1051, page: 43, hasMore: false });
    expect(last.accounts.map(a => a.companyId)).toEqual(["001050"]);
  });
  it("retains a sourced old customer as dated context but favors recent comparable references", () => {
    const old = reference("old"); old.announcementDate = "2024-07-26";
    expect(rank([candidate()], [old]).accounts[0].reference.announcementDate).toBe("2024-07-26");
    expect(rank([candidate()], [old, reference()]).accounts[0].reference.id).toBe("teleco");
  });
  it("keeps owned-fleet evidence distinct from non-asset assertions", () => {
    const r = reference("fleet", ["rr_t01", "rr_t02", "rr_t04"]);
    const result = rank([candidate("broker", ["rr_t01", "rr_t04"])], [r]);
    expect(result.accounts[0].primaryPattern.branchLabel).toContain("asset ownership not inferred");
    expect(result.accounts[0].reference.unknownTraits.map(t => t.id)).toContain("rr_t02");
  });
});
