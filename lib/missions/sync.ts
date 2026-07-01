import "server-only";
import { getMission, getPrefs, markInviteSent } from "@/lib/db/missions";
import { sendMissionInvite, cancelMissionInvite, type InviteResult } from "./invite";

/**
 * Push a mission's calendar event to Outlook (or pull it). Centralizes the invite
 * lifecycle so the API routes stay thin: open/snoozed missions with a time get an
 * (updated) invite; dismissed ones get cancelled. All best-effort — never throws.
 */
export async function reissueInvite(missionId: string): Promise<InviteResult> {
  try {
    const m = await getMission(missionId);
    if (!m) return { sent: false, reason: "not found" };
    if (!m.scheduled_start && !m.due_at) return { sent: false, reason: "no time" };
    const prefs = await getPrefs();
    const r = await sendMissionInvite(m, prefs);
    if (r.sent) await markInviteSent(missionId);
    return r;
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function cancelInvite(missionId: string): Promise<InviteResult> {
  try {
    const m = await getMission(missionId);
    if (!m || !m.invite_sent_at) return { sent: false, reason: "no invite to cancel" };
    const prefs = await getPrefs();
    return await cancelMissionInvite(m, prefs);
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
