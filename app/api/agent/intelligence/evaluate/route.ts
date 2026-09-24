import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
export const dynamic = "force-dynamic";
/** No TAM excerpt is read, cached or sent to a provider under this policy. */
export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return NextResponse.json({ error: "tam_grading_excluded_from_jev_policy" },
    { status: 409, headers: { "Cache-Control": "no-store" } });
}
