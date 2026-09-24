import { NextRequest, NextResponse } from "next/server";
import { intelligenceUiAuthorized } from "@/lib/intelligence/http";
import { agentAuthOk } from "@/lib/agent/auth";
import { readJevBudgetPolicy } from "@/lib/intelligence/budget";
import { withServiceDeadline } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
/** Read-only. Opening this panel cannot activate, reserve or dispatch work. */
export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req) && !agentAuthOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const snapshot = await withServiceDeadline(Date.now() + 5_000, readJevBudgetPolicy);
    return NextResponse.json(snapshot, { status: snapshot.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ available: false }, { status: 503 }); }
}
