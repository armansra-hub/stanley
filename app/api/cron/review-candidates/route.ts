import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";
import { reviewPendingCandidates } from "@/lib/triggers/candidateReview";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(supplied && (
    (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
    || (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
  ));
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const n = Math.min(Math.max(Number(new URL(req.url).searchParams.get("n") ?? 25) || 25, 1), 50);
  const result = await reviewPendingCandidates(n);
  await logEvent("headhunter", "trigger.candidates_auto_reviewed", {
    summary: `Automatic news review: ${result.promoted} published, ${result.rejected} rejected, ${result.deferred} deferred`,
    entity_type: "cron",
    meta: result,
  });
  return NextResponse.json(result);
}
