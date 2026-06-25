import { NextRequest, NextResponse } from "next/server";
import { ingestCandidates } from "@/lib/ingest/orchestrator";
import type { Candidate } from "@/lib/ingest/types";

// Pipeline smoke-test endpoint: POST { candidates: Candidate[] } to drive
// enrich → score → upsert end-to-end. Protected by CRON_SECRET. The real
// source adapters (EDGAR, RSS, FMCSA, USASpending, Apify) will feed the same
// orchestrator on a schedule.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { candidates?: Candidate[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const candidates = body?.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return NextResponse.json({ error: "no candidates provided" }, { status: 400 });
  }

  const result = await ingestCandidates(candidates);
  return NextResponse.json(result);
}
