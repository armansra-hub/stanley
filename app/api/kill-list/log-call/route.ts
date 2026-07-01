import { NextRequest, NextResponse } from "next/server";
import { parseCallLog } from "@/lib/killlist/logCall";
import { addNote, addTask, listLeadNotes, listLeadTasks, listLeads } from "@/lib/db/killlist";
import { getPrefs } from "@/lib/db/missions";
import { wallClockToUtc } from "@/lib/missions/timeutil";
import { logEvent } from "@/lib/db/events";

export const maxDuration = 60;

/** Log-a-call: a spoken debrief → one activity note + extracted follow-up tasks
 * (dated tasks bridge to Missions). Body: { lead_id, transcript }. */
export async function POST(req: NextRequest) {
  let body: { lead_id?: string; transcript?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const { lead_id, transcript } = body;
  if (!lead_id || !transcript?.trim()) return NextResponse.json({ error: "lead_id + transcript required" }, { status: 400 });

  let tz = "America/Los_Angeles";
  try { tz = (await getPrefs()).timezone; } catch { /* default */ }

  try {
    const { summary, tasks } = await parseCallLog(transcript, tz);
    await addNote(lead_id, summary, "chatbot");
    for (const t of tasks) {
      const due = t.local_due ? wallClockToUtc(t.local_due, tz) : null;
      await addTask({ lead_id, title: t.title, due_at: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null, block_time: !!t.block_time });
    }
    await logEvent("killlist", "call.logged", { summary: `Logged a call — ${tasks.length} follow-up${tasks.length === 1 ? "" : "s"} extracted`, entity_type: "lead", entity_id: lead_id, meta: { taskCount: tasks.length } });
    const [leads, notes, leadTasks] = await Promise.all([listLeads(), listLeadNotes(lead_id), listLeadTasks(lead_id)]);
    return NextResponse.json({ summary, taskCount: tasks.length, leads, detail: { lead_id, notes, tasks: leadTasks } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
