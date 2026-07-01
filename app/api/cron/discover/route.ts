import { NextRequest, NextResponse } from "next/server";
import { runFreeDiscovery } from "@/lib/ingest/discover";
import { logEvent } from "@/lib/db/events";

// Scheduled discovery (FREE sources). Protected by CRON_SECRET via the
// x-cron-secret header or ?secret= query param. Use ?source=news|usaspending|
// fmcsa|press|edgar|all (default all). Each source is isolated + capped and
// funnels through the same enrich → score → upsert pipeline.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null; // Vercel Cron sends this
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const source = url.searchParams.get("source") ?? "all";
  const result = await runFreeDiscovery([source]);
  const r = result as { new_companies?: number; upserted?: number; fetched?: number };
  await logEvent("headhunter", "cron.discover", { summary: `Free discovery: ${r.new_companies ?? 0} new, ${r.upserted ?? 0} updated (${r.fetched ?? 0} fetched)`, entity_type: "cron", meta: result as unknown as Record<string, unknown> });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
