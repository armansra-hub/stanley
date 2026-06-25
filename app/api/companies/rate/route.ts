import { NextRequest, NextResponse } from "next/server";
import { setRating } from "@/lib/db/companies";
import { learnFromRatings } from "@/lib/learn/feedback";

/**
 * Save a lead's 1–5 quality rating (+ optional comment), then immediately re-run
 * the learning loop so the scoring tunes itself on every rating. The learn step
 * is best-effort — a failure there never fails the save.
 */
export async function POST(req: NextRequest) {
  let body: { id?: string; rating?: number | null; comment?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const id = body?.id;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const rating = body.rating == null ? null : Number(body.rating);
  if (rating != null && (rating < 1 || rating > 5)) {
    return NextResponse.json({ error: "rating must be 1..5 or null" }, { status: 400 });
  }

  await setRating(id, rating, body.comment ?? null);

  let learned: Awaited<ReturnType<typeof learnFromRatings>> | null = null;
  try {
    learned = await learnFromRatings();
  } catch {
    /* learning is best-effort */
  }
  return NextResponse.json({ ok: true, multipliers: learned?.multipliers ?? null });
}
