import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  headcount: [] as Array<Record<string, unknown>>,
  company: { state: "PA" } as { state: string | null } | null,
  companyError: null as { message: string } | null,
  headcountError: null as { message: string } | null,
  tables: {} as Record<string, Array<Record<string, any>>>,
  tableError: null as string | null,
  metrics: null as Record<string, unknown> | null,
  reads: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from(table: string) {
  let predicate = (_row: Record<string, any>) => true, start = 0, end = Infinity;
  const result = () => ({ data: table === "companies" ? mocks.company : table === "form5500_headcount_observations" ? mocks.headcount : table === "company_contract_metric_snapshots" ? mocks.metrics
      : (mocks.tables[table] ?? []).filter(predicate).slice(start, end),
    error: table === "companies" ? mocks.companyError : table === "form5500_headcount_observations" ? mocks.headcountError : table === mocks.tableError ? { message: "unavailable" } : null });
  const query = {
    select: () => query, neq: () => query, order: () => query,
    limit: (value: number) => { end = value; return query; }, range: (a: number, b: number) => { start = a; end = b + 1; return query; },
    in: (key: string, values: unknown[]) => { mocks.reads(table, key, values); predicate = (row) => values.includes(row[key]); return query; },
    eq: (key: string, value: string) => { mocks.reads(table, key, value); if (table === "federal_awards") predicate = (row) => row[key] === value; return query; },
    maybeSingle: async () => result(),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return query;
} }) }));
import { getPublicGrowthDetail } from "./detail";
describe("Form5500 public detail history guard", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.company = { state: "PA" }; mocks.companyError = null; mocks.headcountError = null; mocks.headcount = []; mocks.tables = {}; mocks.metrics = null; mocks.tableError = null; });
  it("keeps pending identity awards and stale metrics out of direct account facts", async () => {
    mocks.tables.company_government_matches = [{ match_status: "pending", government_entities: { id: "pending", legal_name: "Same Name", uei: "ABCDEFGHIJKL" } }];
    mocks.tables.federal_awards = [{ id: "wrong-award", government_entity_id: "pending", total_obligations: 1000000 }];
    mocks.metrics = { obligations_365d: 1000000 };
    const result = await getPublicGrowthDetail("exact-company");
    expect(result.entities).toEqual([]); expect(result.awards).toEqual([]); expect(result.contractMetrics).toBeNull();
    expect(result.pendingEntities).toHaveLength(1); expect(result.federalCoverage.status).toBe("identity_review");
    expect(mocks.reads.mock.calls.some(([table]) => table === "federal_awards")).toBe(false);
  });
  it("shows source-backed parent awards separately and preserves direct totals", async () => {
    const direct = { id: "direct", legal_name: "Direct Co", uei: "ABCDEFGHIJKL", parent_uei: "ZYXWVUTSRQPO",
      source: "USAspending", source_url: "https://www.usaspending.gov/award/A1/latest", observed_at: "2026-09-18T00:00:00Z" };
    mocks.tables.company_government_matches = [{ match_status: "verified", government_entities: direct }];
    mocks.tables.government_entities = [{ id: "parent", legal_name: "Parent Co", uei: "ZYXWVUTSRQPO" },
      { id: "name-only", legal_name: "Parent Co", uei: "ZZZZZZZZZZZZ" }];
    mocks.tables.federal_awards = [{ id: "direct-award", government_entity_id: "direct", total_obligations: 10, observed_at: "2026-09-18T00:00:00Z" },
      { id: "parent-award", government_entity_id: "parent", total_obligations: 1000, award_type: "IDV_B" }];
    mocks.tables.federal_award_transactions = [{ federal_award_id: "direct-award", action_date: "2026-09-01", federal_action_obligation: 10 },
      { federal_award_id: "parent-award", action_date: "2026-09-01", federal_action_obligation: 1000 }];
    mocks.metrics = { obligations_365d: 10 };
    const result = await getPublicGrowthDetail("exact-company");
    expect(result.awards.map((row) => row.id)).toEqual(["direct-award"]);
    expect(result.relatedEntities).toHaveLength(1);
    expect(result.relatedEntities[0].awards.map((row) => row.id)).toEqual(["parent-award"]);
    expect(result.relatedEntities[0].relationships[0]).toMatchObject({ relationship: "reported_parent", directEntityId: "direct", reportingUei: direct.uei });
    expect(result.contractRevenueByYear[0].obligated).toBe(10);
    expect(result.contractActions).toHaveLength(1);
    expect(result.contractActions[0]).toMatchObject({ federal_award_id: "direct-award", federal_action_obligation: 10 });
    expect(result.contractMetrics?.obligations_365d).toBe(10);
    expect(result.federalCoverage).toMatchObject({ status: "direct_awards", directAwardCount: 1, historyComplete: false });
  });
  it("distinguishes registration-only from unknown contractor status and fails on unreadable identity evidence", async () => {
    expect((await getPublicGrowthDetail("exact-company")).federalCoverage.status).toBe("no_verified_match");
    mocks.tables.company_government_matches = [{ match_status: "verified", government_entities: { id: "direct", legal_name: "Acme", registration_status: "Expired" } }];
    expect((await getPublicGrowthDetail("exact-company")).federalCoverage.status).toBe("registration_only");
    mocks.tableError = "company_government_matches";
    await expect(getPublicGrowthDetail("exact-company")).rejects.toThrow("federal identity detail load failed");
  });
  it("excludes held and contradictory records from displayed/latest headcount while keeping city-only overclaims", async () => {
    mocks.headcount = [
      { id: "held", sponsor_state: "PA", evidence: { stanley_quarantine: { active: true } } },
      { id: "bad-marker", sponsor_state: "PA", evidence: { stanley_quarantine: {} } },
      { id: "wrong-state", sponsor_state: "CA", evidence: {} },
      { id: "no-city", sponsor_state: "PA", sponsor_city: "Somerset", match_method: "exact_name_state_city", evidence: {} },
      { id: "restored", sponsor_state: "PA", evidence: { stanley_quarantine: { active: false } } },
    ];
    const detail = await getPublicGrowthDetail("exact-company");
    expect(detail.headcount.map((row) => row.id)).toEqual(["no-city", "restored"]);
    expect(mocks.headcount).toHaveLength(5);
    expect(mocks.reads).toHaveBeenCalledWith("companies", "id", "exact-company");
    expect(mocks.reads).toHaveBeenCalledWith("form5500_headcount_observations", "company_id", "exact-company");
  });
  it("does not expose unbound headcount if company no longer exists", async () => {
    mocks.company = null; mocks.headcount = [{ id: "orphan", sponsor_state: "PA" }];
    expect((await getPublicGrowthDetail("missing")).headcount).toEqual([]);
  });
  it("fails closed when current company state cannot be read", async () => {
    mocks.companyError = { message: "fixture unavailable" };
    await expect(getPublicGrowthDetail("exact-company")).rejects.toThrow("detail company read failed");
  });
  it("does not turn a history read error into an empty successful result", async () => {
    mocks.headcountError = { message: "fixture unavailable" };
    await expect(getPublicGrowthDetail("exact-company")).rejects.toThrow("detail history read failed");
  });
});
