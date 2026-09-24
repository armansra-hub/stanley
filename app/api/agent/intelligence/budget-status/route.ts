import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { readJevBudgetPolicy } from "@/lib/intelligence/budget";
import { withServiceDeadline } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  try {
    const snapshot = await withServiceDeadline(Date.now() + 5_000, readJevBudgetPolicy);
    return NextResponse.json(snapshot, { status: snapshot.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ available: false }, { status: 503 }); }
}
