import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { setSignalQuality } from "@/lib/db/settings";

/**
 * The learning loop. Reads every rated lead + the signal types it carries, and
 * computes a per-signal-type QUALITY MULTIPLIER from how the AE rates leads that
 * have that signal. Signal types that correlate with high ratings get a >1
 * multiplier; low-rated ones get <1. These fold into the scoring weights
 * (lib/ingest/orchestrator.ts) so the bot continuously tunes toward what the AE
 * actually values — automatically, every time he rates a lead.
 *
 * Safety: bounded to [0.6, 1.4], and only types with at least MIN_SAMPLES
 * ratings are adjusted (everything else stays neutral at 1.0). Small/noisy
 * samples can't swing the score.
 */
const MIN_SAMPLES = 4;
const FLOOR = 0.6;
const CEIL = 1.4;

export interface LearnResult {
  rated_leads: number;
  multipliers: Record<string, number>;
  samples: Record<string, number>;
}

export async function learnFromRatings(): Promise<LearnResult> {
  const db = serviceClient();
  const { data, error } = await db
    .from("companies")
    .select("rating, signals(type)")
    .not("rating", "is", null)
    .limit(5000);
  if (error || !data) return { rated_leads: 0, multipliers: {}, samples: {} };

  // Collect the ratings of every lead carrying each signal type.
  const byType = new Map<string, number[]>();
  for (const c of data as { rating: number | null; signals?: { type: string }[] }[]) {
    const rating = Number(c.rating);
    if (!Number.isFinite(rating)) continue;
    const types = new Set((c.signals ?? []).map((s) => s.type));
    for (const t of types) {
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(rating);
    }
  }

  const multipliers: Record<string, number> = {};
  const samples: Record<string, number> = {};
  for (const [type, arr] of byType) {
    samples[type] = arr.length;
    if (arr.length < MIN_SAMPLES) continue;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length; // 1..5
    // Linear map: rating 1 → FLOOR, 3 → 1.0, 5 → CEIL.
    const m = FLOOR + ((avg - 1) / 4) * (CEIL - FLOOR);
    multipliers[type] = Math.round(m * 100) / 100;
  }

  await setSignalQuality(multipliers);
  return { rated_leads: data.length, multipliers, samples };
}
