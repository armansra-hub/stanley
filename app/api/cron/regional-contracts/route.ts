import { NextResponse } from "next/server";
import { runRegionalContracts } from "@/lib/regionalContracts/collector";
import { logEvent } from "@/lib/db/events";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function GET(req: Request) {
  const header = req.headers.get("authorization"), token = req.headers.get("x-cron-secret") ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await runRegionalContracts();
    await logEvent("headhunter", "intelligence.regional_contracts", { summary: "Regional public-contract collection completed", meta: result });
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: "regional_collection_unavailable" }, { status: 503 }); }
}
