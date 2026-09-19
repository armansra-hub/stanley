import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upsert: vi.fn() }));
vi.mock("./http", () => ({ fetchJson: mocks.fetch }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => ({ upsert: mocks.upsert }) }) }));
import { compactAward, searchContractAwardsPage, IDV_CODES } from "./usaspending";
import { federalAwardLabel, federalCoverage, federalLifecycleFacts } from "./federalPresentation";
import { federalCoverageReceipt, saveFederalCoverageReceipts } from "./federalCoverageStore";
beforeEach(() => { vi.clearAllMocks(); mocks.upsert.mockResolvedValue({ error: null }); });
describe("federal award lifecycle", () => {
  it("requests the IDV collection's fields and preserves the explicit ordering date and sequential anchor", async () => {
    const pair = { lastRecordUniqueId: 10, lastRecordSortValue: "2026" };
    mocks.fetch.mockResolvedValue({ results: [{ generated_internal_id: "CONT_IDV_1", "Recipient Name": "Acme", "Last Date to Order": "2030-01-01" }], page_metadata: { hasNext: false } });
    const page = await searchContractAwardsPage("ABCDEFGHIJKL", 2, "2026-09-19", 100, undefined, pair, "idvs");
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(body.filters.award_type_codes).toEqual(IDV_CODES); expect(body.fields).toContain("Last Date to Order");
    expect(body.fields).not.toContain("End Date"); expect(body.last_record_unique_id).toBe(10);
    expect(page.rows[0].lastDateToOrder).toBe("2030-01-01");
  });
  it("keeps signed, performance and potential option dates distinct and never fabricates option periods", () => {
    const award = compactAward({ type: "B", category: "contract", date_signed: "2026-01-01", parent_award: { generated_unique_award_id: "CONT_IDV_1" },
      period_of_performance: { start_date: "2026-02-01", end_date: "2027-01-31", potential_end_date: "2030-01-31 00:00:00" },
      base_and_all_options: 1000000, base_exercised_options: 250000, total_obligation: 100000 });
    expect(award).toMatchObject({ signedDate: "2026-01-01", startDate: "2026-02-01", endDate: "2027-01-31", potentialEndDate: "2030-01-31",
      orderingEndDate: null, parentAwardId: "CONT_IDV_1", awardCeiling: 1000000, currentAwardAmount: 250000, totalObligations: 100000 });
    const facts = federalLifecycleFacts({ start_date: award.startDate, end_date: award.endDate, potential_end_date: award.potentialEndDate,
      current_award_amount: award.currentAwardAmount, evidence: { signedDate: award.signedDate, optionSchedule: "not_provided_by_source" } });
    expect(facts.join(" ")).toContain("future options are not confirmed exercised");
    expect(facts.join(" ")).toContain("Individual option-period dates are not supplied");
  });
  it("labels abbreviated IDV types using the source code and never calls vehicle capacity revenue", () => {
    expect(federalAwardLabel({ award_type: "BPA", evidence: { awardTypeCode: "IDV_E" } })).toBe("Contract vehicle (IDV)");
    const facts = federalLifecycleFacts({ generated_award_id: "CONT_IDV_1", end_date: "2030-01-01", evidence: { awardCategory: "idv" } });
    expect(facts).toContain("Vehicle ceiling is potential ordering capacity; funded orders are separate awards.");
    expect(facts.some((fact) => fact.startsWith("Last date to order"))).toBe(false);
  });
  it("records source-scoped completion only after both phases and leaves unlinked work unresolved", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111", now = "2026-09-19T00:00:00Z";
    expect(federalCoverageReceipt("usaspending", { companyId, status: "matched", awardDone: false, awardContinuation: { collection: "idvs", searchEndDate: "2026-09-19" } }, now)).toMatchObject({ status: "partial", searched_through: "2026-09-19" });
    expect(federalCoverageReceipt("usaspending-subawards", { companyId, status: "not_linked", subawardDone: true }, now).status).toBe("partial");
    await saveFederalCoverageReceipts("usaspending", [{ companyId, status: "matched", awardDone: true, searchEndDate: "2026-09-19" }]);
    expect(mocks.upsert.mock.calls[0][0][0]).toMatchObject({ company_id: companyId, status: "complete", searched_from: "2007-10-01", detail: { exhaustiveFederalMarket: false } });
    await saveFederalCoverageReceipts("usaspending", [{ companyId, status: "matched", awardDone: false }, { companyId, status: "matched", awardDone: true }]);
    expect(mocks.upsert.mock.calls[1][0]).toHaveLength(1);
    expect(mocks.upsert.mock.calls[1][0][0].status).toBe("partial");
    expect(federalCoverage([{ id: "entity" }], [], [], false, []).historyComplete).toBe(false);
  });
});
