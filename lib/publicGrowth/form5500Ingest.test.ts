import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string; state: string | null; city: string | null }>,
  companySelect: vi.fn(),
  history: [] as Array<{ active_participants_eoy: number; form_year: number; sponsor_state?: string | null; evidence?: unknown }>,
  historyError: null as { message: string } | null,
  historyIn: vi.fn(), historyEq: vi.fn(), historyOrder: vi.fn(), historyLimit: vi.fn(),
  existing: null as null | { id: string; sponsor_state: string | null; evidence: unknown },
  existingError: null as { message: string } | null,
  writeData: { id: "stored-row" } as { id: string } | null,
  writeError: null as { message: string } | null,
  existingEq: vi.fn(), updateEq: vi.fn(),
  observationInsert: vi.fn(), observationUpdate: vi.fn(), record: vi.fn(), recompute: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ from: (table: string) => {
    if (table === "companies") {
      const query = {
        select: (columns: string) => { mocks.companySelect(columns); return query; }, in: () => query, contains: () => query,
        neq: async () => ({ data: mocks.companies, error: null }),
      };
      return query;
    }
    if (table === "form5500_headcount_observations") {
      const historyQuery = {
        eq: (...args: unknown[]) => { mocks.historyEq(...args); return historyQuery; },
        in: (...args: unknown[]) => { mocks.historyIn(...args); return historyQuery; },
        order: (...args: unknown[]) => { mocks.historyOrder(...args); return historyQuery; },
        limit: async (...args: unknown[]) => {
          mocks.historyLimit(...args);
          return { data: mocks.history, error: mocks.historyError };
        },
      };
      const existingQuery = {
        eq: (...args: unknown[]) => { mocks.existingEq(...args); return existingQuery; },
        maybeSingle: async () => ({ data: mocks.existing, error: mocks.existingError }),
      };
      const updateQuery = {
        eq: (...args: unknown[]) => { mocks.updateEq(...args); return updateQuery; },
        select: () => updateQuery,
        maybeSingle: async () => ({ data: mocks.writeData, error: mocks.writeError }),
      };
      return {
        select: (columns: string) => columns === "id,evidence,sponsor_state" ? existingQuery : historyQuery,
        insert: (payload: unknown) => { mocks.observationInsert(payload); return { select: () => ({ single: async () => ({ data: mocks.writeData, error: mocks.writeError }) }) }; },
        update: (payload: unknown) => { mocks.observationUpdate(payload); return updateQuery; },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  } }),
}));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.recompute }));
vi.mock("./storage", () => ({ recordPublicGrowthTrigger: mocks.record, stableHash: () => "fixture-hash" }));

import { crossYearEvents, ingestForm5500Observations, type Form5500ObservationInput } from "./form5500Ingest";

const observation: Form5500ObservationInput = {
  companyId: "bd2432fc-8a61-4f86-ac06-e1a2fb61642d", filingId: "filing-2025", formType: "5500",
  sponsorEin: "123456789", sponsorName: "Fixture", planNumber: "001", formYear: 2025,
  sponsorState: "PA", sponsorCity: "Somerset",
  planYearEnd: "2025-12-31", activeParticipantsBoy: 40, activeParticipantsEoy: 100,
  matchMethod: "exact_name_state_city", matchConfidence: 0.98, sourceUrl: "https://www.dol.gov/fixture",
};
const prior = (year: number, count: number) => ({ form_year: year, active_participants_eoy: count });

describe("Form 5500 adjacent-year evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.history = []; mocks.historyError = null;
    mocks.existing = null; mocks.existingError = null; mocks.writeData = { id: "stored-row" }; mocks.writeError = null;
    mocks.companies = [{ id: observation.companyId, name: "Fixture Inc", state: "PA", city: "Somerset" }];
    mocks.record.mockResolvedValue(true); mocks.recompute.mockResolvedValue(1);
  });

  it("does not describe a 2022-to-2025 gap as one year", () => {
    expect(crossYearEvents(observation, [prior(2022, 20), prior(2021, 10)])).toEqual([]);
  });

  it("does not pick between duplicate filings for the immediately prior year", () => {
    for (const history of [
      [prior(2024, 30), prior(2024, 40)],
      [prior(2024, 30), prior(2024, 30), prior(2023, 10)],
    ]) expect(crossYearEvents(observation, history)).toEqual([]);
  });

  it("uses the exact adjacent years independently of row order", () => {
    const events = crossYearEvents(observation, [prior(2023, 20), prior(2024, 40)]);
    expect(events.filter((event) => event.type === "employee_milestone").map((event) => event.metadata.threshold)).toEqual([50, 100]);
    expect(events.filter((event) => event.type === "employee_growth").map((event) => event.metadata.thresholdPct)).toEqual([25, 50, 100]);
    expect(events.filter((event) => event.type === "employee_consecutive_growth")).toHaveLength(1);
    expect(events.every((event) => event.signalDate === "2025-12-31")).toBe(true);
  });

  it("retains one-year evidence but rejects a gap in the second prior year", () => {
    const events = crossYearEvents(observation, [prior(2024, 40), prior(2022, 20)]);
    expect(events.some((event) => event.type === "employee_growth")).toBe(true);
    expect(events.some((event) => event.type === "employee_consecutive_growth")).toBe(false);
  });

  it("retains one-year evidence but rejects duplicate second-prior-year filings", () => {
    const events = crossYearEvents(observation, [prior(2024, 40), prior(2023, 20), prior(2023, 20)]);
    expect(events.some((event) => event.type === "employee_growth")).toBe(true);
    expect(events.some((event) => event.type === "employee_consecutive_growth")).toBe(false);
  });

  it("keeps within-plan-year derivation and source observations unchanged when cross-year history is unusable", async () => {
    mocks.history = [prior(2022, 20)];
    await ingestForm5500Observations([observation]);
    const events = mocks.record.mock.calls.map((call) => call[1]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.metadata.timeframe === "within_plan_year")).toBe(true);
    expect(events.some((event) => event.type === "employee_growth" && event.metadata.thresholdPct === 25)).toBe(true);
    expect(mocks.observationInsert).toHaveBeenCalledWith(expect.objectContaining({
      filing_id: "filing-2025", form_year: 2025, active_participants_boy: 40, active_participants_eoy: 100,
      source_url: observation.sourceUrl, match_method: observation.matchMethod,
    }));
  });

  it("reads a bounded complete two-year scope before exclusion and duplicate-year checks", async () => {
    mocks.history = [prior(2024, 40), prior(2023, 20)];
    await ingestForm5500Observations([observation]);
    expect(mocks.historyIn.mock.calls).toEqual([["form_year", [2024, 2023]]]);
    expect(mocks.historyEq.mock.calls).toEqual([["company_id", observation.companyId], ["plan_number", "001"], ["sponsor_ein", "123456789"]]);
    expect(mocks.historyOrder.mock.calls).toEqual([["form_year", { ascending: false }], ["id", { ascending: true }]]);
    expect(mocks.historyLimit.mock.calls).toEqual([[101]]);
  });

  it("fails before observation/trigger writes when adjacent-year evidence cannot be read", async () => {
    mocks.historyError = { message: "fixture unavailable" };
    await expect(ingestForm5500Observations([observation])).rejects.toThrow("adjacent-year history read failed");
    expect(mocks.observationInsert).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Fixture Inc", state: "CA", city: "Somerset" },
    { name: "Fixture Inc", state: "PA", city: null },
    { name: "Unrelated Business", state: "PA", city: "Somerset" },
  ])("rejects unsupported identity before all history and mutation work: %j", async (fields) => {
    mocks.companies = [{ id: observation.companyId, ...fields }];
    expect(await ingestForm5500Observations([observation])).toEqual({ received: 1, stored: 0, rejected: 1, triggers: 0, companies: 0 });
    expect(mocks.companySelect).toHaveBeenCalledWith("id,name,state,city");
    expect(mocks.historyEq).not.toHaveBeenCalled();
    expect(mocks.observationInsert).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("checks JSON shapes and confidence rather than trusting a TypeScript cast", async () => {
    const malformed = [null, { ...observation, sponsorState: ["PA"] }, { ...observation, matchConfidence: "0.98" },
      { ...observation, matchMethod: "manually_verified" }, { ...observation, companyId: [observation.companyId] }];
    expect(await ingestForm5500Observations(malformed as unknown as Form5500ObservationInput[]))
      .toEqual({ received: 5, stored: 0, rejected: 5, triggers: 0, companies: 0 });
    expect(mocks.companySelect).not.toHaveBeenCalled();
    expect(mocks.observationInsert).not.toHaveBeenCalled();
  });

  it("preserves valid name-only fallback and reports a mixed batch's rejected rows", async () => {
    mocks.companies[0].city = null;
    const valid = { ...observation, matchMethod: "unique_exact_name", matchConfidence: 0.91 };
    const result = await ingestForm5500Observations([valid, observation]);
    expect(result).toMatchObject({ received: 2, stored: 1, rejected: 1, companies: 1 });
    expect(mocks.observationInsert).toHaveBeenCalledTimes(1);
    expect(mocks.observationInsert).toHaveBeenCalledWith(expect.objectContaining({ match_method: "unique_exact_name", match_confidence: 0.91 }));
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { evidence: { stanley_quarantine: { active: true } }, sponsor_state: "PA" },
    { evidence: { stanley_quarantine: { reason: "missing flag" } }, sponsor_state: "PA" },
    { evidence: {}, sponsor_state: "CA" },
  ])("does not derive cross-year events from excluded history %j", async (fields) => {
    mocks.history = [{ ...prior(2024, 10), ...fields }];
    await ingestForm5500Observations([observation]);
    expect(mocks.record.mock.calls.every((call) => call[1].metadata.timeframe === "within_plan_year")).toBe(true);
  });

  it("does not hide valid duplicate-year ambiguity behind an excluded prefix", async () => {
    mocks.history = [
      ...Array.from({ length: 3 }, () => ({ ...prior(2024, 1), evidence: { stanley_quarantine: { active: true } } })),
      prior(2024, 20), prior(2024, 30), prior(2023, 10),
    ];
    await ingestForm5500Observations([observation]);
    expect(mocks.record.mock.calls.every((call) => call[1].metadata.timeframe === "within_plan_year")).toBe(true);
  });

  it("accepts complete100-row scope after excluding held rows", async () => {
    mocks.history = [
      ...Array.from({ length: 98 }, () => ({ ...prior(2024, 1), evidence: { stanley_quarantine: { active: true } } })),
      prior(2024, 40), prior(2023, 20),
    ];
    await ingestForm5500Observations([observation]);
    expect(mocks.record.mock.calls.some((call) => call[1].type === "employee_consecutive_growth")).toBe(true);
  });

  it("fails closed before writes when101rows indicate truncated history", async () => {
    mocks.history = Array.from({ length: 101 }, () => prior(2024, 20));
    await expect(ingestForm5500Observations([observation])).rejects.toThrow("bounded complete-read limit");
    expect(mocks.observationInsert).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([{ active: true }, { reason: "missing active" }, "malformed"])("supported input cannot bypass held current filing %j", async (marker) => {
    mocks.existing = { id: "existing", sponsor_state: "PA", evidence: { stanley_quarantine: marker } };
    expect(await ingestForm5500Observations([observation])).toEqual({ received: 1, stored: 0, rejected: 1, triggers: 0, companies: 0 });
    expect(mocks.historyEq).not.toHaveBeenCalled(); expect(mocks.observationInsert).not.toHaveBeenCalled();
    expect(mocks.observationUpdate).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("retains a reviewed inactive marker during an evidence compare-and-set update", async () => {
    const marker = { active: false, reason: "reviewed restoration", audit: "original" };
    mocks.existing = { id: "existing", sponsor_state: "PA", evidence: { prior: true, stanley_quarantine: marker } };
    await ingestForm5500Observations([{ ...observation, evidence: { current: true } }]);
    expect(mocks.observationInsert).not.toHaveBeenCalled();
    expect(mocks.observationUpdate).toHaveBeenCalledWith(expect.objectContaining({ evidence: { current: true, stanley_quarantine: marker } }));
    expect(mocks.updateEq.mock.calls).toEqual([["id", "existing"], ["evidence", JSON.stringify(mocks.existing.evidence)]]);
  });

  it("publishes no events when concurrent quarantine invalidates evidence compare-and-set", async () => {
    mocks.existing = { id: "existing", sponsor_state: "PA", evidence: {} }; mocks.writeData = null;
    await expect(ingestForm5500Observations([observation])).rejects.toThrow("changed concurrently");
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("does not retry a concurrent insert conflict with destructive upsert", async () => {
    mocks.writeError = { message: "duplicate key" };
    await expect(ingestForm5500Observations([observation])).rejects.toThrow("observation write failed");
    expect(mocks.observationInsert).toHaveBeenCalledTimes(1); expect(mocks.observationUpdate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it("fails before history or writes when existing quarantine state cannot be read", async () => {
    mocks.existingError = { message: "read unavailable" };
    await expect(ingestForm5500Observations([observation])).rejects.toThrow("existing observation read failed");
    expect(mocks.historyEq).not.toHaveBeenCalled(); expect(mocks.observationInsert).not.toHaveBeenCalled();
  });
});
