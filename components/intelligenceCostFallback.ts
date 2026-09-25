import type { JevCostSnapshot } from "@/lib/intelligence/costMetricsTypes";

// Cost is loaded independently once, without delaying saved evidence. Accept an
// available embedded summary during a rolling deployment without fetching twice.
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
