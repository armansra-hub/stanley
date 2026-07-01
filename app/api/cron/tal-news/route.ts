import { NextRequest, NextResponse } from "next/server";
import { sweepTalNews } from "@/lib/triggers/talSweep";
import { logEvent } from "@/lib/db/events";

/** Daily highest-priority news sweep over the AE's TAL (claimed) accounts; flags
 * tal_alert on new signals (the in-app notification). Secret-guarded. */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await sweepTalNews();
  await logEvent("headhunter", "tal.news_sweep", { summary: `TAL news: ${result.alerted} claimed accounts flagged with new signals (${result.new_triggers} triggers across ${result.checked})`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
