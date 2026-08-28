import { NextRequest, NextResponse } from "next/server";
import { listOldGold } from "@/lib/db/triggers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Old Gold worklist: past-SQL or audited-opportunity leads ranked by revival class and score (dead at the bottom). */
export async function POST(req: NextRequest) {
  let body: { limit?: number; offset?: number; q?: string; state?: string; subindustry?: string; scoreMin?: number; scoreMax?: number; whyClass?: string; includeHidden?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  try {
    return NextResponse.json(await listOldGold(body ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
