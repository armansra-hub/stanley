import { describe, it, expect } from "vitest";
import { buildCalendarInvite, parseIcsEvents, parseIcsDate, formatUtc, type IcsEvent } from "./ics";

const base: IcsEvent = {
  uid: "mission-123@stanley",
  sequence: 0,
  summary: "Follow up with Acme, Inc.",
  description: "Day-2 touch",
  start: new Date(Date.UTC(2026, 6, 3, 16, 0, 0)), // 2026-07-03 16:00Z
  end: new Date(Date.UTC(2026, 6, 3, 16, 30, 0)),
  organizerEmail: "stanley@example.com",
  attendeeEmail: "arman@example.com",
  alarmMinutesBefore: 10,
};

describe("buildCalendarInvite", () => {
  it("emits a REQUEST VEVENT with stable UID, sequence, UTC times, alarm", () => {
    const ics = buildCalendarInvite(base, "REQUEST");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("UID:mission-123@stanley");
    expect(ics).toContain("SEQUENCE:0");
    expect(ics).toContain("DTSTART:20260703T160000Z");
    expect(ics).toContain("DTEND:20260703T163000Z");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("ORGANIZER;CN=Stanley:mailto:stanley@example.com");
    expect(ics).toContain("ATTENDEE");
    expect(ics).toContain("TRIGGER:-PT10M");
    expect(ics).toContain("BEGIN:VALARM");
    // RFC 5545 line endings
    expect(ics).toContain("\r\n");
  });

  it("escapes commas/semicolons in TEXT values", () => {
    const ics = buildCalendarInvite(base, "REQUEST");
    expect(ics).toContain("SUMMARY:Follow up with Acme\\, Inc.");
  });

  it("CANCEL sets METHOD/STATUS cancelled and drops the alarm", () => {
    const ics = buildCalendarInvite({ ...base, sequence: 1 }, "CANCEL");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SEQUENCE:1");
    expect(ics).not.toContain("BEGIN:VALARM");
  });

  it("all-day uses VALUE=DATE", () => {
    const ics = buildCalendarInvite({ ...base, allDay: true }, "REQUEST");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260703");
    expect(ics).toContain("DTEND;VALUE=DATE:20260703");
  });

  it("omits the alarm when alarmMinutesBefore is null", () => {
    const ics = buildCalendarInvite({ ...base, alarmMinutesBefore: null }, "REQUEST");
    expect(ics).not.toContain("BEGIN:VALARM");
  });
});

describe("parseIcsDate", () => {
  it("parses UTC datetimes", () => {
    const { date, allDay } = parseIcsDate("20260703T160000Z");
    expect(allDay).toBe(false);
    expect(date?.toISOString()).toBe("2026-07-03T16:00:00.000Z");
  });
  it("parses date-only as all-day", () => {
    const { date, allDay } = parseIcsDate("20260703");
    expect(allDay).toBe(true);
    expect(date?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });
});

describe("parseIcsEvents", () => {
  it("round-trips an invite we built", () => {
    const ics = buildCalendarInvite(base, "REQUEST");
    const [ev] = parseIcsEvents(ics);
    expect(ev.uid).toBe("mission-123@stanley");
    expect(ev.summary).toBe("Follow up with Acme, Inc.");
    expect(ev.start?.toISOString()).toBe(base.start.toISOString());
    expect(ev.end?.toISOString()).toBe(base.end.toISOString());
  });

  it("reads multiple VEVENTs and respects TRANSP:TRANSPARENT (free)", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a@out",
      "SUMMARY:Busy meeting",
      "DTSTART:20260703T150000Z",
      "DTEND:20260703T160000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b@out",
      "SUMMARY:Free hold",
      "TRANSP:TRANSPARENT",
      "DTSTART:20260703T170000Z",
      "DTEND:20260703T173000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const evs = parseIcsEvents(feed);
    expect(evs).toHaveLength(2);
    expect(evs[0].transparent).toBe(false);
    expect(evs[1].transparent).toBe(true);
    expect(evs[0].start?.toISOString()).toBe("2026-07-03T15:00:00.000Z");
  });

  it("unfolds continuation lines", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:c@out",
      "SUMMARY:A very long summary that has been folded across",
      "  two physical lines",
      "DTSTART:20260703T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [ev] = parseIcsEvents(feed);
    expect(ev.summary).toBe("A very long summary that has been folded across two physical lines");
  });
});

describe("formatUtc", () => {
  it("formats to YYYYMMDDTHHMMSSZ", () => {
    expect(formatUtc(new Date(Date.UTC(2026, 0, 5, 9, 7, 3)))).toBe("20260105T090703Z");
  });
});
