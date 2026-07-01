import type { LeadTask } from "./types";

/**
 * The Task ↔ Mission bridge — the ONLY link between Kill List and Missions.
 *
 * A lead_task with a `due_at` mirrors into a Mission (kind 'task', source
 * 'pipeline', linked_account_id = lead id) so it shows in the Missions tab + emits
 * a calendar invite. This module is the DETERMINISTIC CORE: given a task's state it
 * decides what should happen to its Mission, and builds the Mission payload. No DB,
 * no side effects — unit-tested. lib/db/killlist.ts applies the decision.
 *
 * Idempotency anchor: `lead_tasks.mission_id`. We never double-create.
 */

export type BridgeOp =
  | { op: "create"; payload: MissionPayload }   // dated, open, no mission yet
  | { op: "update"; payload: MissionPayload }   // dated, open, mission exists → update invite
  | { op: "complete" }                          // task done → complete the mission
  | { op: "cancel" }                            // lost its date / deleted → remove the mission
  | { op: "none" };                             // nothing to mirror

export interface MissionPayload {
  title: string;
  notes: string | null;
  kind: "task" | "reminder";       // block_time → 'task' (auto-fit), else 'reminder' (pinned)
  due_at: string;                  // ISO
  scheduled_start: string | null;  // ISO for a block; null for a pinned reminder
  scheduled_end: string | null;    // ISO for a block; null for a pinned reminder
  reminder_lead_min: number | null; // minutes before, derived from remind_at
}

export const DEFAULT_TASK_MINUTES = 30;

/** Minutes between a reminder time and the due time (the VALARM lead). Clamped ≥ 0;
 * null when no explicit remind_at (the Mission falls back to the user's pref). */
export function reminderLeadMinutes(due_at: string, remind_at: string | null): number | null {
  if (!remind_at) return null;
  const lead = Math.round((new Date(due_at).getTime() - new Date(remind_at).getTime()) / 60_000);
  return lead > 0 ? lead : 0;
}

/** Build the Mission payload that mirrors a dated task. A time-block ('task') carries
 * a scheduled window (the DB layer may shift it to dodge meetings); a pinned reminder
 * carries none and stays exactly at due_at. */
export function missionPayloadForTask(
  task: Pick<LeadTask, "title" | "notes" | "due_at" | "remind_at" | "block_time">,
  leadName: string,
): MissionPayload | null {
  if (!task.due_at) return null;
  const start = new Date(task.due_at);
  const end = new Date(start.getTime() + DEFAULT_TASK_MINUTES * 60_000);
  const note = task.notes?.trim()
    ? `${task.notes.trim()}\n\n— ${leadName} (Kill List)`
    : `${leadName} (Kill List)`;
  const block = Boolean(task.block_time);
  return {
    title: task.title,
    notes: note,
    kind: block ? "task" : "reminder",
    due_at: start.toISOString(),
    scheduled_start: block ? start.toISOString() : null,
    scheduled_end: block ? end.toISOString() : null,
    reminder_lead_min: reminderLeadMinutes(task.due_at, task.remind_at ?? null),
  };
}

/** Decide what the task's Mission needs. `deleted` short-circuits to cancel. */
export function planTaskBridge(
  task: Pick<LeadTask, "title" | "notes" | "due_at" | "remind_at" | "block_time" | "status" | "mission_id">,
  leadName: string,
  opts: { deleted?: boolean } = {},
): BridgeOp {
  const hasMission = Boolean(task.mission_id);

  if (opts.deleted) return hasMission ? { op: "cancel" } : { op: "none" };
  if (task.status === "done") return hasMission ? { op: "complete" } : { op: "none" };

  if (task.due_at) {
    const payload = missionPayloadForTask(task, leadName)!;
    return hasMission ? { op: "update", payload } : { op: "create", payload };
  }
  // open + no date: if a Mission lingers from a previously-dated state, cancel it.
  return hasMission ? { op: "cancel" } : { op: "none" };
}
