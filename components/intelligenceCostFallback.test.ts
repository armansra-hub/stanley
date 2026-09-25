import { describe, expect, it, vi } from "vitest";
import type { JevCostSnapshot } from "@/lib/intelligence/costMetricsTypes";
import { displayedIntelligenceCost, resolveIntelligenceCost } from "./intelligenceCostFallback";

const totals = { requests: 2, knownUsageRequests: 2, reportedInputTokens: 22_521, estimatedUsd: .000947,
  unknownUsageRequests: 0, unknownUsageReserveUsd: 0, inFlightRequests: 0, inFlightReserveUsd: 0 };
const period = { totals, byPurpose: [], byActivity: [], byWorkload: [] };
const available: JevCostSnapshot = { available: true, asOf: "2026-09-25T00:06:26Z", monthStart: "2026-09-01T00:00:00Z",
  usdPerMillionInputTokens: .042, attributionStartedAt: null, month: period, last24h: period, last1h: period };

describe("independent intelligence cost fallback", () => {
  it("does not fetch again when the feed already supplied available metrics", async () => {
    const fetchCost = vi.fn();
    expect(await resolveIntelligenceCost(available, fetchCost)).toBe(available);
    expect(fetchCost).not.toHaveBeenCalled();
  });

  it.each([undefined, { available: false } as const])("recovers an omitted or timed-out metric without reloading the feed", async summary => {
    const fetchCost = vi.fn().mockResolvedValue(Response.json(available));
    const recovered = await resolveIntelligenceCost(summary, fetchCost);
    expect(fetchCost).toHaveBeenCalledOnce();
    expect(recovered).toEqual(available);
    expect(displayedIntelligenceCost(summary, recovered)).toEqual(available);
  });

  it.each(["http", "network", "invalid_json", "unavailable"])("preserves a genuine %s failure as unavailable, never as zero usage", async failure => {
    const fetchCost = vi.fn(() => failure === "network" ? Promise.reject(new Error("offline"))
      : Promise.resolve(failure === "http" ? new Response(null, { status: 503 })
        : failure === "invalid_json" ? new Response("not json") : Response.json({ available: false })));
    const recovered = await resolveIntelligenceCost({ available: false }, fetchCost);
    expect(recovered).toEqual({ available: false });
    expect(displayedIntelligenceCost({ available: false }, recovered)).toEqual({ available: false });
    expect(fetchCost).toHaveBeenCalledOnce();
  });

  it("prefers a current available summary over an older fallback", () => {
    expect(displayedIntelligenceCost(available, { available: false })).toBe(available);
  });
});
