import { NextRequest, NextResponse } from "next/server";
import { sweepSignals } from "@/lib/triggers/signalsSweep";
import { logEvent } from "@/lib/db/events";

/**
 * Retired compatibility endpoint. Both legacy name-only USAspending and Form D
 * discovery are disabled; verified government signals use `/api/cron/public-growth`.
 * Header-secret guarded. No company, trigger, or rotation state is mutated.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? bearer;
  if (!secret || !((process.env.TAM_GROWTH_SWEEP_SECRET && secret === process.env.TAM_GROWTH_SWEEP_SECRET) || (process.env.CRON_SECRET && secret === process.env.CRON_SECRET))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const n = Math.min(Number(url.searchParams.get("n") ?? 150) || 150, 250);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const result = await sweepSignals(n, { offset });
  await logEvent("headhunter", "signals.sweep", { summary: "Legacy name-only structured-signal sweep retired; use verified public-growth", entity_type: "cron", meta: { ...result, retired: true } });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
