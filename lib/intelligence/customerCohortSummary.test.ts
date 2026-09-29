import { describe, expect, it } from "vitest";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, type OperatingFacetDecision } from "./operatingCatalog";
import { rankCustomerMatches, type CustomerReference } from "./customerMatches";
import { summarizeCustomerCohort } from "./customerCohortSummary";

const now = Date.parse("2026-09-29T00:00:00Z");
const reference = (id: string, decision: OperatingFacetDecision, changes: Partial<CustomerReference> = {}): CustomerReference => ({
  id, name: id, domain: "shared.example", website: "https://shared.example", announcementDate: "2026-09-01", announcementType: "new_customer",
  buyingProgramId: "shared-program", subindustry: "IT services", catalogVersion: OPERATING_CATALOG_VERSION, completedAt: "2026-09-28", status: "verified", sources: [],
  answers: Object.fromEntries(OPERATING_FACETS.map(facet => [facet.id, { decision, nativeResult: { choice: decision }, facetVersion: "version", sourceUrls: [] }])),
  ...changes,
});

describe("saved native customer cohort counts", () => {
  it("preserves all four native decisions and the complete denominator for every category", () => {
    const refs = (["supported", "not_supported", "insufficient_evidence", "conflicting"] as const).map((decision, index) => reference(String(index), decision));
    const before = structuredClone(refs);
    const result = summarizeCustomerCohort(refs, now);
    expect(result.customers).toBe(4);
    const group = result.industries[0];
    expect(group.all.customers).toBe(4);
    expect(Object.keys(group.all.traits)).toHaveLength(47);
    for (const count of Object.values(group.all.traits)) expect(count).toEqual({ supported: 1, not_supported: 1, insufficient_evidence: 1, conflicting: 1, unanswered: 0 });
    expect(refs).toEqual(before);
  });

  it("counts exact registered entities once while preserving distinct companies sharing a website or program", () => {
    const first = reference("first", "supported"), second = reference("second", "not_supported");
    const result = summarizeCustomerCohort([first, first, second], now);
    expect(result.customers).toBe(2);
    expect(result.industries[0].all.traits.rr_c01).toMatchObject({ supported: 1, not_supported: 1 });
  });

  it("separates recorded industries and unknown industry without guessing from company text", () => {
    const result = summarizeCustomerCohort([reference("it", "supported"), reference("freight", "supported", { subindustry: "Transportation" }),
      reference("unknown", "insufficient_evidence", { name: "IT Logistics", subindustry: undefined })], now);
    expect(result.industries.map(group => [group.industry, group.all.customers])).toEqual([["IT services", 1], ["Transportation", 1], [null, 1]]);
  });

  it("uses the same inclusive 180-day announcement boundary and keeps renewals eligible", () => {
    const dateAt = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const result = summarizeCustomerCohort([reference("edge", "supported", { announcementDate: dateAt(180), announcementType: "renewal" }),
      reference("older", "not_supported", { announcementDate: dateAt(181) })], now);
    const group = result.industries[0];
    expect(group.recent.customers).toBe(1); expect(group.older.customers).toBe(1);
    expect(group.recent.traits.rr_c01.supported).toBe(1);
    expect(group.older.traits.rr_c01.not_supported).toBe(1);
  });

  it("does not relabel missing answers as a negative or a native insufficient-evidence answer", () => {
    const incomplete = reference("incomplete", "supported"); delete incomplete.answers.rr_c01;
    expect(summarizeCustomerCohort([incomplete], now).industries[0].all.traits.rr_c01).toEqual({ supported: 0, not_supported: 0, insufficient_evidence: 0, conflicting: 0, unanswered: 1 });
  });

  it("uses the matcher's eligible completed references and reports the exact registry denominator", () => {
    const references = [reference("ready", "supported"), reference("pending", "supported", { status: "pending" }),
      reference("future", "supported", { announcementDate: "2027-01-01" }), reference("undated", "supported", { announcementDate: "unavailable" })];
    const result = rankCustomerMatches({ references, candidates: [], asOf: "2026-09-28", referenceTotal: 823, now });
    expect(result.referenceCoverage).toEqual({ verified: 1, pending: 822, total: 823, asOf: "2026-09-28" });
    expect(result.customerCohort?.customers).toBe(1);
    expect(result.customerCohort?.industries[0].all.customers).toBe(1);
  });
});
