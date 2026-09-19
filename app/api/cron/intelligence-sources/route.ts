import { NextResponse, after } from "next/server";
import { runSharedSources } from "@/lib/intelligence/sharedSources";
import { logEvent } from "@/lib/db/events";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const deadlineMs = Date.now() + 280_000;
  try {
    const result = await runSharedSources();
    if (result.claimed) await logEvent("headhunter", "intelligence.sources", { summary: `Shared feeds: ${result.fetched} fetched, ${result.observations} account observations, ${result.failed} pending failures`, meta: result });
    if (result.observations) after(async () => {
      if (Date.now() >= deadlineMs - 30_000) return;
      const processed = await runIntelligenceWorker(96, deadlineMs).catch(() => null);
      if (processed?.processed) await logEvent("headhunter", "intelligence.processed", {
        summary: `Processed ${processed.processed} evidence jobs after shared feeds`, meta: { ...processed, wakeup: "shared_sources" },
      });
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "intelligence_sources_unavailable" }, { status: 503 });
  }
}
