import { NextRequest, NextResponse } from "next/server";
import { sweepTalNews } from "@/lib/triggers/talSweep";
import { logEvent } from "@/lib/db/events";

/** Daily highest-priority news sweep over the AE's TAL (claimed) accounts; flags
 * tal_alert on new signals (the in-app notification). Secret-guarded. */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await sweepTalNews();
    await logEvent("headhunter", "tal.news_sweep", {
      summary: `TAL news: ${result.checked}/${result.eligible} attempted, ${result.succeeded} succeeded, ${result.partial} partial, ${result.unavailable + result.failed} failed/unavailable, ${result.remaining} deferred; ${result.alerted} alerts saved`,
      entity_type: "cron", meta: result,
    });
    return NextResponse.json(result);
  } catch {
    await logEvent("headhunter", "tal.news_sweep_failed", {
      summary: "TAL news could not load or checkpoint its bounded sweep", entity_type: "cron",
    }).catch(() => {});
    return NextResponse.json({ error: "tal_news_sweep_unavailable", complete: false }, { status: 503 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
