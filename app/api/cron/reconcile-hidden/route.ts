import { NextRequest, NextResponse } from "next/server";
import { reconcileHumanHiddenStatuses } from "@/lib/db/reviewPolicy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(supplied && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
  ));
}

async function run(req: NextRequest, dryRun: boolean) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await reconcileHumanHiddenStatuses({ dryRun }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** Vercel's parent dispatcher uses authenticated GET requests. */
export async function GET(req: NextRequest) {
  return run(req, new URL(req.url).searchParams.get("dryRun") === "true");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { dryRun?: unknown };
  return run(req, body.dryRun === true);
}
