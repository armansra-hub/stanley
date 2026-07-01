import { NextRequest, NextResponse } from "next/server";
import { completeMission, dismissMission, snoozeMission, rescheduleMission } from "@/lib/db/missions";
import { reissueInvite, cancelInvite } from "@/lib/missions/sync";
import { completeTaskByMission, rescheduleTaskByMission, detachTaskByMission } from "@/lib/db/killlist";

/**
 * Act on a mission. RECURRING done/dismiss re-queues to the next occurrence (and
 * re-issues the invite so Outlook moves the event); ONE-OFF done leaves the event,
 * one-off dismiss cancels it. Snooze/reschedule push the time + re-issue.
 */
export async function POST(req: NextRequest) {
  let body: { id?: string; action?: string; minutes?: number; start?: string; end?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { id, action } = body;
  if (!id || !action) return NextResponse.json({ error: "id + action required" }, { status: 400 });

  try {
    if (action === "done") {
      const { mission, requeued } = await completeMission(id);
      if (requeued) await reissueInvite(id); // recurring → next occurrence on the calendar
      if (!requeued) await completeTaskByMission(id).catch(() => {}); // bridge: check off the lead task too
      return NextResponse.json({ mission, requeued });
    }
    if (action === "dismiss") {
      const { mission, requeued } = await dismissMission(id);
      if (requeued) await reissueInvite(id);
      else { await cancelInvite(id); await detachTaskByMission(id).catch(() => {}); } // one-off → off Outlook + unlink lead task
      return NextResponse.json({ mission, requeued });
    }
    if (action === "snooze") {
      const mission = await snoozeMission(id, Math.max(1, Number(body.minutes ?? 10)));
      await reissueInvite(id);
      if (mission?.due_at) await rescheduleTaskByMission(id, mission.due_at).catch(() => {}); // bridge: move lead task too
      return NextResponse.json({ mission, requeued: false });
    }
    if (action === "reschedule") {
      if (!body.start) return NextResponse.json({ error: "start required" }, { status: 400 });
      const mission = await rescheduleMission(id, body.start, body.end ?? null);
      await reissueInvite(id);
      await rescheduleTaskByMission(id, body.start).catch(() => {}); // bridge: move lead task too
      return NextResponse.json({ mission, requeued: false });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
