import { NextRequest, NextResponse } from "next/server";
import {
  recomputePriority,
  reservePriorityRecompute,
  utcDailyRotationEpoch,
} from "@/lib/db/triggers";
import { logEvent } from "@/lib/db/events";

/**
 * Priority recompute. Two modes:
 *  - POST {ids:[...]} recomputes exactly those companies.
 *  - Default GET/POST uses a durable oldest-reservation cursor across priority>0
 *    "ghosts" and a protected share of priority-zero "zombies" whose recent
 *    trigger landed but inline recompute failed. Priority is eligibility, never
 *    ordering.
 * Secret-guarded. ?limit= caps attempts (default 1000).
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
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 1000) || 1000, 2000));

  let body: { ids?: string[] } = {};
  try { body = await req.json(); } catch { /* GET / empty body */ }
  const explicitIds = Array.isArray(body.ids) && body.ids.length
    ? [...new Set(body.ids.map(String))].slice(0, limit)
    : null;

  // Reserve one micro-batch at a time. Once reserved, every row in that batch is
  // attempted before checking the deadline again, so a large unstarted tail is
  // never checkpointed merely because this invocation reached its timebox.
  const deadline = Date.now() + 50_000;
  const epoch = utcDailyRotationEpoch();
  let dropped = 0, kept = 0, failed = 0, processed = 0;
  let ghostsReserved = 0, zombiesReserved = 0, totalReserved = 0;
  const BATCH = 10;

  const attempt = async (ids: string[]) => {
    // Mapping starts every reserved attempt synchronously before Promise.all waits.
    const results = await Promise.all(ids.map((id) => recomputePriority(id).catch(() => null)));
    processed += results.length;
    for (const priority of results) {
      if (priority === null) failed++;
      else if (priority <= 0) dropped++;
      else kept++;
    }
  };

  if (explicitIds) {
    for (let i = 0; i < explicitIds.length; i += BATCH) {
      if (Date.now() > deadline) break;
      await attempt(explicitIds.slice(i, i + BATCH));
    }
  } else {
    while (processed < limit && Date.now() <= deadline) {
      const batchLimit = Math.min(BATCH, limit - processed);
      const zombieSlots = Math.min(batchLimit, Math.max(1, Math.ceil(batchLimit / 5)));
      const reservations = await reservePriorityRecompute(batchLimit, zombieSlots, epoch);
      if (reservations.length === 0) break;
      totalReserved += reservations.length;
      ghostsReserved += reservations.filter((row) => row.reservation_kind === "ghost").length;
      zombiesReserved += reservations.filter((row) => row.reservation_kind === "zombie").length;
      await attempt(reservations.map((row) => row.company_id));
    }
  }

  const mode = explicitIds ? "explicit" : "rotation";
  const total = explicitIds?.length ?? totalReserved;
  const receipt = {
    mode,
    checked: processed,
    of: total,
    capacity: limit,
    dropped,
    kept,
    failed,
    ghosts_reserved: ghostsReserved,
    zombies_reserved: zombiesReserved,
    epoch,
  };
  await logEvent("headhunter", "priority.recompute", {
    summary: `Priority recompute (${mode}): ${dropped} dropped, ${kept} kept, ${failed} failed (${processed}/${total} attempted)`,
    entity_type: "cron",
    meta: receipt,
  }).catch(() => {});
  return NextResponse.json(receipt);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
