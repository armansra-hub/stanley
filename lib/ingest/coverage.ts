import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Systematic TAM coverage. Each source defines a "universe" of slices it can
 * search (e.g. Google Maps = city×category, Leads Finder = state×industry). We
 * return the N least-recently-run slices (never-run first), so every run
 * explores NEW territory instead of re-paying for companies already found.
 * Graceful before migration 0003 (falls back to universe order).
 */
export async function nextSlices(source: string, universe: string[], n: number): Promise<string[]> {
  if (universe.length === 0) return [];
  let lastRun = new Map<string, string | null>();
  try {
    const db = serviceClient();
    const { data } = await db.from("discovery_coverage").select("slice_key, last_run_at").eq("source", source);
    lastRun = new Map((data ?? []).map((r) => [r.slice_key as string, (r.last_run_at as string) ?? null]));
  } catch {
    // table missing → treat everything as never-run
  }
  const ranked = [...universe].sort((a, b) => {
    const ta = lastRun.has(a) ? new Date(lastRun.get(a) || 0).getTime() : -1; // never-run sorts first
    const tb = lastRun.has(b) ? new Date(lastRun.get(b) || 0).getTime() : -1;
    return ta - tb;
  });
  return ranked.slice(0, n);
}

/** Stamp a slice as just-run (advances the round-robin). Safe before migration. */
export async function recordSlice(source: string, sliceKey: string, results: number): Promise<void> {
  try {
    const db = serviceClient();
    const { data } = await db
      .from("discovery_coverage")
      .select("run_count, results_count")
      .eq("source", source)
      .eq("slice_key", sliceKey)
      .maybeSingle();
    await db.from("discovery_coverage").upsert(
      {
        source,
        slice_key: sliceKey,
        last_run_at: new Date().toISOString(),
        run_count: ((data?.run_count as number) ?? 0) + 1,
        results_count: ((data?.results_count as number) ?? 0) + results,
      },
      { onConflict: "source,slice_key" },
    );
  } catch {
    // table missing → no-op
  }
}
