import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { readJevCostMetrics } from "@/lib/intelligence/costMetrics";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
/** Lets costs remain visible when unrelated evidence or source-health reads fail. */
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cost = await readJevCostMetrics();
  return NextResponse.json(cost, { status: cost.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
