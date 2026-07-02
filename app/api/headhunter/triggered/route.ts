import { NextRequest, NextResponse } from "next/server";
import { listTriggered } from "@/lib/db/triggers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The Triggered worklist: base companies with an active (decaying) trigger, ranked. */
export async function POST(req: NextRequest) {
  let body: { limit?: number; offset?: number; includeHidden?: boolean; q?: string; state?: string; subindustry?: string; band?: string; claimable?: boolean; erp?: boolean; tags?: string[]; matchAll?: boolean; types?: string[] };
  try { body = await req.json(); } catch { body = {}; }
  try {
    return NextResponse.json(await listTriggered(body ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
