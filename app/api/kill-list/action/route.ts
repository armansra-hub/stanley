import { NextRequest, NextResponse } from "next/server";
import {
  listStages, listLeads, listLeadNotes, listLeadTasks,
  createLead, updateLead, moveLeadStage, deleteLead, addNote,
  addTask, editTask, completeTask, deleteTask, addStage, renameStage, reorderStages, archiveStage,
} from "@/lib/db/killlist";
import { getPrefs } from "@/lib/db/missions";
import { wallClockToUtc } from "@/lib/missions/timeutil";

export const maxDuration = 60;

/** Direct board writes (drag, buttons, drawer edits). Returns the refreshed board
 * + the affected lead's notes/tasks so the UI can update in place. */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const kind = body?.kind;
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });

  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }
  const toUtc = (local: string | null | undefined): string | null | undefined => {
    if (local === undefined) return undefined;
    if (!local) return null;
    const d = wallClockToUtc(local, tz);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  try {
    let leadId: string | undefined = body.lead_id ?? body.id;
    switch (kind) {
      case "create_lead": { const l = await createLead(body); leadId = l.id; break; }
      case "update_lead": await updateLead(body.id, body.patch ?? {}); break;
      case "move_lead_stage": await moveLeadStage(body.id, body.stage_id, body.sort_in_stage); break;
      case "delete_lead": await deleteLead(body.id); leadId = undefined; break;
      case "add_note": await addNote(body.lead_id, body.body, "manual"); break;
      case "add_task": await addTask({ lead_id: body.lead_id, title: body.title, notes: body.notes ?? null, due_at: toUtc(body.local_due), remind_at: toUtc(body.local_remind), block_time: !!body.block_time }); break;
      case "edit_task": {
        const patch: any = {};
        if (body.title !== undefined) patch.title = body.title;
        if (body.notes !== undefined) patch.notes = body.notes;
        if (body.local_due !== undefined) patch.due_at = toUtc(body.local_due);
        if (body.local_remind !== undefined) patch.remind_at = toUtc(body.local_remind);
        if (body.block_time !== undefined) patch.block_time = body.block_time;
        await editTask(body.id, patch); break;
      }
      case "complete_task": await completeTask(body.id, body.done ?? true); break;
      case "delete_task": await deleteTask(body.id); break;
      case "add_stage": await addStage(body.name, body.color ?? null); break;
      case "rename_stage": await renameStage(body.id, body.name); break;
      case "reorder_stages": await reorderStages(body.ordered_ids ?? []); break;
      case "archive_stage": await archiveStage(body.id); break;
      default: return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 });
    }

    const [stages, leads] = await Promise.all([listStages(), listLeads()]);
    const detail = leadId ? { notes: await listLeadNotes(leadId), tasks: await listLeadTasks(leadId), lead_id: leadId } : null;
    return NextResponse.json({ ok: true, stages, leads, detail });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
