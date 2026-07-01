import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { createMission, updateMission, getMission, completeMission, deleteMission, getPrefs } from "@/lib/db/missions";
import { placeMissionStart } from "@/lib/missions/placement";
import { planTaskBridge, DEFAULT_TASK_MINUTES, type MissionPayload } from "@/lib/killlist/bridge";
import { logEvent } from "@/lib/db/events";
import type { PipelineStage, Lead, LeadNote, LeadTask } from "@/lib/killlist/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = () => new Date().toISOString();

/** True when a write failed because a column is absent (DB predates a migration).
 * PostgREST surfaces this as PGRST204 (schema-cache miss) or Postgres 42703. */
const missingColumn = (error: any, col: string): boolean =>
  !!error && (error.code === "PGRST204" || error.code === "42703" || new RegExp(col).test(error.message ?? ""));

function mapStage(r: any): PipelineStage {
  return { id: String(r.id), name: String(r.name), sort_order: Number(r.sort_order ?? 0), color: r.color ?? null, archived: Boolean(r.archived) };
}
function mapLead(r: any): Lead {
  return {
    id: String(r.id), name: String(r.name), website: r.website ?? null, description: r.description ?? null,
    netsuite_url: r.netsuite_url ?? null, stage_id: r.stage_id ?? null, sort_in_stage: Number(r.sort_in_stage ?? 0),
    last_activity_at: String(r.last_activity_at ?? ""), created_at: String(r.created_at ?? ""), updated_at: String(r.updated_at ?? ""),
  };
}
function mapNote(r: any): LeadNote {
  return { id: String(r.id), lead_id: String(r.lead_id), body: String(r.body), author: r.author ?? "manual", created_at: String(r.created_at ?? "") };
}
function mapTask(r: any): LeadTask {
  return {
    id: String(r.id), lead_id: String(r.lead_id), title: String(r.title), notes: r.notes ?? null,
    due_at: r.due_at ?? null, remind_at: r.remind_at ?? null, block_time: Boolean(r.block_time), status: r.status ?? "open",
    mission_id: r.mission_id ?? null, created_at: String(r.created_at ?? ""), completed_at: r.completed_at ?? null,
  };
}

// ── Stages ──────────────────────────────────────────────────────────────────
export async function listStages(includeArchived = false): Promise<PipelineStage[]> {
  const db = serviceClient();
  let q = db.from("pipeline_stages").select("*").order("sort_order", { ascending: true });
  if (!includeArchived) q = q.eq("archived", false);
  const { data } = await q;
  return (data ?? []).map(mapStage);
}

export async function addStage(name: string, color?: string | null): Promise<PipelineStage> {
  const db = serviceClient();
  const stages = await listStages(true);
  const sort_order = stages.reduce((m, s) => Math.max(m, s.sort_order), -1) + 1;
  const { data, error } = await db.from("pipeline_stages").insert({ name, color: color ?? null, sort_order }).select("*").single();
  if (error) throw new Error(`addStage failed: ${error.message}`);
  return mapStage(data);
}

export async function renameStage(id: string, name: string): Promise<void> {
  const db = serviceClient();
  await db.from("pipeline_stages").update({ name }).eq("id", id);
}

export async function reorderStages(orderedIds: string[]): Promise<void> {
  const db = serviceClient();
  await Promise.all(orderedIds.map((id, i) => db.from("pipeline_stages").update({ sort_order: i }).eq("id", id)));
}

/** Archive a stage, first reassigning its leads to another active stage so none
 * silently disappear from the board. No-op if it's the only stage left. */
export async function archiveStage(id: string): Promise<{ moved: number; into: string | null }> {
  const db = serviceClient();
  const active = await listStages();
  const fallback = active.find((s) => s.id !== id);
  if (!fallback) return { moved: 0, into: null }; // last stage — keep it
  const { data: orphans } = await db.from("leads").select("id").eq("stage_id", id);
  const ids = (orphans ?? []).map((o: any) => o.id);
  if (ids.length) await db.from("leads").update({ stage_id: fallback.id }).in("id", ids);
  await db.from("pipeline_stages").update({ archived: true }).eq("id", id);
  return { moved: ids.length, into: fallback.name };
}

// ── Leads ───────────────────────────────────────────────────────────────────
/** All leads, each decorated with open-task count + soonest open due date (card view). */
export async function listLeads(): Promise<Lead[]> {
  const db = serviceClient();
  const { data } = await db.from("leads").select("*").order("sort_in_stage", { ascending: true });
  const leads = (data ?? []).map(mapLead);
  const { data: tasks } = await db.from("lead_tasks").select("lead_id, due_at, status").eq("status", "open");
  const byLead = new Map<string, { count: number; next: string | null }>();
  for (const t of (tasks ?? []) as any[]) {
    const e = byLead.get(t.lead_id) ?? { count: 0, next: null };
    e.count += 1;
    if (t.due_at && (!e.next || t.due_at < e.next)) e.next = t.due_at;
    byLead.set(t.lead_id, e);
  }
  return leads.map((l) => ({ ...l, open_tasks: byLead.get(l.id)?.count ?? 0, next_due_at: byLead.get(l.id)?.next ?? null }));
}

export async function getLead(id: string): Promise<Lead | null> {
  const db = serviceClient();
  const { data } = await db.from("leads").select("*").eq("id", id).maybeSingle();
  return data ? mapLead(data) : null;
}

export interface CreateLeadInput { name: string; website?: string | null; description?: string | null; netsuite_url?: string | null; stage_id?: string | null }
export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const db = serviceClient();
  let stage_id = input.stage_id ?? null;
  if (!stage_id) { const stages = await listStages(); stage_id = stages[0]?.id ?? null; } // default → first stage
  const { data, error } = await db.from("leads").insert({
    name: input.name, website: input.website ?? null, description: input.description ?? null,
    netsuite_url: input.netsuite_url ?? null, stage_id,
  }).select("*").single();
  if (error) throw new Error(`createLead failed: ${error.message}`);
  const lead = mapLead(data);
  await logEvent("killlist", "lead.created", { summary: `Added pipeline lead “${lead.name}”`, entity_type: "lead", entity_id: lead.id });
  return lead;
}

export async function updateLead(id: string, patch: Partial<Pick<Lead, "name" | "website" | "description" | "netsuite_url" | "stage_id" | "sort_in_stage">>): Promise<Lead | null> {
  const db = serviceClient();
  const { data, error } = await db.from("leads").update({ ...patch, updated_at: now() }).eq("id", id).select("*").maybeSingle();
  if (error) throw new Error(`updateLead failed: ${error.message}`);
  return data ? mapLead(data) : null;
}

export async function moveLeadStage(id: string, stage_id: string, sort_in_stage?: number): Promise<Lead | null> {
  const before = await getLead(id);
  const updated = await updateLead(id, { stage_id, ...(sort_in_stage != null ? { sort_in_stage } : {}) });
  if (before && before.stage_id !== stage_id) { // auto-activity timeline entry
    const stages = await listStages(true);
    const name = stages.find((s) => s.id === stage_id)?.name ?? "another stage";
    await systemNote(id, `Moved to ${name}`);
    await logEvent("killlist", "lead.stage_moved", { summary: `Moved “${before.name}” to ${name}`, entity_type: "lead", entity_id: id, meta: { to: name } });
  }
  return updated;
}

/** A system-authored activity-log entry (auto timeline). Best-effort: if the DB
 * predates the 'system' author (migration 0013), fall back to a 'chatbot' entry. */
async function systemNote(lead_id: string, body: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("lead_notes").insert({ lead_id, body, author: "system" });
  if (error) await db.from("lead_notes").insert({ lead_id, body, author: "chatbot" }).then(() => {}, () => {});
}

export async function deleteLead(id: string): Promise<void> {
  const db = serviceClient();
  // cancel any bridged missions first, then cascade-delete the lead's children
  const { data: tasks } = await db.from("lead_tasks").select("mission_id").eq("lead_id", id);
  for (const t of (tasks ?? []) as any[]) if (t.mission_id) { try { await deleteMission(t.mission_id); } catch { /* already gone */ } }
  await db.from("leads").delete().eq("id", id);
}

// ── Notes (activity log) ──────────────────────────────────────────────────────
export async function listLeadNotes(lead_id: string): Promise<LeadNote[]> {
  const db = serviceClient();
  const { data } = await db.from("lead_notes").select("*").eq("lead_id", lead_id).order("created_at", { ascending: false });
  return (data ?? []).map(mapNote);
}

export async function addNote(lead_id: string, body: string, author: "manual" | "chatbot" = "manual"): Promise<LeadNote> {
  const db = serviceClient();
  const { data, error } = await db.from("lead_notes").insert({ lead_id, body, author }).select("*").single();
  if (error) throw new Error(`addNote failed: ${error.message}`);
  await touchLead(lead_id);
  return mapNote(data);
}

async function touchLead(id: string): Promise<void> {
  const db = serviceClient();
  await db.from("leads").update({ last_activity_at: now(), updated_at: now() }).eq("id", id);
}

// ── Tasks + the Mission bridge ────────────────────────────────────────────────
export async function listLeadTasks(lead_id: string): Promise<LeadTask[]> {
  const db = serviceClient();
  const { data } = await db.from("lead_tasks").select("*").eq("lead_id", lead_id).order("due_at", { ascending: true, nullsFirst: false });
  return (data ?? []).map(mapTask);
}

async function getTask(id: string): Promise<LeadTask | null> {
  const db = serviceClient();
  const { data } = await db.from("lead_tasks").select("*").eq("id", id).maybeSingle();
  return data ? mapTask(data) : null;
}

/** Build the create/update fields for a bridged Mission. For a time-block, dodge the
 * user's Outlook meetings + other tasks (placement); a reminder stays pinned. */
async function missionFields(payload: MissionPayload, leadId: string, tz: string) {
  let scheduled_start = payload.scheduled_start;
  let scheduled_end = payload.scheduled_end;
  let due_at = payload.due_at;
  if (payload.kind === "task" && payload.scheduled_start) {
    const placed = await placeMissionStart(payload.scheduled_start, DEFAULT_TASK_MINUTES, tz);
    scheduled_start = placed;
    scheduled_end = new Date(new Date(placed).getTime() + DEFAULT_TASK_MINUTES * 60_000).toISOString();
    due_at = placed;
  }
  return { title: payload.title, notes: payload.notes, kind: payload.kind, due_at, scheduled_start, scheduled_end, reminder_lead_min: payload.reminder_lead_min };
}

/** Run the deterministic bridge for a task, performing the Mission side-effect and
 * returning the resulting mission_id (or null). Idempotent on task.mission_id. */
async function applyTaskBridge(task: LeadTask, leadName: string, opts: { deleted?: boolean } = {}): Promise<string | null> {
  const op = planTaskBridge(task, leadName, opts);
  const tz = op.op === "create" || op.op === "update" ? (await getPrefs().catch(() => null))?.timezone ?? "America/Los_Angeles" : "UTC";
  switch (op.op) {
    case "create": {
      const m = await createMission({ ...(await missionFields(op.payload, task.lead_id, tz)), source: "pipeline", linked_account_id: task.lead_id });
      return m.id;
    }
    case "update": {
      const existing = task.mission_id ? await getMission(task.mission_id) : null;
      if (!existing) { // mission vanished — recreate so the calendar stays in sync
        const m = await createMission({ ...(await missionFields(op.payload, task.lead_id, tz)), source: "pipeline", linked_account_id: task.lead_id });
        return m.id;
      }
      await updateMission(task.mission_id!, {
        ...(await missionFields(op.payload, task.lead_id, tz)), status: "open", completed_at: null, dismissed_at: null,
        ics_sequence: existing.ics_sequence + 1, // re-issued invite updates Outlook in place
      });
      return task.mission_id!;
    }
    case "complete": {
      if (task.mission_id) await completeMission(task.mission_id);
      return task.mission_id ?? null;
    }
    case "cancel": {
      if (task.mission_id) { try { await deleteMission(task.mission_id); } catch { /* already gone */ } }
      return null;
    }
    default:
      return task.mission_id ?? null;
  }
}

export interface AddTaskInput { lead_id: string; title: string; notes?: string | null; due_at?: string | null; remind_at?: string | null; block_time?: boolean }
export async function addTask(input: AddTaskInput): Promise<LeadTask> {
  const db = serviceClient();
  const row: Record<string, unknown> = {
    lead_id: input.lead_id, title: input.title, notes: input.notes ?? null,
    due_at: input.due_at ?? null, remind_at: input.remind_at ?? null, block_time: !!input.block_time,
  };
  let { data, error } = await db.from("lead_tasks").insert(row).select("*").single();
  if (missingColumn(error, "block_time")) { delete row.block_time; ({ data, error } = await db.from("lead_tasks").insert(row).select("*").single()); } // pre-0013 DB
  if (error) throw new Error(`addTask failed: ${error.message}`);
  let task = mapTask(data);
  const lead = await getLead(task.lead_id);
  const mission_id = await applyTaskBridge(task, lead?.name ?? "Lead");
  if (mission_id !== task.mission_id) { await db.from("lead_tasks").update({ mission_id }).eq("id", task.id); task = { ...task, mission_id }; }
  await touchLead(task.lead_id);
  return task;
}

export interface EditTaskInput { title?: string; notes?: string | null; due_at?: string | null; remind_at?: string | null; block_time?: boolean }
export async function editTask(id: string, patch: EditTaskInput): Promise<LeadTask | null> {
  const db = serviceClient();
  const clean: Record<string, unknown> = {};
  if (patch.title != null) clean.title = patch.title;
  if (patch.notes !== undefined) clean.notes = patch.notes;
  if (patch.due_at !== undefined) clean.due_at = patch.due_at;
  if (patch.remind_at !== undefined) clean.remind_at = patch.remind_at;
  if (patch.block_time !== undefined) clean.block_time = patch.block_time;
  let { data, error } = await db.from("lead_tasks").update(clean).eq("id", id).select("*").maybeSingle();
  if (missingColumn(error, "block_time")) { delete clean.block_time; ({ data, error } = await db.from("lead_tasks").update(clean).eq("id", id).select("*").maybeSingle()); } // pre-0013 DB
  if (error) throw new Error(`editTask failed: ${error.message}`);
  if (!data) return null;
  let task = mapTask(data);
  const lead = await getLead(task.lead_id);
  const mission_id = await applyTaskBridge(task, lead?.name ?? "Lead");
  if (mission_id !== task.mission_id) { await db.from("lead_tasks").update({ mission_id }).eq("id", task.id); task = { ...task, mission_id }; }
  await touchLead(task.lead_id);
  return task;
}

export async function completeTask(id: string, done = true): Promise<LeadTask | null> {
  const db = serviceClient();
  const { data } = await db.from("lead_tasks").update({ status: done ? "done" : "open", completed_at: done ? now() : null }).eq("id", id).select("*").maybeSingle();
  if (!data) return null;
  let task = mapTask(data);
  const lead = await getLead(task.lead_id);
  // done → complete the mission; reopened → re-create/update via the bridge
  const mission_id = await applyTaskBridge(task, lead?.name ?? "Lead");
  if (done && task.mission_id) { /* keep mission_id link for history */ }
  else if (mission_id !== task.mission_id) { await db.from("lead_tasks").update({ mission_id }).eq("id", task.id); task = { ...task, mission_id }; }
  if (done) await systemNote(task.lead_id, `Completed: ${task.title}`); // auto-activity timeline
  await touchLead(task.lead_id);
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  const db = serviceClient();
  const task = await getTask(id);
  if (task) { const lead = await getLead(task.lead_id); await applyTaskBridge(task, lead?.name ?? "Lead", { deleted: true }); }
  await db.from("lead_tasks").delete().eq("id", id);
  if (task) await touchLead(task.lead_id);
}

/** Reverse bridge: a Mission completed/dismissed in the Missions tab checks off its
 * linked lead_task (two-way status sync). Called from the Missions action route. */
export async function completeTaskByMission(mission_id: string): Promise<void> {
  const db = serviceClient();
  const { data } = await db.from("lead_tasks").update({ status: "done", completed_at: now() }).eq("mission_id", mission_id).eq("status", "open").select("lead_id, title").maybeSingle();
  if (data) await systemNote((data as any).lead_id, `Completed: ${(data as any).title}`);
}

/** Reverse bridge: rescheduling a bridged Mission moves the lead_task's due date too. */
export async function rescheduleTaskByMission(mission_id: string, newStartIso: string): Promise<void> {
  const db = serviceClient();
  await db.from("lead_tasks").update({ due_at: newStartIso }).eq("mission_id", mission_id);
}

/** Reverse bridge: a bridged Mission cancelled/deleted in the Missions tab unlinks the
 * lead_task + clears its date (the task stays on the lead, just off the calendar). */
export async function detachTaskByMission(mission_id: string): Promise<void> {
  const db = serviceClient();
  await db.from("lead_tasks").update({ mission_id: null, due_at: null, remind_at: null }).eq("mission_id", mission_id);
}
