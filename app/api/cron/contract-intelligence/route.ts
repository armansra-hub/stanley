import { NextResponse } from "next/server";
import { runContractIntelligence } from "@/lib/publicGrowth/contractIntelligence";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function GET(req: Request) {
  const token = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json({ enabled: false });
  try { return NextResponse.json({ enabled: true, ...await runContractIntelligence(5, Date.now() + 165_000) }); }
  catch { return NextResponse.json({ error: "contract_intelligence_unavailable" }, { status: 503 }); }
}
