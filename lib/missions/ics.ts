/**
 * iCalendar (RFC 5545) builder + parser — the email-first core of Missions.
 *
 * OUTBOUND: buildCalendarInvite() emits a VCALENDAR (METHOD:REQUEST to add/update,
 * METHOD:CANCEL to cancel) with a STABLE UID per mission. Re-sending the same UID
 * with a higher SEQUENCE makes Outlook update the event in place; CANCEL removes it.
 * Emailed as a text/calendar attachment → Outlook shows Accept/Decline.
 *
 * INBOUND: parseIcsEvents() reads a published .ics feed into busy blocks for the
 * auto-scheduler. Deterministic + dependency-free so it's unit-tested like the
 * NetSuite SQL exporter.
 */

import { wallClockToUtc } from "./timeutil";

export type IcsMethod = "REQUEST" | "CANCEL";

export interface IcsEvent {
  uid: string;
  sequence?: number;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  organizerEmail: string;
  attendeeEmail: string;
  /** Minutes-before DISPLAY alarm. null/undefined = no alarm. */
  alarmMinutesBefore?: number | null;
  location?: string;
}

const CRLF = "\r\n";

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
function escapeText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** UTC timestamp form: YYYYMMDDTHHMMSSZ. */
export function formatUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}
/** All-day date form: YYYYMMDD (in UTC). */
function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Fold a content line to ≤75 octets with CRLF + leading space (RFC 5545 §3.1). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  out.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    out.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return out.join(CRLF);
}

export function buildCalendarInvite(ev: IcsEvent, method: IcsMethod = "REQUEST"): string {
  const seq = ev.sequence ?? 0;
  const dtStart = ev.allDay ? `DTSTART;VALUE=DATE:${formatDate(ev.start)}` : `DTSTART:${formatUtc(ev.start)}`;
  const dtEnd = ev.allDay ? `DTEND;VALUE=DATE:${formatDate(ev.end)}` : `DTEND:${formatUtc(ev.end)}`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Stanley//Missions//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${formatUtc(new Date())}`,
    `SEQUENCE:${seq}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeText(ev.summary)}`,
    `ORGANIZER;CN=Stanley:mailto:${ev.organizerEmail}`,
    `ATTENDEE;CN=${escapeText(ev.attendeeEmail)};RSVP=TRUE:mailto:${ev.attendeeEmail}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);

  if (method === "REQUEST" && ev.alarmMinutesBefore != null && ev.alarmMinutesBefore >= 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(ev.summary)}`,
      `TRIGGER:-PT${Math.round(ev.alarmMinutesBefore)}M`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// ── Inbound parsing ───────────────────────────────────────────────────────────

export interface ParsedIcsEvent {
  uid: string | null;
  summary: string | null;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  status: string | null;
  /** TRANSP:TRANSPARENT means the time is FREE (don't treat as busy). */
  transparent: boolean;
  rrule: string | null;
}

/** Microsoft uses Windows timezone names in TZID; map the common ones to IANA so
 * Intl can resolve the offset. Unknown names fall back to the caller's default tz. */
const WINDOWS_TZ: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "US Mountain Standard Time": "America/Phoenix",
  "Atlantic Standard Time": "America/Halifax",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "UTC": "UTC",
};
function resolveTz(tzid: string | undefined, defaultTz: string): string {
  if (!tzid) return defaultTz;
  if (WINDOWS_TZ[tzid]) return WINDOWS_TZ[tzid];
  if (tzid.includes("/")) return tzid; // already IANA
  return defaultTz; // e.g. "Customized Time Zone"
}

/** Parse an iCalendar datetime value. Handles UTC ('Z'), all-day DATE, and naive
 * local times with a TZID (resolved via the Windows→IANA map / defaultTz). */
export function parseIcsDate(value: string, tzid?: string, defaultTz = "UTC"): { date: Date | null; allDay: boolean } {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dt) {
    const [, y, mo, d, h, mi, s, z] = dt;
    if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    // naive local → resolve against TZID / default timezone
    const tz = resolveTz(tzid, defaultTz);
    if (tz === "UTC") return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    const local = `${y}-${mo}-${d}T${h}:${mi}`;
    return { date: wallClockToUtc(local, tz), allDay: false };
  }
  return { date: null, allDay: false };
}

/** Unfold continuation lines (a line beginning with space or tab continues the prior). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Pull a parameter (e.g. TZID) out of a property's left side: "DTSTART;TZID=Pacific Standard Time". */
function param(left: string, key: string): string | undefined {
  const m = new RegExp(`;${key}=([^;]+)`, "i").exec(left);
  return m ? m[1] : undefined;
}

export function parseIcsEvents(text: string, defaultTz = "UTC"): ParsedIcsEvent[] {
  const lines = unfold(text);
  const events: ParsedIcsEvent[] = [];
  let cur: ParsedIcsEvent | null = null;
  let inEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { uid: null, summary: null, start: null, end: null, allDay: false, status: null, transparent: false, rrule: null };
      inEvent = true;
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
      inEvent = false;
      continue;
    }
    if (!cur || !inEvent) continue; // skip VTIMEZONE etc.
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const left = line.slice(0, ci);
    const value = line.slice(ci + 1);
    const name = left.split(";")[0].toUpperCase();
    if (name === "UID") cur.uid = value.trim();
    else if (name === "SUMMARY") cur.summary = unescapeText(value);
    else if (name === "STATUS") cur.status = value.trim().toUpperCase();
    else if (name === "TRANSP") { if (value.trim().toUpperCase() === "TRANSPARENT") cur.transparent = true; }
    else if (name === "X-MICROSOFT-CDO-BUSYSTATUS") { if (value.trim().toUpperCase() === "FREE") cur.transparent = true; }
    else if (name === "RRULE") cur.rrule = value.trim();
    else if (name === "DTSTART") {
      const { date, allDay } = parseIcsDate(value, param(left, "TZID"), defaultTz);
      cur.start = date;
      if (allDay) cur.allDay = true;
    } else if (name === "DTEND") {
      const { date } = parseIcsDate(value, param(left, "TZID"), defaultTz);
      cur.end = date;
    }
  }
  return events;
}
