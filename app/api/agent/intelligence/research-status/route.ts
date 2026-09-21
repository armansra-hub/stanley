import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { readResearchProgress } from "@/lib/intelligence/researchProgress";
export const dynamic = "force-dynamic";
/** Read-only status: never dispatches discovery, claims or paid requests. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const result = await readResearchProgress();
  return NextResponse.json(result, { status: result.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
