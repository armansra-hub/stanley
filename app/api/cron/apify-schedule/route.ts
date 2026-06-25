import { NextRequest, NextResponse } from "next/server";
import { runActorAsync } from "@/lib/apify/run";
import { recordSlice } from "@/lib/ingest/coverage";
import { SCHEDULED, WEEKLY_SCHEDULE } from "@/lib/apify/scheduled";
import { learnFromRatings } from "@/lib/learn/feedback";

// Daily hands-off scheduler. Picks the day's actors (WEEKLY_SCHEDULE), advances
// each one's coverage slice, and TRIGGERS the run async with a webhook back to
// /api/webhooks/apify — so this returns in <2s (no 60s wait). Apify runs the
// actor, then the webhook ingests. ?actors=a,b overrides the day's set (manual).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const base =
    process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!base) return NextResponse.json({ error: "APP_BASE_URL not set" }, { status: 500 });

  const override = url.searchParams.get("actors");
  const day = new Date().getUTCDay();
  const keys = (override ? override.split(",").map((s) => s.trim()) : WEEKLY_SCHEDULE[day] ?? []).filter(
    (k) => SCHEDULED[k],
  );

  const triggered: Record<string, unknown>[] = [];
  for (const key of keys) {
    const actor = SCHEDULED[key];
    const burst = actor.burst ?? 1; // cheap actors (Maps) fire several runs/day
    for (let i = 0; i < burst; i++) {
      try {
        const { input, sliceKey, skip } = await actor.buildInput();
        if (skip) {
          triggered.push({ actor: key, slice: sliceKey, skipped: true });
          break;
        }
        await recordSlice(key, sliceKey, 0); // advance rotation now so the next run picks a new slice
        const webhookUrl = `${base}/api/webhooks/apify?actor=${key}&secret=${process.env.CRON_SECRET}`;
        const runId = await runActorAsync(actor.actorId, input, webhookUrl, actor.maxItems, actor.maxCharge);
        triggered.push({ actor: key, slice: sliceKey, runId });
      } catch (e) {
        triggered.push({ actor: key, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  // Re-tune scoring from the AE's lead ratings (best-effort; also runs on each
  // rating, this is the daily catch-up).
  let learned: Record<string, number> | null = null;
  try {
    learned = (await learnFromRatings()).multipliers;
  } catch {
    /* learning is best-effort */
  }

  return NextResponse.json({ day, triggered, learned });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
