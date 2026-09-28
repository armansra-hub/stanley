import { NextRequest, NextResponse } from "next/server";
import { isUuid, smallJson } from "@/lib/intelligence/http";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";

const ALLOWED = new Set(["new", "reviewed", "dismissed"]);
const MAX_IDS = 10_000;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await smallJson(req, 500_000);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_IDS
    || !body.ids.every(isUuid) || !ALLOWED.has(status)) {
    return NextResponse.json({ error: "ids[] and a valid status required" }, { status: 400 });
  }
  const ids = [...new Set((body.ids as string[]).map(id => id.toLowerCase()))];
  try {
    // One transaction saves the exact company set and its full human-decision
    // receipt. No source research, pagination or count refresh is in this path.
    const { data, error } = await withServiceDeadline(Date.now() + 10_000, async () =>
      await serviceClient().rpc("companies_set_review_status", { p_ids: ids, p_status: status }));
    if (error) {
      const code = typeof error.code === "string" && /^[A-Z0-9]{5,12}$/.test(error.code) ? error.code : "unknown";
      console.error("companies.status_write_failed", { code });
      return NextResponse.json({ error: "status_save_failed" }, { status: code === "P0002" ? 409 : 503 });
    }
    const saved = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const savedIds = Array.isArray(saved?.ids) ? saved.ids : [];
    if (saved?.ok !== true || saved.status !== status || saved.count !== ids.length
      || savedIds.length !== ids.length || new Set(savedIds).size !== ids.length
      || !ids.every(id => savedIds.includes(id))) {
      return NextResponse.json({ error: "status_confirmation_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, count: ids.length, ids, status }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // A lost response may follow a committed write. Never retry automatically
    // or claim that nothing changed; the UI reconciles the exact account set.
    return NextResponse.json({ error: "status_confirmation_unavailable" }, { status: 503 });
  }
}
