import type { JevCostSnapshot } from "@/lib/intelligence/costMetricsTypes";

// The feed deliberately gives optional metrics a short deadline. Retry only
// the read-only metric when that deadline expires, without delaying the feed.
export async function resolveIntelligenceCost(
  summary: JevCostSnapshot | undefined,
  fetchCost: () => Promise<Response>,
): Promise<JevCostSnapshot> {
  if (summary?.available) return summary;
  try {
    const response = await fetchCost();
    return response.ok ? await response.json() as JevCostSnapshot : { available: false };
  } catch { return { available: false }; }
}

export function displayedIntelligenceCost(
  summary: JevCostSnapshot | undefined,
  fallback: JevCostSnapshot | undefined,
): JevCostSnapshot | undefined {
  return summary?.available ? summary : fallback ?? summary;
}
