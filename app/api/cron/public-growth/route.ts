import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";
import { sweepUsaspendingSubawardsTamBatch, sweepUsaspendingTamBatch } from "@/lib/publicGrowth/usaspendingSweep";
import { sweepSamTamBatch } from "@/lib/publicGrowth/samSweep";
import { sweepRevenueTamBatch } from "@/lib/publicGrowth/revenueSweep";
import { sweepSamOpportunities } from "@/lib/publicGrowth/opportunitySweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest) {
  const url = new URL(req.url), auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(process.env.CRON_SECRET && supplied === process.env.CRON_SECRET);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url), source = url.searchParams.get("source") ?? "usaspending";
  const n = Math.min(Math.max(Number(url.searchParams.get("n") ?? 2) || 2, 1), 10);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  if (!new Set(["usaspending", "usaspending-subawards", "sam-entity", "sam-opportunities", "revenue"]).has(source)) return NextResponse.json({ error: `unsupported source ${source}` }, { status: 400 });
  const result = source === "sam-entity" ? await sweepSamTamBatch(n, offset)
    : source === "sam-opportunities" ? await sweepSamOpportunities(Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 31) || 31)), offset, Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500)))
    : source === "revenue" ? await sweepRevenueTamBatch(Math.min(500, Math.max(n, Number(url.searchParams.get("limit") ?? 250) || 250)), offset)
    : source === "usaspending-subawards" ? await sweepUsaspendingSubawardsTamBatch(n, offset)
    : await sweepUsaspendingTamBatch(n, offset);
  const matched = "matched" in result ? result.matched : "matches" in result ? result.matches : "observed" in result ? result.observed : 0;
  await logEvent("headhunter", `public_growth.${source}`, { summary: `Public growth ${source}: ${matched}/${result.checked} matched or observed, ${result.triggers} trigger events`, entity_type: "cron", meta: { ...result, receipts: undefined } });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
