import { NextResponse } from "next/server";
import { runDirectedResearchWorker } from "@/lib/intelligence/researchRunner";
import { logEvent } from "@/lib/db/events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Its own bounded schedule keeps deeper reading independent of baseline coverage. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDirectedResearchWorker({ mode: "drain", concurrency: 2 }, Date.now() + 280000);
    await logEvent("headhunter", "intelligence.research", {
      summary: `Researched ${result.processed} business-services accounts`, meta: result,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "intelligence_research_unavailable" }, { status: 503 });
  }
}
