import { parseFiniteCollection } from "@/lib/triggers/finiteCollection";
import { NextRequest, NextResponse } from "next/server";
import { sweepWebsites } from "@/lib/triggers/websiteSweep";
import { logEvent } from "@/lib/db/events";

/** Website watch over the base (FREE). Secret-guarded. ?n= / ?offset= / ?scope=claimable|tail. */
export const dynamic = "force-dynamic";
// Admit website batches for 150 seconds, leaving room for their pages and feeds.
export const maxDuration = 300;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!secret || !((process.env.TAM_GROWTH_SWEEP_SECRET && secret === process.env.TAM_GROWTH_SWEEP_SECRET) || (process.env.CRON_SECRET && secret === process.env.CRON_SECRET))) {
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
  const scope = url.searchParams.get("scope") === "tail" ? ("tail" as const) : ("claimable" as const);
  const result = await sweepWebsites(n, { offset, scope, sourceOnly: url.searchParams.get("sourceOnly") === "1", ...(finite ? { collection: finite.collection } : {}) });
  await logEvent("headhunter", "website.sweep", { summary: `Website watch (${scope}): ${result.triggered} new growth signals (${result.changed} sites changed / ${result.checked} checked)`, entity_type: "cron", meta: { ...result, scope } });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
