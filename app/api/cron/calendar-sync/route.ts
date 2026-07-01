import { NextRequest, NextResponse } from "next/server";
import { getPrefs, syncCalendarBusy } from "@/lib/db/missions";
import { fetchBusyForRange } from "@/lib/missions/calendarFeed";

/**
 * 15-minute ICS poll (driven by Supabase pg_cron → this route). Reads the user's
 * published Outlook feed into calendar_busy for a rolling window, so the Missions
 * page reads pre-parsed busy instantly instead of fetching 600 events on each load.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const prefs = await getPrefs();
  const feed = prefs.ics_publish_url || process.env.ICS_PUBLISH_URL;
  if (!feed) return NextResponse.json({ ok: false, error: "no ics_publish_url set" });

  const now = Date.now();
  const windowStart = new Date(now - 2 * 86_400_000); // yesterday-ish
  const windowEnd = new Date(now + 45 * 86_400_000); // ~6 weeks ahead (covers month view)
  const blocks = await fetchBusyForRange(feed, windowStart, windowEnd, prefs.timezone);
  const count = await syncCalendarBusy(
    blocks.map((b) => ({ external_uid: b.external_uid, title: b.title ?? "Busy", start: b.start, end: b.end, busy: b.busy })),
    windowStart.toISOString(),
    windowEnd.toISOString(),
  );
  return NextResponse.json({ ok: true, synced: count, window: [windowStart.toISOString(), windowEnd.toISOString()] });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
