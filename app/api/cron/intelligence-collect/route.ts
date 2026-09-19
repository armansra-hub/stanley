import { NextResponse, after } from "next/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { sweepBase } from "@/lib/triggers/sweep";
import { sweepWebsites } from "@/lib/triggers/websiteSweep";
import { sweepAts } from "@/lib/triggers/atsSweep";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Small frequent rotations complement the existing broad hourly rotation.
 * All calls share its atomic source reservations; no second account cursor. */
export async function GET(req: Request) {
  const header = req.headers.get("authorization");
  const token = req.headers.get("x-cron-secret") ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ enabled: false });
  const deadlineMs = Date.now() + 280_000;
  try {
    const { data, error } = await serviceClient().from("intelligence_config").select("enabled").eq("id", 1).single();
    if (error) throw new Error("configuration_unavailable");
    if (!data?.enabled) return NextResponse.json({ enabled: false });
    const slot = Math.floor(Date.now() / 300000) % 3;
    const results = await Promise.allSettled([
      sweepBase(30),
      // Baseline coverage of current TAM gets capacity on every invocation.
      // Deep pages have their own durable research queue and rotation.
      sweepWebsites(96, { scope: "claimable" }),
      ...(slot === 1 ? [sweepAts(72)] : []),
    ]);
    const outcomes = results.map(result => result.status === "fulfilled" ? result.value : { error: "source_unavailable" });
    await logEvent("headhunter", "intelligence.collection", { summary: "Frequent public-source rotation completed", meta: { slot, outcomes } });
    // Start saved observations promptly using the remaining function budget.
    // The regular cron remains the durable recovery consumer if this wakeup fails.
    after(async () => {
      if (Date.now() >= deadlineMs - 30_000) return;
      const processed = await runIntelligenceWorker(96, deadlineMs).catch(() => null);
      if (processed?.processed) await logEvent("headhunter", "intelligence.processed", {
        summary: `Processed ${processed.processed} evidence jobs after collection`, meta: { ...processed, wakeup: "collection" },
      });
    });
    return NextResponse.json({ enabled: true, slot, outcomes });
  } catch { return NextResponse.json({ error: "collection_unavailable" }, { status: 503 }); }
}
