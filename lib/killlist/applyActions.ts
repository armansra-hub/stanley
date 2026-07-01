import "server-only";
import {
  createLead, updateLead, moveLeadStage, deleteLead, addNote, addTask, editTask,
  completeTask, deleteTask, addStage, renameStage, reorderStages, listStages, listLeads,
} from "@/lib/db/killlist";
import { wallClockToUtc } from "@/lib/missions/timeutil";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Action { name: string; input: any }

const toUtc = (local: string | null | undefined, tz: string): string | null => {
  if (local === undefined) return undefined as any; // "not provided" — caller skips the field
  if (local === null || local === "") return null;
  const d = wallClockToUtc(local, tz);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Resolve a stage name (loose/forgiving) to a stage id; null if no match. */
async function stageIdByName(name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const stages = await listStages();
  const q = name.toLowerCase();
  return (stages.find((s) => s.name.toLowerCase() === q) ?? stages.find((s) => s.name.toLowerCase().includes(q)))?.id ?? null;
}

/** Apply a confirmed (or auto-applied) batch of Kill List writes. */
export async function applyKillActions(actions: Action[], tz: string): Promise<{ results: string[]; changed: boolean }> {
  const results: string[] = [];
  let changed = false;
  for (const a of actions) {
    try {
      const i = a.input ?? {};
      switch (a.name) {
        case "create_lead": {
          const lead = await createLead({ name: i.name, website: i.website ?? null, description: i.description ?? null, netsuite_url: i.netsuite_url ?? null, stage_id: await stageIdByName(i.stage_name) });
          results.push(`Added “${lead.name}”`); changed = true; break;
        }
        case "update_lead": {
          const patch: any = {};
          for (const k of ["name", "website", "description", "netsuite_url"]) if (i[k] !== undefined) patch[k] = i[k];
          await updateLead(i.id, patch); results.push("Lead updated"); changed = true; break;
        }
        case "move_lead_stage": {
          const sid = await stageIdByName(i.stage_name);
          if (!sid) { results.push(`No stage matches “${i.stage_name}”`); break; }
          await moveLeadStage(i.id, sid); results.push(`Moved to ${i.stage_name}`); changed = true; break;
        }
        case "add_note": { await addNote(i.lead_id, i.text, "chatbot"); results.push("Note logged"); changed = true; break; }
        case "add_task": {
          await addTask({ lead_id: i.lead_id, title: i.title, notes: i.notes ?? null, due_at: toUtc(i.local_due, tz), remind_at: toUtc(i.local_remind, tz), block_time: !!i.block_time });
          results.push(i.local_due ? (i.block_time ? "Task added + time blocked on your calendar" : "Task added + calendar reminder set") : "Task added"); changed = true; break;
        }
        case "edit_task": {
          const patch: any = {};
          if (i.title !== undefined) patch.title = i.title;
          if (i.notes !== undefined) patch.notes = i.notes;
          if (i.local_due !== undefined) patch.due_at = toUtc(i.local_due, tz);
          if (i.local_remind !== undefined) patch.remind_at = toUtc(i.local_remind, tz);
          if (i.block_time !== undefined) patch.block_time = i.block_time;
          await editTask(i.id, patch); results.push("Task updated"); changed = true; break;
        }
        case "complete_task": { await completeTask(i.id); results.push("Task done"); changed = true; break; }
        case "delete_task": { await deleteTask(i.id); results.push("Task deleted"); changed = true; break; }
        case "delete_lead": { await deleteLead(i.id); results.push("Lead deleted"); changed = true; break; }
        case "add_stage": { await addStage(i.name, i.color ?? null); results.push(`Stage “${i.name}” added`); changed = true; break; }
        case "rename_stage": { await renameStage(i.id, i.name); results.push("Stage renamed"); changed = true; break; }
        case "reorder_stages": { await reorderStages(i.ordered_ids ?? []); results.push("Stages reordered"); changed = true; break; }
        default: results.push(`(skipped ${a.name})`);
      }
    } catch (e) {
      results.push(`Failed ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results, changed };
}

/** A compact board snapshot for the agent's system prompt (stages + lead ids). */
export async function boardContext(): Promise<string> {
  const [stages, leads] = await Promise.all([listStages(), listLeads()]);
  const stageNames = stages.map((s) => s.name).join(", ");
  const leadLines = leads.map((l) => {
    const stage = stages.find((s) => s.id === l.stage_id)?.name ?? "—";
    return `  id=${l.id} | ${l.name} | ${stage} | ${l.open_tasks ?? 0} open task(s)`;
  });
  return `Stages (left→right): ${stageNames}\nLeads:\n${leadLines.join("\n") || "  (none yet)"}`;
}
