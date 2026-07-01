import { NextRequest, NextResponse } from "next/server";
import { sweepBase } from "@/lib/triggers/sweep";
import { logEvent } from "@/lib/db/events";

/** Trigger-engine sweep: monitor the next batch of the base for news (free) +
 * finance-hiring/ERP-readiness (paid) and attach decaying triggers (boost-only).
 * Secret-guarded. ?n= overrides the batch size. */
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
  const n = Math.min(Number(url.searchParams.get("n") ?? 50) || 50, 600);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const result = await sweepBase(n, { finance: url.searchParams.get("finance") === "1", offset });
  await logEvent("headhunter", "trigger.sweep", { summary: `Trigger sweep: ${result.companies_triggered}/${result.checked} fired — ${result.finance_triggers} finance, ${result.erp_triggers} ERP-ready, ${result.news_triggers} news`, entity_type: "cron", meta: result });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
