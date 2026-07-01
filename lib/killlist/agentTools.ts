import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { listLeads, getLead, listLeadTasks, listLeadNotes } from "@/lib/db/killlist";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Stanley's Kill List toolbelt. Reads run freely; most writes apply immediately;
 * only destructive deletes (delete_lead, delete_task) hold for confirmation.
 * Jarvis NEVER invents data here — it only records what the user dictates. */
export const TOOLS: Anthropic.Tool[] = [
  // ── reads ──
  { name: "list_leads", description: "List pipeline leads (id, name, stage, open-task count) to find a lead before acting or to answer 'what's in Opportunities'.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_lead", description: "Full detail for one lead: description, recent notes, and open tasks (with ids).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_lead_tasks", description: "List a lead's tasks (id, title, due, status) — use to find a task id before completing/editing.", input_schema: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"] } },
  // ── writes ──
  { name: "create_lead", description: "Add a lead to the board. Only fields the user gave — never invent a description or website.", input_schema: { type: "object", properties: { name: { type: "string" }, website: { type: ["string", "null"] }, description: { type: ["string", "null"] }, netsuite_url: { type: ["string", "null"] }, stage_name: { type: ["string", "null"], description: "stage column; defaults to the first stage" } }, required: ["name"] } },
  { name: "update_lead", description: "Edit a lead's name / website / description / NetSuite URL. Only the fields that change.", input_schema: { type: "object", properties: { id: { type: "string" }, name: { type: ["string", "null"] }, website: { type: ["string", "null"] }, description: { type: ["string", "null"] }, netsuite_url: { type: ["string", "null"] } }, required: ["id"] } },
  { name: "move_lead_stage", description: "Move a lead to another stage column.", input_schema: { type: "object", properties: { id: { type: "string" }, stage_name: { type: "string" } }, required: ["id", "stage_name"] } },
  { name: "add_note", description: "Append a timestamped activity-log entry to a lead (what happened). Record only what the user says.", input_schema: { type: "object", properties: { lead_id: { type: "string" }, text: { type: "string" } }, required: ["lead_id", "text"] } },
  { name: "add_task", description: "Add a to-do to a lead. If it has a due date it ALSO becomes a Missions item + calendar invite — tell the user. block_time=false (default) pins a reminder at that exact time; block_time=true reserves a work block that auto-fits around the user's meetings.", input_schema: { type: "object", properties: { lead_id: { type: "string" }, title: { type: "string" }, notes: { type: ["string", "null"] }, local_due: { type: ["string", "null"], description: "naive local 'YYYY-MM-DDTHH:MM' or null" }, local_remind: { type: ["string", "null"], description: "when to be reminded, naive local 'YYYY-MM-DDTHH:MM' or null" }, block_time: { type: "boolean", description: "true = reserve a work block (auto-fit around meetings); false = pinned reminder at the exact time" } }, required: ["lead_id", "title"] } },
  { name: "edit_task", description: "Change a task's title / notes / due / reminder / block-vs-reminder. Editing the date updates its calendar invite; clearing it removes the invite.", input_schema: { type: "object", properties: { id: { type: "string" }, title: { type: ["string", "null"] }, notes: { type: ["string", "null"] }, local_due: { type: ["string", "null"] }, local_remind: { type: ["string", "null"] }, block_time: { type: ["boolean", "null"] } }, required: ["id"] } },
  { name: "complete_task", description: "Mark a task done (also completes its linked Mission).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_task", description: "Permanently delete a task (and cancel its calendar invite).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_lead", description: "Permanently delete a lead and all its notes + tasks.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_stage", description: "Add a new pipeline stage (column).", input_schema: { type: "object", properties: { name: { type: "string" }, color: { type: ["string", "null"] } }, required: ["name"] } },
  { name: "rename_stage", description: "Rename a pipeline stage.", input_schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] } },
  { name: "reorder_stages", description: "Set the left→right order of stages by id.", input_schema: { type: "object", properties: { ordered_ids: { type: "array", items: { type: "string" } } }, required: ["ordered_ids"] } },
];

export const WRITE_TOOLS = new Set([
  "create_lead", "update_lead", "move_lead_stage", "add_note", "add_task", "edit_task",
  "complete_task", "delete_task", "delete_lead", "add_stage", "rename_stage", "reorder_stages",
]);
export const isWriteTool = (name: string) => WRITE_TOOLS.has(name);

/** Only destructive deletes are held for confirmation; everything else applies now. */
export const CONFIRM_TOOLS = new Set(["delete_lead", "delete_task"]);
export const needsConfirm = (name: string) => CONFIRM_TOOLS.has(name);

const fmtDay = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "no date");

// ── Read execution ────────────────────────────────────────────────────────────
export async function executeReadTool(name: string, input: any, tz: string): Promise<string> {
  if (name === "list_leads") {
    const leads = await listLeads();
    if (leads.length === 0) return "No leads on the board yet.";
    return leads.map((l) => `- id=${l.id} | ${l.name} | ${l.open_tasks ?? 0} open task(s)${l.next_due_at ? ` | next ${fmtDay(l.next_due_at, tz)}` : ""}`).join("\n");
  }
  if (name === "get_lead") {
    const lead = await getLead(input.id);
    if (!lead) return "No such lead.";
    const [notes, tasks] = await Promise.all([listLeadNotes(input.id), listLeadTasks(input.id)]);
    const noteLines = notes.slice(0, 5).map((n) => `  • ${n.body}`).join("\n");
    const taskLines = tasks.filter((t) => t.status === "open").map((t) => `  • id=${t.id} | ${t.title} | ${fmtDay(t.due_at, tz)}`).join("\n");
    return `${lead.name}\nWhat they do: ${lead.description ?? "—"}\nNetSuite: ${lead.netsuite_url ?? "—"}\nRecent notes:\n${noteLines || "  (none)"}\nOpen tasks:\n${taskLines || "  (none)"}`;
  }
  if (name === "list_lead_tasks") {
    const tasks = await listLeadTasks(input.lead_id);
    if (tasks.length === 0) return "No tasks for this lead.";
    return tasks.map((t) => `- id=${t.id} | ${t.title} | ${fmtDay(t.due_at, tz)} | ${t.status}`).join("\n");
  }
  return `Unknown read tool: ${name}`;
}

// ── Human description for the confirm card (deletes only) ────────────────────────
export async function describeAction(name: string, input: any): Promise<string> {
  switch (name) {
    case "delete_lead": { const l = await getLead(input.id); return `Delete lead “${l?.name ?? input.id}” and all its notes + tasks`; }
    case "delete_task": return `Delete a task (and cancel its calendar invite)`;
    default: return name;
  }
}
