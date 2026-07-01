import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { listMissions, getMission, getPrefs, getBusyInRange } from "@/lib/db/missions";
import { getCompanies } from "@/lib/db/companies";
import { wallClockToUtc } from "./timeutil";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Stanley's toolbelt. Read tools run freely; write tools are PROPOSED into a plan
 * the user confirms before anything is applied (lib/missions/applyActions.ts). */
export const TOOLS: Anthropic.Tool[] = [
  // ── reads ──
  {
    name: "list_missions",
    description: "List the user's missions to find an id before acting, or to answer 'what's due / overdue / on Friday'. Returns id, title, due time, status.",
    input_schema: { type: "object", properties: { when: { type: "string", enum: ["active", "today", "overdue", "week", "done", "dismissed", "all"] } }, required: [] },
  },
  {
    name: "find_free_slots",
    description: "Find open time on a date, using the user's work hours and their real Outlook busy calendar.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD (local)" }, duration_minutes: { type: "number" } }, required: ["date", "duration_minutes"] },
  },
  {
    name: "find_company",
    description: "Search Headhunter (prospecting) companies by name to link a mission to one. Returns id + name.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  // ── writes (proposed → confirmed → applied) ──
  {
    name: "create_mission",
    description: "Create a task (time block) or reminder (point nudge).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["task", "reminder"] },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        local_due: { type: ["string", "null"], description: "naive local 'YYYY-MM-DDTHH:MM' or null" },
        duration_minutes: { type: ["number", "null"] },
        all_day: { type: "boolean" },
        recurrence_freq: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"] },
        recurrence_interval: { type: "number" },
        recurrence_byweekday: { type: "array", items: { type: "number" }, description: "0=Mon..6=Sun" },
        notes: { type: ["string", "null"] },
        link_company_id: { type: ["string", "null"], description: "Headhunter company id from find_company, or null" },
      },
      required: ["title", "kind", "priority", "local_due", "duration_minutes", "all_day", "recurrence_freq", "recurrence_interval", "recurrence_byweekday", "notes"],
    },
  },
  { name: "complete_mission", description: "Mark a mission done (recurring advances to its next occurrence).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "dismiss_mission", description: "Dismiss a mission (one-off → Dismissed; recurring → next occurrence).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_mission", description: "Permanently delete a mission.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "reschedule_mission", description: "Move a mission to a new time.", input_schema: { type: "object", properties: { id: { type: "string" }, local_start: { type: "string", description: "naive local 'YYYY-MM-DDTHH:MM'" }, duration_minutes: { type: ["number", "null"] } }, required: ["id", "local_start"] } },
  { name: "snooze_mission", description: "Push a mission's time out by N minutes.", input_schema: { type: "object", properties: { id: { type: "string" }, minutes: { type: "number" } }, required: ["id", "minutes"] } },
  {
    name: "edit_mission",
    description: "Change anything about an existing mission: title, priority, notes, its time, OR its recurrence (e.g. make it repeat Mon/Wed/Fri). Only include the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: ["string", "null"] },
        priority: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
        notes: { type: ["string", "null"] },
        local_due: { type: ["string", "null"], description: "new time as naive local 'YYYY-MM-DDTHH:MM'" },
        duration_minutes: { type: ["number", "null"] },
        recurrence_freq: { type: ["string", "null"], enum: ["none", "daily", "weekdays", "weekly", "monthly", null], description: "set recurrence; 'none' removes it; 'weekly' uses recurrence_byweekday" },
        recurrence_interval: { type: ["number", "null"] },
        recurrence_byweekday: { type: ["array", "null"], items: { type: "number" }, description: "0=Mon..6=Sun, for weekly (Mon/Wed/Fri = [0,2,4])" },
      },
      required: ["id"],
    },
  },
  { name: "plan_day", description: "Auto-fit all of a day's unscheduled tasks into the free gaps around Outlook busy, and book them.", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD (local)" } }, required: ["date"] } },
  { name: "create_cadence", description: "Create a multi-touch follow-up sequence: one reminder per step, N days out.", input_schema: { type: "object", properties: { title: { type: "string", description: "e.g. 'Follow up with Acme'" }, steps_days: { type: "array", items: { type: "number" }, description: "e.g. [2,7,30]" }, link_company_id: { type: ["string", "null"] }, notes: { type: ["string", "null"] } }, required: ["title", "steps_days"] } },
  { name: "set_prefs", description: "Update preferences.", input_schema: { type: "object", properties: { timezone: { type: ["string", "null"] }, work_start: { type: ["string", "null"], description: "HH:MM" }, work_end: { type: ["string", "null"], description: "HH:MM" }, reminder_lead_min: { type: ["number", "null"] } }, required: [] } },
];

export const WRITE_TOOLS = new Set([
  "create_mission", "complete_mission", "dismiss_mission", "delete_mission",
  "reschedule_mission", "snooze_mission", "edit_mission", "plan_day", "create_cadence", "set_prefs",
]);
export const isWriteTool = (name: string) => WRITE_TOOLS.has(name);

/** Actions that still require explicit confirmation — only destructive/irreversible
 * ones. Everything else applies immediately. */
export const CONFIRM_TOOLS = new Set(["delete_mission"]);
export const needsConfirm = (name: string) => CONFIRM_TOOLS.has(name);

const localTime = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "no time");

// ── Read execution ────────────────────────────────────────────────────────────
export async function executeReadTool(name: string, input: any, tz: string): Promise<string> {
  if (name === "list_missions") {
    const when = input.when ?? "active";
    const dateWhen = when === "today" || when === "overdue" || when === "week";
    const statusFilter = dateWhen ? "active" : when === "all" ? undefined : when;
    const all = await listMissions(statusFilter ? { status: statusFilter as any } : {});
    const now = Date.now();
    const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
    const todayK = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const filtered = all.filter((m) => {
      if (!m.due_at) return when === "active" || when === "all";
      if (when === "today") return dayKey(m.due_at) === todayK;
      if (when === "overdue") return new Date(m.due_at).getTime() < now;
      if (when === "week") return new Date(m.due_at).getTime() - now < 7 * 86400000;
      return true;
    });
    if (filtered.length === 0) return "No missions match.";
    return filtered.map((m) => `- id=${m.id} | ${m.title} | ${localTime(m.due_at, tz)} | ${m.status}${m.is_recurring ? " | recurring" : ""}`).join("\n");
  }

  if (name === "find_free_slots") {
    const prefs = await getPrefs();
    const wd = new Date(`${input.date}T12:00:00Z`).getUTCDay();
    const wh = prefs.work_hours[wd === 0 ? "7" : String(wd)] ?? { start: "08:00", end: "17:00" };
    const at = (hhmm: string) => wallClockToUtc(`${input.date}T${hhmm}`, tz).getTime();
    const ws = at(wh.start), we = at(wh.end);
    const busy = (await getBusyInRange(new Date(ws).toISOString(), new Date(we).toISOString())).map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() })).sort((a, b) => a.s - b.s);
    const gaps: { s: number; e: number }[] = [];
    let cur = ws;
    for (const b of busy) { if (b.s > cur) gaps.push({ s: cur, e: Math.min(b.s, we) }); cur = Math.max(cur, b.e); }
    if (cur < we) gaps.push({ s: cur, e: we });
    const need = (input.duration_minutes ?? 30) * 60000;
    const fit = gaps.filter((g) => g.e - g.s >= need);
    if (fit.length === 0) return `No free ${input.duration_minutes}-min slot on ${input.date}.`;
    return fit.map((g) => `${localTime(new Date(g.s).toISOString(), tz)}–${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(g.e))}`).join("\n");
  }

  if (name === "find_company") {
    const q = String(input.query ?? "").toLowerCase();
    const cos = (await getCompanies()).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
    if (cos.length === 0) return `No Headhunter company matches "${input.query}".`;
    return cos.map((c) => `- id=${c.id} | ${c.name}${c.domain ? ` (${c.domain})` : ""}`).join("\n");
  }

  return `Unknown read tool: ${name}`;
}

// ── Human description for the confirm plan ──────────────────────────────────────
export async function describeAction(name: string, input: any, tz: string): Promise<string> {
  const title = async (id: string) => (await getMission(id))?.title ?? id;
  switch (name) {
    case "create_mission": return `Create ${input.kind === "task" ? "block" : "reminder"} “${input.title}”${input.local_due ? ` — ${localTime(new Date(input.local_due).toISOString?.() ?? input.local_due, tz)}` : ""}${input.recurrence_freq && input.recurrence_freq !== "none" ? ` · ${input.recurrence_freq}` : ""}${input.link_company_id ? " · linked" : ""}`;
    case "complete_mission": return `Complete “${await title(input.id)}”`;
    case "dismiss_mission": return `Dismiss “${await title(input.id)}”`;
    case "delete_mission": return `Delete “${await title(input.id)}”`;
    case "reschedule_mission": return `Reschedule “${await title(input.id)}” → ${input.local_start}`;
    case "snooze_mission": return `Snooze “${await title(input.id)}” ${input.minutes} min`;
    case "edit_mission": {
      const bits: string[] = [];
      if (input.title != null) bits.push(`title→“${input.title}”`);
      if (input.priority != null) bits.push(`priority→${input.priority}`);
      if (input.local_due) bits.push(`time→${input.local_due}`);
      if (input.recurrence_freq != null) bits.push(input.recurrence_freq === "none" ? "stop repeating" : input.recurrence_freq === "weekly" && input.recurrence_byweekday?.length ? `repeat ${input.recurrence_byweekday.map((n: number) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][n]).join("/")}` : `repeat ${input.recurrence_freq}`);
      if (input.notes !== undefined && input.notes != null) bits.push("notes");
      return `Edit “${await title(input.id)}”: ${bits.join(", ") || "update"}`;
    }
    case "plan_day": return `Plan ${input.date} — fit tasks into free time`;
    case "create_cadence": return `Cadence “${input.title}” — day ${(input.steps_days ?? []).join(", ")}`;
    case "set_prefs": return `Update preferences`;
    default: return name;
  }
}
