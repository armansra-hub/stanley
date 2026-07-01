import MissionsBoard from "@/components/MissionsBoard";
import { SAMPLE_MISSIONS, SAMPLE_BUSY } from "@/lib/missions/sampleMissions";
import { listMissions, getPrefs, getBusyInRange } from "@/lib/db/missions";
import { fetchBusyForRange } from "@/lib/missions/calendarFeed";
import { hasSupabaseEnv } from "@/lib/supabase/server";
import type { Mission, UserPrefs } from "@/lib/missions/types";

export const dynamic = "force-dynamic";

const DEFAULT_WORK = { "1": { start: "08:00", end: "17:00" }, "2": { start: "08:00", end: "17:00" }, "3": { start: "08:00", end: "17:00" }, "4": { start: "08:00", end: "17:00" }, "5": { start: "08:00", end: "17:00" } } as UserPrefs["work_hours"];

export default async function MissionsPage() {
  let missions: Mission[] = SAMPLE_MISSIONS;
  let usingSample = true;
  let timezone = "America/Los_Angeles";
  let workHours = DEFAULT_WORK;
  let busy: { start: string; end: string }[] = SAMPLE_BUSY;

  if (hasSupabaseEnv()) {
    try {
      const prefs = await getPrefs();
      timezone = prefs.timezone;
      workHours = prefs.work_hours && Object.keys(prefs.work_hours).length ? prefs.work_hours : DEFAULT_WORK;

      const fromDb = await listMissions({ status: "active" });
      if (fromDb.length > 0) {
        missions = fromDb;
        usingSample = false;
      }

      // Busy window covering month view; prefer the synced calendar_busy (fast),
      // else live-fetch a shorter window so day/week work before the cron runs.
      const now = Date.now();
      const winStart = new Date(now - 2 * 86_400_000).toISOString();
      const winEnd = new Date(now + 45 * 86_400_000).toISOString();
      let realBusy = (await getBusyInRange(winStart, winEnd)).map((b) => ({ start: b.start, end: b.end }));
      if (realBusy.length === 0 && prefs.ics_publish_url) {
        const live = await fetchBusyForRange(prefs.ics_publish_url, new Date(now - 86_400_000), new Date(now + 14 * 86_400_000), timezone);
        realBusy = live.map((b) => ({ start: b.start, end: b.end }));
      }
      if (!usingSample || realBusy.length > 0) busy = realBusy;
    } catch (e) {
      console.error("missions load failed, using sample:", e);
    }
  }

  return <MissionsBoard initial={missions} usingSample={usingSample} timezone={timezone} workHours={workHours} busy={busy} />;
}
