import { NextRequest, NextResponse } from "next/server";
import { listTalAlerts, clearTalAlert } from "@/lib/db/triggers";

/** In-app TAL notification feed. GET → claimed accounts with a new unseen signal
 * (ranked) + count. POST { ids? } → clear those (or all) once the AE has seen them. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const companies = await listTalAlerts();
    return NextResponse.json({ count: companies.length, companies });
  } catch (e) {
    return NextResponse.json({ count: 0, companies: [], error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: NextRequest) {
  let body: { ids?: string[] } = {};
  try { body = await req.json(); } catch { /* clear all */ }
  await clearTalAlert(Array.isArray(body.ids) && body.ids.length ? body.ids : undefined);
  return NextResponse.json({ ok: true });
}
