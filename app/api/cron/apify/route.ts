import { NextRequest, NextResponse } from "next/server";
import { runApifyDiscovery } from "@/lib/ingest/discoverApify";

// PAID Apify discovery. Secret-protected (x-cron-secret header or ?secret=).
// ?actors=google_maps,indeed,... (default "all" wired adapters). Each actor is
// pay-per-result and self-caps its maxItems. NOTE: on Vercel these belong on
// Apify-scheduled runs → /api/webhooks/apify (a sync run can exceed the 60s
// serverless limit); fine locally.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const actors = (url.searchParams.get("actors") ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
  const result = await runApifyDiscovery(actors);
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
