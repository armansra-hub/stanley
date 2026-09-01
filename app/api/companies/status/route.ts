import { NextRequest, NextResponse } from "next/server";
import { setCompaniesStatus } from "@/lib/db/companies";
import { logEvent } from "@/lib/db/events";

const ALLOWED = new Set(["new", "reviewed", "dismissed"]);

export async function POST(req: NextRequest) {
  let body: { ids?: string[]; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = body?.ids ?? [];
  const status = body?.status ?? "";
  if (!Array.isArray(ids) || ids.length === 0 || !ALLOWED.has(status)) {
    return NextResponse.json({ error: "ids[] and a valid status required" }, { status: 400 });
  }
  await setCompaniesStatus(ids, status as "new" | "reviewed" | "dismissed");
  // The complete ID set is the canonical acknowledgement receipt used to
  // reconstruct per-lead freshness boundaries. Truncating this array caused the
  // tail of large review batches to have no durable decision history.
  await logEvent("headhunter", "lead.status_changed", { summary: `Marked ${ids.length} lead${ids.length === 1 ? "" : "s"} ${status}`, entity_type: "companies", meta: { count: ids.length, status, ids } });
  return NextResponse.json({ ok: true, count: ids.length });
}
