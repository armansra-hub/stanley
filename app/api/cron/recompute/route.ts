import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { logEvent } from "@/lib/db/events";

/**
 * Priority recompute. Three modes:
 *  • POST {ids:[...]} — recompute exactly those companies (used by offline ingests
 *    that insert triggers directly, e.g. the DOL 5500 scripts).
 *  • default (GET/POST, no ids) — every lead with priority>0 ("ghosts": trigger
 *    deleted/decayed + headcount<25 → drop to 0 and leave Triggered) PLUS "zombies":
 *    leads with a recent trigger but priority stuck at 0 (recordTrigger landed but the
 *    inline recompute crashed) so real signals can never be silently lost.
 * Secret-guarded. ?limit= caps the batch (default 1000).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000) || 1000, 2000);
  const db = serviceClient();

  let body: { ids?: string[] } = {};
  try { body = await req.json(); } catch { /* GET / empty body */ }
  let ids: string[];
  if (Array.isArray(body.ids) && body.ids.length) {
    ids = body.ids.slice(0, limit).map(String);
  } else {
    // Ghosts: currently surfaced (priority>0) — re-derive from live triggers + headcount.
    const { data } = await db.from("companies").select("id").gt("priority", 0).order("priority", { ascending: true }).limit(limit);
    const set = new Set((data ?? []).map((r) => (r as { id: string }).id));
    // Zombies: recent trigger exists but priority never got set (inline recompute failed).
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const { data: trigCos } = await db.from("triggers").select("company_id").gt("detected_at", since).limit(3000);
    const trigIds = [...new Set((trigCos ?? []).map((r) => (r as { company_id: string }).company_id))].filter((id) => !set.has(id));
    for (let i = 0; i < trigIds.length; i += 200) {
      const { data: zero } = await db.from("companies").select("id").in("id", trigIds.slice(i, i + 200)).or("priority.is.null,priority.eq.0");
      for (const r of zero ?? []) set.add((r as { id: string }).id);
    }
    ids = [...set].slice(0, limit);
  }

  // Time-boxed so a big batch commits partial progress instead of dying at the 60s kill.
  const deadline = Date.now() + 50_000;
  let dropped = 0, kept = 0, processed = 0;
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    if (Date.now() > deadline) break;
    const r = await Promise.all(ids.slice(i, i + BATCH).map((id) => recomputePriority(id).catch(() => null)));
    processed += r.length;
    for (const p of r) { if (p === null) continue; if (p <= 0) dropped++; else kept++; }
  }
  await logEvent("headhunter", "priority.recompute", { summary: `Priority recompute: ${dropped} ghosts dropped, ${kept} kept (${processed}/${ids.length})`, entity_type: "cron", meta: { dropped, kept, processed, total: ids.length } }).catch(() => {});
  return NextResponse.json({ checked: processed, of: ids.length, dropped, kept });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
