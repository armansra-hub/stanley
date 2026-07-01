import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { logEvent } from "@/lib/db/events";

/**
 * One-shot priority recompute over every lead with priority>0. Recalculates from LIVE
 * triggers (with decay) + headcount, so "ghost" leads — priority cached >0 but whose
 * trigger was deleted or fully decayed and headcount<25 — drop to 0 and leave Triggered.
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
  const { data } = await db.from("companies").select("id").gt("priority", 0).order("priority", { ascending: true }).limit(limit);
  const ids = (data ?? []).map((r) => (r as { id: string }).id);

  let dropped = 0, kept = 0;
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await Promise.all(ids.slice(i, i + BATCH).map((id) => recomputePriority(id).catch(() => null)));
    for (const p of r) { if (p === null) continue; if (p <= 0) dropped++; else kept++; }
  }
  await logEvent("headhunter", "priority.recompute", { summary: `Priority recompute: ${dropped} ghosts dropped, ${kept} kept (of ${ids.length})`, entity_type: "cron", meta: { dropped, kept, total: ids.length } }).catch(() => {});
  return NextResponse.json({ checked: ids.length, dropped, kept });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
