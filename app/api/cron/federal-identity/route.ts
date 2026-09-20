import { NextRequest, NextResponse } from "next/server";
import { runFederalIdentityResearch } from "@/lib/publicGrowth/federalIdentityResearch";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  if (!supplied || ![process.env.CRON_SECRET, process.env.TAM_GROWTH_SWEEP_SECRET].filter(Boolean).includes(supplied))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await runFederalIdentityResearch();
  return NextResponse.json(result, { status: result.status === "failed" ? 503 : 200 });
}
