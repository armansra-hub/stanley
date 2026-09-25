import { describe, expect, it } from "vitest";
import { parseJevBudgetStatus } from "./budgetStatus";
import { providerBudget } from "@/test/jev-budget-status-fixture";
const legacy = { ...providerBudget, enforcement: undefined, phase: "maintenance", initialMaxUsd: 70, dailyCapUsd: .5,
  maintenanceLimitUsd: 30, totalRemainingUsd: 28, dailyRemainingUsd: .01, initialRemainingUsd: 0, maintenanceRemainingUsd: 28,
  nextResetAt: "2026-09-26T07:00:00Z", initialExpiresAt: "2026-09-25T07:00:00Z", maintenanceExpiresAt: "2026-11-24T08:00:00Z" };

describe("Jev processing reporting contract", () => {
  it("accepts provider credit mode without inventing a balance or zero allowance", () => {
    expect(parseJevBudgetStatus(providerBudget)).toEqual(providerBudget);
    expect(parseJevBudgetStatus({ ...providerBudget, enabled: false, blockedReason: "provider_billing_unavailable" }))
      .toMatchObject({ available: true, providerBalanceUsd: null, blockedReason: "provider_billing_unavailable" });
  });
  it("keeps old deployment snapshots capped rather than interpreting a missing mode as unlimited", () => {
    expect(parseJevBudgetStatus(legacy)).toMatchObject({ available: true, enforcement: "budget_caps", dailyCapUsd: .5 });
  });
  it.each([
    { enforcement: "unknown" }, { phase: "maintenance" }, { dailyCapUsd: 0 }, { initialExpiresAt: "2026-10-01T00:00:00Z" },
    { nextResetAt: "2026-09-26T07:00:00Z" }, { providerBalanceUsd: 99 }, { providerBalanceAsOf: "2026-09-25T20:00:00Z" },
    { providerBalanceUsd: Number.NaN, providerBalanceAsOf: "2026-09-25T20:00:00Z" }, { todayUsedUsd: -1 },
  ])("rejects contradictory modes, invented balances and malformed reporting: %j", patch => {
    expect(parseJevBudgetStatus({ ...providerBudget, ...patch })).toEqual({ available: false });
  });
  it("can represent a genuinely observed provider deficit with its observation time", () => {
    expect(parseJevBudgetStatus({ ...providerBudget, providerBalanceUsd: -.19, providerBalanceAsOf: "2026-09-25T20:00:00Z" }))
      .toMatchObject({ available: true, providerBalanceUsd: -.19 });
  });
  it("still rejects malformed legacy allowance data", () => {
    expect(parseJevBudgetStatus({ ...legacy, dailyCapUsd: null })).toEqual({ available: false });
    expect(parseJevBudgetStatus({ ...legacy, phase: "ongoing" })).toEqual({ available: false });
  });
});
