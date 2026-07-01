import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { nextOccurrence } from "@/lib/missions/recurrence";
import type { Mission, UserPrefs, BusyBlock, MissionStatus } from "@/lib/missions/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapMission(r: any): Mission {
  return {
    id: String(r.id),
    title: String(r.title),
    notes: r.notes ?? null,
    kind: r.kind ?? "task",
    priority: r.priority ?? "medium",
    status: r.status ?? "open",
    due_at: r.due_at ?? null,
    scheduled_start: r.scheduled_start ?? null,
    scheduled_end: r.scheduled_end ?? null,
    all_day: Boolean(r.all_day),
    is_recurring: Boolean(r.is_recurring),
    rrule: r.rrule ?? null,
    linked_company_id: r.linked_company_id ?? null,
    linked_account_id: r.linked_account_id ?? null,
    source: r.source ?? "manual",
    ics_uid: String(r.ics_uid ?? ""),
    ics_sequence: Number(r.ics_sequence ?? 0),
    invite_sent_at: r.invite_sent_at ?? null,
    reminder_lead_min: r.reminder_lead_min ?? null,
    created_at: String(r.created_at ?? ""),
    completed_at: r.completed_at ?? null,
    dismissed_at: r.dismissed_at ?? null,
  };
}

// ── Prefs ─────────────────────────────────────────────────────────────────────
export async function getPrefs(): Promise<UserPrefs> {
  const db = serviceClient();
  const { data } = await db.from("user_prefs").select("*").eq("id", 1).single();
  const d = (data ?? {}) as any;
  return {
    timezone: d.timezone ?? "America/Los_Angeles",
    work_hours: d.work_hours ?? {},
    quiet_hours: d.quiet_hours ?? { start: "17:00", end: "08:00" },
    reminder_lead_min: Number(d.reminder_lead_min ?? 15),
    from_email: d.from_email ?? null,
    user_email: d.user_email ?? null,
    ics_publish_url: d.ics_publish_url ?? null,
  };
}

export async function setPrefs(patch: Partial<UserPrefs>): Promise<void> {
  const db = serviceClient();
  await db.from("user_prefs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
}

// ── Reads ─────────────────────────────────────────────────────────────────────
export interface MissionFilter {
  status?: MissionStatus | "active"; // "active" = open + snoozed
  limit?: number;
}

export async function listMissions(filter: MissionFilter = {}): Promise<Mission[]> {
  const db = serviceClient();
  let q = db.from("missions").select("*").order("due_at", { ascending: true, nullsFirst: false });
  const REAL = ["open", "done", "dismissed", "snoozed"];
  if (filter.status === "active") q = q.in("status", ["open", "snoozed"]);
  else if (filter.status && REAL.includes(filter.status)) q = q.eq("status", filter.status);
  // any other value (e.g. "all") = no status filter
  const { data } = await q.limit(filter.limit ?? 500);
  return (data ?? []).map(mapMission);
}

export async function getMission(id: string): Promise<Mission | null> {
  const db = serviceClient();
  const { data } = await db.from("missions").select("*").eq("id", id).maybeSingle();
  return data ? mapMission(data) : null;
}

// ── Writes ────────────────────────────────────────────────────────────────────
export interface CreateMissionInput {
  title: string;
  notes?: string | null;
  kind?: "task" | "reminder";
  priority?: "low" | "medium" | "high";
  due_at?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  all_day?: boolean;
  is_recurring?: boolean;
  rrule?: string | null;
  linked_company_id?: string | null;
  linked_account_id?: string | null;
  source?: "manual" | "voice" | "chat" | "auto" | "pipeline";
  reminder_lead_min?: number | null;
}

export async function createMission(input: CreateMissionInput): Promise<Mission> {
  const db = serviceClient();
  const { data, error } = await db.from("missions").insert({ ...input }).select("*").single();
  if (error) throw new Error(`createMission failed: ${error.message}`);
  return mapMission(data);
}

export async function updateMission(id: string, patch: Record<string, unknown>): Promise<Mission | null> {
  const db = serviceClient();
  const { data, error } = await db.from("missions").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw new Error(`updateMission failed: ${error.message}`);
  return data ? mapMission(data) : null;
}

/** Advance a recurring mission to its next occurrence (re-queue), shifting the
 * scheduled window by the same delta. Returns null when the recurrence has ended. */
function nextWindow(m: Mission): { due_at: string; scheduled_start?: string; scheduled_end?: string } | null {
  if (!m.is_recurring || !m.rrule) return null;
  const anchorIso = m.due_at ?? m.scheduled_start ?? new Date().toISOString();
  const anchor = new Date(anchorIso);
  const next = nextOccurrence(m.rrule, anchor, new Date(anchor.getTime() + 1000)); // strictly after current
  if (!next) return null;
  const out: { due_at: string; scheduled_start?: string; scheduled_end?: string } = { due_at: next.toISOString() };
  if (m.scheduled_start) {
    const delta = next.getTime() - anchor.getTime();
    out.scheduled_start = new Date(new Date(m.scheduled_start).getTime() + delta).toISOString();
    if (m.scheduled_end) out.scheduled_end = new Date(new Date(m.scheduled_end).getTime() + delta).toISOString();
  }
  return out;
}

/**
 * Complete or dismiss. RECURRING → re-queues to the next occurrence (stays open),
 * exactly like "dismiss it and it goes back to the next day it's due". ONE-OFF →
 * marked done / dismissed (lands in the Done / Dismissed folder).
 * Returns { mission, requeued } so callers know whether to re-issue an invite.
 */
async function resolveMission(id: string, mode: "done" | "dismissed"): Promise<{ mission: Mission | null; requeued: boolean }> {
  const m = await getMission(id);
  if (!m) return { mission: null, requeued: false };

  const win = nextWindow(m);
  if (win) {
    // Recurring: advance, bump SEQUENCE so a fresh invite updates Outlook in place.
    const updated = await updateMission(id, {
      ...win,
      status: "open",
      completed_at: null,
      dismissed_at: null,
      ics_sequence: m.ics_sequence + 1,
    });
    return { mission: updated, requeued: true };
  }
  const now = new Date().toISOString();
  const patch = mode === "done"
    ? { status: "done", completed_at: now }
    : { status: "dismissed", dismissed_at: now };
  const updated = await updateMission(id, patch);
  return { mission: updated, requeued: false };
}

export const completeMission = (id: string) => resolveMission(id, "done");
export const dismissMission = (id: string) => resolveMission(id, "dismissed");

/** Snooze: push due (and any scheduled window) by `minutes`. */
export async function snoozeMission(id: string, minutes: number): Promise<Mission | null> {
  const m = await getMission(id);
  if (!m) return null;
  const shift = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + minutes * 60_000).toISOString() : null);
  return updateMission(id, {
    status: "snoozed",
    due_at: shift(m.due_at),
    scheduled_start: shift(m.scheduled_start),
    scheduled_end: shift(m.scheduled_end),
    ics_sequence: m.ics_sequence + 1, // so the re-sent invite updates Outlook in place
  });
}

export async function rescheduleMission(id: string, start: string, end: string | null): Promise<Mission | null> {
  const m = await getMission(id);
  if (!m) return null;
  return updateMission(id, {
    scheduled_start: start,
    scheduled_end: end,
    due_at: start,
    status: "open",
    ics_sequence: m.ics_sequence + 1, // so the re-sent invite updates Outlook in place
  });
}

export async function markInviteSent(id: string): Promise<void> {
  await updateMission(id, { invite_sent_at: new Date().toISOString() });
}

/** Log a Stanley turn for later review (graceful before migration 0011). */
export async function logStanleyTurn(userText: string, reply: string, plan: unknown): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("stanley_logs").insert({ user_text: userText, reply, plan });
  } catch {
    /* table missing → no-op */
  }
}

/** Hard-delete a mission (the agent's "delete"). */
export async function deleteMission(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("missions").delete().eq("id", id);
  if (error) throw new Error(`deleteMission failed: ${error.message}`);
}

/** Edit title / priority / notes (the agent's "edit"). */
export async function editMission(id: string, patch: { title?: string; priority?: string; notes?: string }): Promise<Mission | null> {
  const clean: Record<string, unknown> = {};
  if (patch.title != null) clean.title = patch.title;
  if (patch.priority != null) clean.priority = patch.priority;
  if (patch.notes !== undefined) clean.notes = patch.notes;
  if (Object.keys(clean).length === 0) return getMission(id);
  return updateMission(id, clean);
}

// ── Calendar busy ─────────────────────────────────────────────────────────────
/** Replace the calendar_busy rows in [windowStart, windowEnd] with a fresh set
 * (the 15-min ICS poll). Idempotent: clears the window, then inserts. */
export async function syncCalendarBusy(
  blocks: { external_uid: string | null; title: string; start: string; end: string; busy: boolean }[],
  windowStart: string,
  windowEnd: string,
): Promise<number> {
  const db = serviceClient();
  await db.from("calendar_busy").delete().gte("start", windowStart).lt("start", windowEnd);
  if (blocks.length === 0) return 0;
  const rows = blocks.map((b) => ({ external_uid: b.external_uid, title: b.title, start: b.start, end: b.end, busy: b.busy, last_synced: new Date().toISOString() }));
  const { error } = await db.from("calendar_busy").insert(rows);
  if (error) throw new Error(`syncCalendarBusy failed: ${error.message}`);
  return rows.length;
}

export async function getBusyInRange(startIso: string, endIso: string): Promise<BusyBlock[]> {
  const db = serviceClient();
  const { data } = await db
    .from("calendar_busy")
    .select("id, external_uid, title, start, \"end\", busy")
    .lt("start", endIso)
    .gt("end", startIso)
    .order("start", { ascending: true });
  return (data ?? []) as BusyBlock[];
}
