import { describe, expect, it } from "vitest";
import { calculateContractMetrics, deriveContractEvents, deriveParticipantEvents, deriveRevenueEvents, summarizeContractRevenueByYear } from "./metrics";

describe("participant growth events", () => {
  it("retains every milestone and growth level crossed", () => {
    const events = deriveParticipantEvents({ filingId: "f1", formYear: 2025, boy: 40, eoy: 260 });
    expect(events.filter((e) => e.type === "employee_milestone").map((e) => e.metadata.threshold)).toEqual([50, 100, 250]);
    expect(events.filter((e) => e.type === "employee_growth").map((e) => e.metadata.thresholdPct)).toEqual([25, 50, 100]);
    expect(events[0].summary).toContain("plan year 2025");
    expect(events[0].summary).toContain("by 2025-12-31");
  });
  it("does not manufacture percent growth from zero", () => {
    expect(deriveParticipantEvents({ filingId: "f2", formYear: 2025, boy: 0, eoy: 120 }).filter((e) => e.type === "employee_growth")).toHaveLength(0);
  });
});

describe("revenue milestones", () => {
  it("includes the requested $10M starting level", () => {
    const events = deriveRevenueEvents({ source: "Sales Navigator", observationId: "r1", priorRevenue: 8_000_000, currentRevenue: 42_000_000, signalDate: "2026-08-02" });
    expect(events.map((e) => e.metadata.threshold)).toEqual([10_000_000, 20_000_000, 30_000_000, 40_000_000]);
    expect(events[0].summary).toContain("by 2026-08-02");
  });
});

describe("federal contract metrics", () => {
  it("reports positive obligation revenue by year without displaying deobligations as negative revenue", () => {
    expect(summarizeContractRevenueByYear([
      { actionDate: "2026-01-10", obligation: 100_000 },
      { actionDate: "2026-03-10", obligation: -125_000 },
      { actionDate: "2025-06-10", obligation: 50_000 },
    ])).toEqual([
      { year: 2026, obligated: 100_000, deobligated: 125_000, transactions: 2 },
      { year: 2025, obligated: 50_000, deobligated: 0, transactions: 1 },
    ]);
  });

  it("uses signed obligations, distinguishes awards from modifications, and exposes ceiling separately", () => {
    const asOf = new Date("2026-08-02T00:00:00Z");
    const awards = [{ generatedAwardId: "a1", startDate: "2026-07-20", endDate: "2027-07-20", awardCeiling: 50_000_000, currentAwardAmount: 8_000_000, totalObligations: 7_000_000, awardingAgency: "VA" }];
    const tx = [
      { externalTransactionId: "t1", generatedAwardId: "a1", actionDate: "2026-07-20", obligation: 8_000_000, modificationNumber: null },
      { externalTransactionId: "t2", generatedAwardId: "a1", actionDate: "2026-07-28", obligation: -1_000_000, modificationNumber: "P00001" },
    ];
    const m = calculateContractMetrics(awards, tx, asOf);
    expect(m.obligations30d).toBe(7_000_000);
    expect(m.deobligationDollars90d).toBe(1_000_000);
    expect(m.activeAwardCeiling).toBe(50_000_000);
    expect(m.activeAwardObligations).toBe(7_000_000);
    expect(m.expiringAwards180d).toBe(0);
    expect(deriveContractEvents(m, asOf).find((e) => e.type === "federal_active_ceiling")?.summary).toContain("ceiling");
    expect(deriveContractEvents(m, asOf).find((e) => e.type === "federal_new_award")?.summary).toContain("ending 2026-08-02");
  });
});
