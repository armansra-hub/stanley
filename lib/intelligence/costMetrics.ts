import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { JevCostMetrics, JevCostSnapshot } from "./costMetricsTypes";

const counters = ["requests", "knownUsageRequests", "reportedInputTokens", "unknownUsageRequests", "inFlightRequests"] as const;
const amounts = ["estimatedUsd", "unknownUsageReserveUsd", "inFlightReserveUsd"] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function validTotals(value: unknown): boolean {
  if (!record(value)) return false;
  return counters.every(key => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && amounts.every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)
    && value.requests === (value.knownUsageRequests as number) + (value.unknownUsageRequests as number) + (value.inFlightRequests as number);
}
function validPeriod(value: unknown): boolean {
  if (!record(value) || !validTotals(value.totals)) return false;
  return ["byPurpose", "byActivity", "byWorkload"].every(key => Array.isArray(value[key])
    && value[key].every((group: unknown) => record(group) && typeof group.key === "string" && group.key.length > 0 && validTotals(group)));
}

/** A missing migration or incomplete response must not masquerade as $0 usage. */
export function parseJevCostMetrics(value: unknown): JevCostSnapshot {
  if (!record(value) || !timestamp(value.asOf) || !timestamp(value.monthStart)
    || (value.attributionStartedAt !== null && !timestamp(value.attributionStartedAt))
    || typeof value.usdPerMillionInputTokens !== "number" || !Number.isFinite(value.usdPerMillionInputTokens) || value.usdPerMillionInputTokens <= 0
    || !validPeriod(value.month) || !validPeriod(value.last24h)
    || (value.last1h !== undefined && !validPeriod(value.last1h))) return { available: false };
  return { ...(value as JevCostMetrics), available: true };
}

export async function readJevCostMetrics(): Promise<JevCostSnapshot> {
  try {
    const { data, error } = await serviceClient().rpc("intelligence_jev_cost_metrics");
    return error ? { available: false } : parseJevCostMetrics(data);
  } catch {
    // Cost diagnostics are additive: evidence stays available during a metrics outage.
    return { available: false };
  }
}
