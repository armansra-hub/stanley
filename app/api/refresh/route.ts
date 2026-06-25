import { NextResponse } from "next/server";
import { runFreeDiscovery } from "@/lib/ingest/discover";

// In-app "Refresh now": runs the automated free sources (skips low-yield EDGAR).
// Single-user app — no secret here (the cron route keeps the secret for external
// schedulers). Add auth before any shared deploy.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const result = await runFreeDiscovery(["news", "usaspending", "fmcsa", "press"]);
  return NextResponse.json({ ...result, refreshed_at: new Date().toISOString() });
}
