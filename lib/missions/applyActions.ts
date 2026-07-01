import "server-only";
import {
  createMission, completeMission, dismissMission, deleteMission, rescheduleMission,
  snoozeMission, editMission, updateMission, getPrefs, setPrefs, listMissions, getBusyInRange,
} from "@/lib/db/missions";
import { wallClockToUtc } from "./timeutil";
import { buildRRule, type RecurrenceIntent } from "./recurrence";
import { freeSlots } from "./schedule";
import { ms, dayKeyOf, workWindow, placeTimedTask } from "./placement";
import { detachTaskByMission, rescheduleTaskByMission } from "@/lib/db/killlist";
import { logEvent } from "@/lib/db/events";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Action { name: string; input: any }

const toUtc = (local: string | null, tz: string) => { if (!local) return null; const d = wallClockToUtc(local, tz); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

async function buildCreateInput(i: any, tz: string) {
  const isRec = i.recurrence_freq && i.recurrence_freq !== "none";
  const rrule = isRec ? buildRRule({ freq: i.recurrence_freq, interval: i.recurrence_interval, byweekday: i.recurrence_byweekday } as RecurrenceIntent) : null;
  let due = toUtc(i.local_due, tz);
  let scheduled_start: string | null = null, scheduled_end: string | null = null;
  if (i.kind === "task" && due && !i.all_day) {
    const dur = (i.duration_minutes ?? 30) * 60_000;
    const start = await placeTimedTask(dayKeyOf(due, tz), ms(due), dur, tz);
    scheduled_start = new Date(start).toISOString();
    scheduled_end = new Date(start + dur).toISOString();
    due = scheduled_start; // align the due time to where it was actually placed
  }
  return {
    title: i.title, kind: i.kind ?? "reminder", priority: i.priority ?? "medium", notes: i.notes ?? null,
    due_at: due, scheduled_start, scheduled_end, all_day: !!i.all_day, is_recurring: !!isRec, rrule,
    linked_company_id: i.link_company_id ?? null, source: "chat" as const,
  };
}

/** Execute a confirmed plan of write actions. Returns one result line per action +
 * whether any missions changed (so the UI can refresh). */
export async function applyActions(actions: Action[], tz: string): Promise<{ results: string[]; changed: boolean }> {
  const results: string[] = [];
  let changed = false;
  for (const a of actions) {
    try {
      const i = a.input ?? {};
      switch (a.name) {
        case "create_mission": { await createMission(await buildCreateInput(i, tz)); await logEvent("missions", "mission.created", { summary: `Created ${i.kind === "task" ? "task" : "reminder"} “${i.title}”`, entity_type: "mission", meta: { kind: i.kind } }); results.push(`Created “${i.title}”`); changed = true; break; }
        case "complete_mission": { await completeMission(i.id); results.push("Completed"); changed = true; break; }
        case "dismiss_mission": { await dismissMission(i.id); results.push("Dismissed"); changed = true; break; }
        case "delete_mission": { await detachTaskByMission(i.id).catch(() => {}); await deleteMission(i.id); results.push("Deleted"); changed = true; break; }
        case "reschedule_mission": {
          const start = toUtc(i.local_start, tz);
          const end = start ? new Date(new Date(start).getTime() + (i.duration_minutes ?? 30) * 60_000).toISOString() : null;
          if (start) { await rescheduleMission(i.id, start, end); await rescheduleTaskByMission(i.id, start).catch(() => {}); results.push("Rescheduled"); changed = true; }
          break;
        }
        case "snooze_mission": { await snoozeMission(i.id, Math.max(1, Number(i.minutes ?? 10))); results.push("Snoozed"); changed = true; break; }
        case "edit_mission": {
          const patch: any = {};
          if (i.title != null) patch.title = i.title;
          if (i.priority != null) patch.priority = i.priority;
          if (i.notes !== undefined) patch.notes = i.notes;
          if (i.recurrence_freq != null) {
            if (i.recurrence_freq === "none") { patch.is_recurring = false; patch.rrule = null; }
            else { patch.is_recurring = true; patch.rrule = buildRRule({ freq: i.recurrence_freq, interval: i.recurrence_interval ?? 1, byweekday: i.recurrence_byweekday ?? [] } as RecurrenceIntent); }
          }
          if (i.local_due) {
            const due = toUtc(i.local_due, tz);
            patch.due_at = due;
            if (due) { patch.scheduled_start = due; patch.scheduled_end = new Date(new Date(due).getTime() + (i.duration_minutes ?? 30) * 60_000).toISOString(); }
          }
          if (Object.keys(patch).length) await updateMission(i.id, patch);
          results.push("Edited"); changed = true; break;
        }
        case "plan_day": { results.push(await applyPlanDay(i.date, tz)); changed = true; break; }
        case "create_cadence": { results.push(await applyCadence(i, tz)); changed = true; break; }
        case "set_prefs": { await applySetPrefs(i); results.push("Preferences updated"); break; }
        default: results.push(`(skipped ${a.name})`);
      }
    } catch (e) {
      results.push(`Failed ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results, changed };
}

const PRI: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Re-flow ALL of a day's tasks into a clean, non-overlapping schedule around the
 * Outlook busy blocks — keeping each task's duration + priority order. Reminders are
 * point nudges, so they're left at their own time. */
async function applyPlanDay(date: string, tz: string): Promise<string> {
  const { ws, we } = await workWindow(date, tz);
  const busy = (await getBusyInRange(new Date(ws).toISOString(), new Date(we).toISOString())).map((b) => ({ start: ms(b.start), end: ms(b.end) }));
  const active = await listMissions({ status: "active" });
  const todays = active
    .filter((m) => m.kind === "task" && ((m.due_at && dayKeyOf(m.due_at, tz) === date) || (m.scheduled_start && dayKeyOf(m.scheduled_start, tz) === date)))
    .map((m) => ({ m, dur: m.scheduled_start && m.scheduled_end ? ms(m.scheduled_end) - ms(m.scheduled_start) : 30 * 60_000 }))
    .sort((a, b) => (PRI[a.m.priority] ?? 1) - (PRI[b.m.priority] ?? 1) || (a.m.scheduled_start ?? a.m.due_at ?? "").localeCompare(b.m.scheduled_start ?? b.m.due_at ?? ""));

  const occupied = [...busy];
  let n = 0, unfit = 0;
  for (const { m, dur } of todays) {
    const slot = freeSlots(ws, we, occupied).find((g) => g.end - g.start >= dur);
    if (!slot) { unfit++; continue; }
    const start = slot.start, end = start + dur;
    await updateMission(m.id, { scheduled_start: new Date(start).toISOString(), scheduled_end: new Date(end).toISOString(), due_at: new Date(start).toISOString() });
    occupied.push({ start, end });
    n++;
  }
  return `Planned ${date}: arranged ${n} task${n === 1 ? "" : "s"}${unfit ? `, ${unfit} couldn’t fit in work hours` : ""}`;
}

async function applyCadence(i: any, tz: string): Promise<string> {
  const steps: number[] = Array.isArray(i.steps_days) ? i.steps_days : [2, 7, 30];
  for (const day of steps) {
    const d = new Date(); d.setDate(d.getDate() + day);
    const local = `${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d)}T09:00`;
    await createMission({
      title: i.title, kind: "reminder", priority: "medium", source: "chat",
      due_at: toUtc(local, tz), notes: `Follow-up cadence · day ${day}${i.notes ? ` · ${i.notes}` : ""}`,
      linked_company_id: i.link_company_id ?? null,
    });
  }
  return `Created ${steps.length}-touch cadence for “${i.title}”`;
}

async function applySetPrefs(i: any): Promise<void> {
  const prefs = await getPrefs();
  const patch: any = {};
  if (i.timezone) patch.timezone = i.timezone;
  if (i.reminder_lead_min != null) patch.reminder_lead_min = Number(i.reminder_lead_min);
  if (i.work_start || i.work_end) {
    const wh = { ...prefs.work_hours };
    for (const k of ["1", "2", "3", "4", "5"]) wh[k] = { start: i.work_start ?? wh[k]?.start ?? "08:00", end: i.work_end ?? wh[k]?.end ?? "17:00" };
    patch.work_hours = wh;
  }
  await setPrefs(patch);
}
