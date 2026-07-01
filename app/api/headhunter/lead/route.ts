import { NextRequest, NextResponse } from "next/server";
import { getLeadDetail } from "@/lib/db/triggers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Full detail for one lead (all signals + all triggers + flags), for the drawer. */
export async function POST(req: NextRequest) {
  let body: { id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body?.id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  try {
    const detail = await getLeadDetail(body.id);
    if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
