import { NextRequest, NextResponse } from "next/server";
import { listTal } from "@/lib/db/triggers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The Target Account List tab: every claimed lead (stagnant — never hidden by
 * exports; membership changes only via a fresh TAL upload at /tal/import). */
export async function POST(req: NextRequest) {
  let body: { q?: string; state?: string; subindustry?: string };
  try { body = await req.json(); } catch { body = {}; }
  try {
    return NextResponse.json(await listTal(body ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
