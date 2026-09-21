import { NextResponse } from "next/server";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { logEvent } from "@/lib/db/events";
import { reviewPendingCandidates } from "@/lib/triggers/candidateReview";
import { runAccountStoryWorker } from "@/lib/intelligence/narratives";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    if (!intelligenceEnabled()) return NextResponse.json({ enabled: false, processed: 0, outcomes: {} });
    const { data: config, error: configError } = await serviceClient().from("intelligence_config").select("enabled").eq("id", 1).single();
    if (configError) throw new Error("configuration_unavailable");
    if (!config?.enabled) return NextResponse.json({ enabled: false, processed: 0, outcomes: {} });
    // These independent queues retain their existing limits. They no longer
    // consume the interpretation worker's runtime or hide its completed receipt.
    const [processing, writing, reviewing] = await Promise.allSettled([
      runIntelligenceWorker({ mode: "drain", concurrency: 6 }, startedAt + 280000).then(async result => {
        await logEvent("headhunter", "intelligence.processed", { summary: `Processed ${result.processed} evidence jobs`, meta: result });
        return result;
      }),
      runAccountStoryWorker(2, startedAt + 275000),
      reviewPendingCandidates(8, { deadlineMs: startedAt + 280000 }),
    ]);
    if (processing.status === "rejected") throw new Error("intelligence_processing_unavailable");
    const result = processing.value;
    const stories = writing.status === "fulfilled" ? writing.value : { processed: 0, error: "story_worker_unavailable" };
    const review = reviewing.status === "fulfilled" ? reviewing.value : { error: "legacy_review_unavailable" };
    if (stories?.processed) await logEvent("headhunter", "intelligence.stories", { summary: `Processed ${stories.processed} account stories`, meta: stories });
    return NextResponse.json({ ...result, research: { scheduler: "intelligence-research" }, stories, review });
  } catch {
    return NextResponse.json({ error: "intelligence_worker_unavailable" }, { status: 503 });
  }
}
