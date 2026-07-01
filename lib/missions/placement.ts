import "server-only";
import { getPrefs, listMissions, getBusyInRange } from "@/lib/db/missions";
import { wallClockToUtc } from "./timeutil";
import { freeSlots } from "./schedule";

/**
 * Deterministic calendar placement — kept in its own module so both the Missions
 * apply layer and the Kill List bridge can use it without a circular import. All
 * work-window math is in the USER's timezone (never the server's).
 */

export const ms = (iso: string) => new Date(iso).getTime();
export const dayKeyOf = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));

/** Work window for a local date, in the user's timezone. */
export async function workWindow(dateStr: string, tz: string): Promise<{ ws: number; we: number }> {
  const prefs = await getPrefs();
  const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const wh = prefs.work_hours[wd === 0 ? "7" : String(wd)] ?? { start: "08:00", end: "17:00" };
  return { ws: wallClockToUtc(`${dateStr}T${wh.start}`, tz).getTime(), we: wallClockToUtc(`${dateStr}T${wh.end}`, tz).getTime() };
}

/** Earliest non-overlapping start ≥ the desired time, clear of Outlook busy AND any
 * already-scheduled task that day. Keeps created blocks from colliding. */
export async function placeTimedTask(dateStr: string, desiredStartMs: number, durationMs: number, tz: string): Promise<number> {
  const { ws, we } = await workWindow(dateStr, tz);
  const lo = new Date(Math.min(desiredStartMs, ws) - 3_600_000).toISOString();
  const hi = new Date(we + 12 * 3_600_000).toISOString();
  const busy = (await getBusyInRange(lo, hi)).map((b) => ({ start: ms(b.start), end: ms(b.end) }));
  const tasks = (await listMissions({ status: "active" }))
    .filter((m) => m.scheduled_start && dayKeyOf(m.scheduled_start, tz) === dateStr)
    .map((m) => ({ start: ms(m.scheduled_start!), end: m.scheduled_end ? ms(m.scheduled_end) : ms(m.scheduled_start!) + durationMs }));
  const winEnd = Math.max(we, desiredStartMs + durationMs);
  const gaps = freeSlots(Math.min(ws, desiredStartMs), winEnd + 6 * 3_600_000, [...busy, ...tasks]);
  const earliest = Math.max(desiredStartMs, ws);
  for (const g of gaps) {
    const start = Math.max(g.start, earliest);
    if (g.end - start >= durationMs) return start;
  }
  return earliest; // nothing free — fall back to requested time
}

/** Given a desired ISO start + duration, return the earliest non-conflicting ISO start. */
export async function placeMissionStart(desiredIso: string, durationMin: number, tz: string): Promise<string> {
  const start = await placeTimedTask(dayKeyOf(desiredIso, tz), ms(desiredIso), durationMin * 60_000, tz);
  return new Date(start).toISOString();
}
