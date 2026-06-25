import { NextRequest, NextResponse } from "next/server";
import { runApifyDiscovery } from "@/lib/ingest/discoverApify";

// In-app trigger for PAID Apify discovery (the dashboard "Paid sources" menu).
// Single-user app — no secret here (the /api/cron/apify route keeps the secret
// for external schedulers). Add auth before any shared deploy.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { actors?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const actors = Array.isArray(body?.actors) && body.actors.length ? body.actors : ["all"];
  const result = await runApifyDiscovery(actors);
  return NextResponse.json(result);
}
