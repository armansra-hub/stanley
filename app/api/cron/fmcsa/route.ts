import { parseFiniteCollection } from "@/lib/triggers/finiteCollection";
import { NextRequest, NextResponse } from "next/server";
import { sweepFmcsaTam } from "@/lib/triggers/fmcsaSweep";
import { logEvent } from "@/lib/db/events";

/** FMCSA fleet-growth monitor over the TAM's transportation companies (FREE).
 * Secret-guarded. ?n= batch size, ?offset= wave offset. */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  const authorized = Boolean(secret && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && secret === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && secret === process.env.CRON_SECRET)
  ));
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (url.searchParams.has("sourceOnly") && url.searchParams.get("sourceOnly") !== "1") {
    return NextResponse.json({ error: "sourceOnly must be 1 when supplied" }, { status: 400 });
  }
  let finite: ReturnType<typeof parseFiniteCollection>;
  try { finite = parseFiniteCollection(url.searchParams); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  const n = finite?.limit ?? Math.min(Number(url.searchParams.get("n") ?? 150) || 150, 250);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const result = await sweepFmcsaTam(n, { offset, sourceOnly: url.searchParams.get("sourceOnly") === "1", ...(finite ? { collection: finite.collection } : {}) });
  await logEvent("headhunter", "fmcsa.sweep", { summary: `FMCSA monitor: ${result.fleet_growth} fleet-growth triggers (${result.matched}/${result.checked} matched a carrier record)`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
