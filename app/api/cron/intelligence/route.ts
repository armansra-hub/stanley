import { NextResponse } from "next/server";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { logEvent } from "@/lib/db/events";
import { reviewPendingCandidates } from "@/lib/triggers/candidateReview";

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
    const result = await runIntelligenceWorker(12, startedAt + 180000);
    const review = result.enabled ? await reviewPendingCandidates(8, { deadlineMs: startedAt + 250000 }) : null;
    if (result.processed) await logEvent("headhunter", "intelligence.processed", { summary: `Processed ${result.processed} evidence jobs`, meta: result });
    return NextResponse.json({ ...result, review });
  } catch {
    return NextResponse.json({ error: "intelligence_worker_unavailable" }, { status: 503 });
  }
}
