import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parsePublicGrowthSubawardContinuation, queuePublicGrowthMainFailures, applyPublicGrowthRetryOutcomes } from "./sweepState";
import { splitSubawardWindow } from "./subawardPartitions";

const companyId = "11111111-1111-4111-8111-111111111111";
const cursor = () => ({ version: 1 as const, companyId, entityId: "22222222-2222-4222-8222-222222222222",
  names: ["Acme"], nameIndex: 0, searchEndDate: "2007-10-04", searchPage: 1, searchPassFoundNew: false, seenSubawardIds: ["stored"],
  searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-02" }, { startDate: "2007-10-03", endDate: "2007-10-04" }], searchWindowIndex: 1 });

describe("subaward date-partition cursor integrity", () => {
  it("splits only the current window and retains its frozen scope and IDs", () => {
    const state = cursor();
    splitSubawardWindow(state, "provider_result_window");
    expect(state.searchWindows).toEqual([{ startDate: "2007-10-01", endDate: "2007-10-02" },
      { startDate: "2007-10-03", endDate: "2007-10-03" }, { startDate: "2007-10-04", endDate: "2007-10-04" }]);
    expect(parsePublicGrowthSubawardContinuation(state)).toEqual(state);
    expect(state.seenSubawardIds).toEqual(["stored"]);
  });
  it.each([
    { searchWindowIndex: 2 }, { searchWindowIndex: undefined }, { searchWindows: undefined },
    { searchEndDate: "2007-10-05" }, { searchEndDate: "2026-02-30" },
    { searchWindows: [{ startDate: "2007-10-02", endDate: "2007-10-04" }], searchWindowIndex: 0 },
    { searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-02" }, { startDate: "2007-10-02", endDate: "2007-10-04" }] },
    { searchWindows: [{ startDate: "2007-10-01", endDate: "2007-10-02" }, { startDate: "2007-10-04", endDate: "2007-10-04" }] },
  ])("rejects malformed or scope-changing state %j", (patch) => {
    expect(() => parsePublicGrowthSubawardContinuation({ ...cursor(), ...patch })).toThrow();
  });
  it("preserves partition state through retries and dead-lettering", () => {
    const checkpoint = cursor();
    let state = queuePublicGrowthMainFailures({}, [{ companyId, status: "linked", subawardDone: false, subawardContinuation: checkpoint }], 0).cursorPatch;
    for (let i = 0; i < 3; i++) {
      state = applyPublicGrowthRetryOutcomes(state, state.retryQueue, [{ companyId, status: "error", error: "same-day limit",
        subawardDone: false, subawardContinuation: checkpoint }]).cursorPatch;
    }
    expect(state.retryQueue).toHaveLength(0);
    expect(state.deadLetters[0].subawardContinuation).toEqual(checkpoint);
  });
});
