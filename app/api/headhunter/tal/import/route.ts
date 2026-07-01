import { NextRequest, NextResponse } from "next/server";
import { syncTalClaimed } from "@/lib/db/companies";
import { logEvent } from "@/lib/db/events";

/**
 * ARS Target Account List sync. Body: { rows: {name, website}[] } — the full TAL
 * (client-parsed). Resets every company's tal_claimed flag, then sets it on leads
 * whose domain/name matches a TAL entry. Re-upload re-syncs the whole flag.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { rows?: { name?: string; website?: string | null }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const rows = (body.rows ?? []).filter((r) => r && r.name).map((r) => ({ name: String(r.name), website: r.website ?? null }));
  if (rows.length === 0) return NextResponse.json({ error: "no rows with a company name" }, { status: 400 });
  try {
    const report = await syncTalClaimed(rows);
    await logEvent("headhunter", "tal.synced", { summary: `TAL synced: ${report.matched} leads flagged ARS TAL CLAIMED (from ${report.tal_count} target accounts)`, entity_type: "import", meta: report });
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
