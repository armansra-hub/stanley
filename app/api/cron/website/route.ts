import { NextRequest, NextResponse } from "next/server";
import { sweepWebsites } from "@/lib/triggers/websiteSweep";
import { logEvent } from "@/lib/db/events";

/** Website-change watch over claimable leads (FREE). Secret-guarded. ?n= / ?offset=. */
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
  const n = Math.min(Number(url.searchParams.get("n") ?? 150) || 150, 250);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const result = await sweepWebsites(n, { offset });
  await logEvent("headhunter", "website.sweep", { summary: `Website watch: ${result.triggered} new growth signals (${result.changed} sites changed / ${result.checked} checked)`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
