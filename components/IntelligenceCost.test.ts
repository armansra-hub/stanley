import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import IntelligenceCost from "./IntelligenceCost";
import type { JevCostSnapshot, JevCostTotals } from "@/lib/intelligence/costMetricsTypes";

function render(cost: JevCostSnapshot | undefined) {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(IntelligenceCost, { cost })).replace(/<[^>]*>/g, "");
}
afterEach(() => vi.unstubAllGlobals());
describe("Jev spending presentation", () => {
  it.each([undefined, { available: false } as const])("does not show unavailable usage as free", cost => {
    const text = render(cost);
    expect(text).toContain("Cost details are temporarily unavailable");
    expect(text).not.toContain("$0");
  });
  it("separates provider tokens and estimates from uncertain allowances and history", () => {
    const totals: JevCostTotals = { requests: 12, knownUsageRequests: 10, reportedInputTokens: 1_000_000,
      estimatedUsd: .042, unknownUsageRequests: 1, unknownUsageReserveUsd: .002753, inFlightRequests: 1, inFlightReserveUsd: .002753 };
    const period = { totals, byPurpose: [{ ...totals, key: "historical_unattributed" }],
      byActivity: [{ ...totals, key: "website_research" }], byWorkload: [{ ...totals, key: "monitoring" }] };
    const text = render({ available: true, asOf: "2026-09-20T01:00:00Z", monthStart: "2026-09-01T00:00:00Z",
      usdPerMillionInputTokens: .042, attributionStartedAt: null, month: period, last24h: period });
    expect(text).toContain("Known usage estimate$0.042");
    expect(text).toContain("1,000,000");
    expect(text).toContain("actual charge unknown");
    expect(text).toContain("not confirmed charges");
    expect(text).toContain("Website research");
    expect(text).toContain("Ongoing monitoring");
    expect(text).toContain("they are not guessed into research or TAM");
    expect(text).toContain("Claude and other providers are excluded");
  });
  it("opens on current hourly spending rather than cumulative monthly charges", () => {
    const hourTotals: JevCostTotals = { requests: 1, knownUsageRequests: 1, reportedInputTokens: 1_000_000,
      estimatedUsd: .042, unknownUsageRequests: 0, unknownUsageReserveUsd: 0, inFlightRequests: 0, inFlightReserveUsd: 0 };
    const hour = { totals: hourTotals, byPurpose: [], byActivity: [], byWorkload: [] };
    const history = { ...hour, totals: { ...hourTotals, estimatedUsd: 47.31 } };
    const text = render({ available: true, asOf: "2026-09-20T01:00:00Z", monthStart: "2026-09-01T00:00:00Z",
      usdPerMillionInputTokens: .042, attributionStartedAt: null, month: history, last24h: history, last1h: hour });
    expect(text).toContain("Last hour");
    expect(text).toContain("Known usage estimate$0.042");
    expect(text).not.toContain("$47.31");
  });
});
