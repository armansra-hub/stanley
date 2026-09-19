import { NextResponse } from "next/server";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { logEvent } from "@/lib/db/events";
import { reviewPendingCandidates } from "@/lib/triggers/candidateReview";
import { runAccountStoryWorker } from "@/lib/intelligence/narratives";

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
    const result = await runIntelligenceWorker(192, startedAt + 190000);
    const stories = result.enabled ? await runAccountStoryWorker(2, startedAt + 275000) : null;
    const review = result.enabled ? await reviewPendingCandidates(8, { deadlineMs: startedAt + 285000 }) : null;
    if (result.processed) await logEvent("headhunter", "intelligence.processed", { summary: `Processed ${result.processed} evidence jobs`, meta: result });
    if (stories?.processed) await logEvent("headhunter", "intelligence.stories", { summary: `Processed ${stories.processed} account stories`, meta: stories });
    return NextResponse.json({ ...result, research: { scheduler: "intelligence-research" }, stories, review });
  } catch {
    return NextResponse.json({ error: "intelligence_worker_unavailable" }, { status: 503 });
  }
}
