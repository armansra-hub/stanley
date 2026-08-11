import { NextRequest, NextResponse } from "next/server";
import { syncTalClaimed, TalMembershipValidationError } from "@/lib/db/companies";
import { logEvent } from "@/lib/db/events";

/**
 * ARS Target Account List sync. Body: { rows: {name, website, internal_id}[] }.
 * The full upload is resolved by exact NetSuite Internal ID and validated before
 * any flags change. Names and websites are receipt context, never identity.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { rows?: { name?: string; website?: string | null; internal_id?: string | null }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const suppliedRows = Array.isArray(body.rows) ? body.rows : [];
  const rows = suppliedRows.map((r) => ({
    name: String(r?.name ?? ""),
    website: r?.website ?? null,
    internal_id: r?.internal_id == null ? null : String(r.internal_id),
  }));
  if (rows.length === 0) return NextResponse.json({ error: "no TAL rows supplied" }, { status: 400 });
  try {
    const report = await syncTalClaimed(rows);
    let timelineLogged = true;
    await logEvent("headhunter", "tal.synced", { summary: `TAL exact-ID sync verified: ${report.verified_claimed} claimed rows from ${report.tal_count} unique NetSuite IDs`, entity_type: "import", meta: { ...report } })
      .catch(() => { timelineLogged = false; });
    return NextResponse.json({ ...report, timeline_logged: timelineLogged });
  } catch (e) {
    if (e instanceof TalMembershipValidationError) {
      return NextResponse.json({ error: e.message, details: e.details }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
