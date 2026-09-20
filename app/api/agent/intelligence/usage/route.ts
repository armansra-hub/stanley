import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { readJevCostMetrics } from "@/lib/intelligence/costMetrics";
export const dynamic = "force-dynamic";
/** Aggregates only. No evidence, provider calls, job claims or credentials. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const cost = await readJevCostMetrics();
  return NextResponse.json(cost, { status: cost.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
