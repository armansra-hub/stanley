import { NextRequest, NextResponse } from "next/server";
import { sweepAts } from "@/lib/triggers/atsSweep";
import { logEvent } from "@/lib/db/events";

/** ATS sweep: detect each company's job board + scan finance postings for ERP-pain
 * language (FREE). Secret-guarded. ?n= batch size, ?offset= wave offset. */
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
  const n = Math.min(Number(url.searchParams.get("n") ?? 120) || 120, 200);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const result = await sweepAts(n, { offset });
  await logEvent("headhunter", "ats.sweep", { summary: `ATS sweep: ${result.with_board}/${result.checked} have a board (${result.detected} newly detected) — ${result.erp_triggers} ERP-pain, ${result.finance_triggers} finance hires, ${result.already_on_erp} already on ERP`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
