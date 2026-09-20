import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JevCostMetrics, JevCostTotals } from "./costMetricsTypes";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
import { parseJevCostMetrics, readJevCostMetrics } from "./costMetrics";

const totals: JevCostTotals = { requests: 5, knownUsageRequests: 3, reportedInputTokens: 100_000,
  estimatedUsd: .0042, unknownUsageRequests: 1, unknownUsageReserveUsd: .002753, inFlightRequests: 1, inFlightReserveUsd: .002753 };
function fixture(): JevCostMetrics {
  const period = { totals: { ...totals }, byPurpose: [{ ...totals, key: "historical_unattributed" }],
    byActivity: [{ ...totals, key: "historical_unattributed" }], byWorkload: [{ ...totals, key: "historical_unattributed" }] };
  return { asOf: "2026-09-20T01:00:00Z", monthStart: "2026-09-01T00:00:00Z", usdPerMillionInputTokens: .042,
    attributionStartedAt: null, month: structuredClone(period), last24h: structuredClone(period) };
}
beforeEach(() => rpc.mockReset());
describe("Jev cost diagnostics", () => {
  it("preserves known token usage separately from unknown and unsettled reservations", () => {
    const result = parseJevCostMetrics(fixture());
    expect(result).toMatchObject({ available: true, month: { totals } });
    if (result.available) {
      expect(result.month.totals.estimatedUsd).toBe(.0042);
      expect(result.month.byPurpose[0].key).toBe("historical_unattributed");
    }
  });
  it.each([null, {}, { month: { totals: {} } }])("does not invent zero totals for incomplete storage results", value => {
    expect(parseJevCostMetrics(value)).toEqual({ available: false });
  });
  it("rejects impossible counts and nonfinite cost data rather than displaying misleading metrics", () => {
    const counts = fixture(); counts.month.totals.requests = 4;
    expect(parseJevCostMetrics(counts)).toEqual({ available: false });
    const dollars = fixture(); dollars.month.totals.estimatedUsd = Number.NaN;
    expect(parseJevCostMetrics(dollars)).toEqual({ available: false });
  });
  it("marks a missing migration or network error unavailable without throwing into the evidence read", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } }).mockRejectedValueOnce(new Error("private connection detail"));
    expect(await readJevCostMetrics()).toEqual({ available: false });
    expect(await readJevCostMetrics()).toEqual({ available: false });
  });
  it("reads only the service aggregate", async () => {
    rpc.mockResolvedValue({ data: fixture(), error: null });
    expect(await readJevCostMetrics()).toMatchObject({ available: true });
    expect(rpc).toHaveBeenCalledWith("intelligence_jev_cost_metrics");
  });
});
