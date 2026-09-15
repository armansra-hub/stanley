import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  headcount: [] as Array<Record<string, unknown>>,
  company: { state: "PA" } as { state: string | null } | null,
  companyError: null as { message: string } | null,
  headcountError: null as { message: string } | null,
  reads: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from(table: string) {
  const result = () => ({ data: table === "companies" ? mocks.company : table === "form5500_headcount_observations" ? mocks.headcount : table === "company_contract_metric_snapshots" ? null : [],
    error: table === "companies" ? mocks.companyError : table === "form5500_headcount_observations" ? mocks.headcountError : null });
  const query = {
    select: () => query, neq: () => query, order: () => query, limit: () => query,
    eq: (key: string, value: string) => { mocks.reads(table, key, value); return query; },
    maybeSingle: async () => result(),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return query;
} }) }));
import { getPublicGrowthDetail } from "./detail";
describe("Form5500 public detail history guard", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.company = { state: "PA" }; mocks.companyError = null; mocks.headcountError = null; mocks.headcount = []; });
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
