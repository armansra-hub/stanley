import "server-only";
import { Resend } from "resend";
import { buildCalendarInvite, type IcsEvent } from "./ics";
import type { Mission, UserPrefs } from "./types";

/**
 * The ENTIRE role of Resend: email the calendar invite so the event lands on the
 * user's Outlook (no Microsoft Graph). Outlook then does the 15-min reminder. We
 * send the .ics as a text/calendar attachment with a stable UID; re-sending with a
 * higher SEQUENCE updates the event in place, METHOD:CANCEL removes it.
 *
 * Dormant until RESEND_API_KEY + from_email + user_email exist — returns
 * { sent:false, reason } so the rest of the app works before email is wired.
 */

export interface InviteResult {
  sent: boolean;
  reason?: string;
}

function eventFromMission(m: Mission, prefs: UserPrefs): IcsEvent | null {
  const startIso = m.scheduled_start ?? m.due_at;
  if (!startIso) return null;
  const start = new Date(startIso);
  const end = m.scheduled_end
    ? new Date(m.scheduled_end)
    : new Date(start.getTime() + (m.kind === "task" ? 30 : 15) * 60_000);
  const lead = m.reminder_lead_min ?? prefs.reminder_lead_min ?? 15;
  return {
    uid: m.ics_uid,
    sequence: m.ics_sequence,
    summary: m.title,
    description: m.notes ?? undefined,
    start,
    end,
    allDay: m.all_day,
    organizerEmail: prefs.from_email!,
    attendeeEmail: prefs.user_email!,
    alarmMinutesBefore: lead,
  };
}

function creds(prefs: UserPrefs): { key: string; from: string; to: string } | null {
  const key = process.env.RESEND_API_KEY;
  const from = prefs.from_email || process.env.FROM_EMAIL;
  const to = prefs.user_email || process.env.USER_EMAIL;
  if (!key || !from || !to) return null;
  // Dormant until a VERIFIED-DOMAIN sender exists: the shared onboarding sender
  // can only reach the signup Gmail, which the user doesn't want. Scheduling is
  // in-app until a real from_email is set — then invites turn on automatically.
  if (from === "onboarding@resend.dev") return null;
  return { key, from, to };
}

async function send(prefs: UserPrefs, subjectPrefix: string, ev: IcsEvent, method: "REQUEST" | "CANCEL"): Promise<InviteResult> {
  const c = creds(prefs);
  if (!c) return { sent: false, reason: "email not configured (need RESEND_API_KEY + from_email + user_email)" };
  const ics = buildCalendarInvite({ ...ev, organizerEmail: c.from, attendeeEmail: c.to }, method);
  try {
    const resend = new Resend(c.key);
    const { error } = await resend.emails.send({
      from: `Stanley <${c.from}>`,
      to: c.to,
      subject: `${subjectPrefix} ${ev.summary}`,
      text: method === "CANCEL" ? `Cancelled: ${ev.summary}` : `Calendar invite for: ${ev.summary}. Accept to add it to your Outlook.`,
      attachments: [
        {
          filename: "invite.ics",
          content: Buffer.from(ics).toString("base64"),
          contentType: `text/calendar; method=${method}; charset=UTF-8`,
        },
      ],
    });
    if (error) return { sent: false, reason: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Email (or update) the invite for a mission. Caller bumps ics_sequence + marks invite_sent. */
export async function sendMissionInvite(m: Mission, prefs: UserPrefs): Promise<InviteResult> {
  const ev = eventFromMission(m, prefs);
  if (!ev) return { sent: false, reason: "mission has no scheduled time" };
  return send(prefs, "Invite:", ev, "REQUEST");
}

/** Email a cancellation for a mission's event (same UID, METHOD:CANCEL). */
export async function cancelMissionInvite(m: Mission, prefs: UserPrefs): Promise<InviteResult> {
  const ev = eventFromMission(m, prefs);
  if (!ev) return { sent: false, reason: "mission has no scheduled time" };
  return send(prefs, "Cancelled:", { ...ev, sequence: m.ics_sequence + 1 }, "CANCEL");
}
