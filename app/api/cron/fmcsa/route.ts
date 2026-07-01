import { NextRequest, NextResponse } from "next/server";
import { sweepFmcsaTam } from "@/lib/triggers/fmcsaSweep";
import { logEvent } from "@/lib/db/events";

/** FMCSA fleet-growth monitor over the TAM's transportation companies (FREE).
 * Secret-guarded. ?n= batch size, ?offset= wave offset. */
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
  const result = await sweepFmcsaTam(n, { offset });
  await logEvent("headhunter", "fmcsa.sweep", { summary: `FMCSA monitor: ${result.fleet_growth} fleet-growth triggers (${result.matched}/${result.checked} matched a carrier record)`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
