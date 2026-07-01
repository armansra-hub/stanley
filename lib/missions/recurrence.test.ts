import { describe, it, expect } from "vitest";
import { buildRRule, expandOccurrences, nextOccurrence } from "./recurrence";

describe("buildRRule", () => {
  it("weekdays → weekly MO–FR", () => {
    expect(buildRRule({ freq: "weekdays" })).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });
  it("daily with interval", () => {
    expect(buildRRule({ freq: "daily", interval: 2 })).toBe("RRULE:FREQ=DAILY;INTERVAL=2");
  });
  it("weekly on Mon/Wed (0,2)", () => {
    expect(buildRRule({ freq: "weekly", byweekday: [0, 2] })).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
  });
  it("monthly", () => {
    expect(buildRRule({ freq: "monthly" })).toBe("RRULE:FREQ=MONTHLY");
  });
  it("honors count", () => {
    expect(buildRRule({ freq: "daily", count: 3 })).toBe("RRULE:FREQ=DAILY;COUNT=3");
  });
});

describe("expandOccurrences", () => {
  it("expands weekdays to 5 occurrences across a work week", () => {
    const rule = buildRRule({ freq: "weekdays" });
    const dtstart = new Date(Date.UTC(2026, 6, 6, 9, 0, 0)); // Mon 2026-07-06 09:00Z
    const occ = expandOccurrences(rule, dtstart, new Date(Date.UTC(2026, 6, 6)), new Date(Date.UTC(2026, 6, 12)));
    expect(occ).toHaveLength(5); // Mon–Fri
    expect(occ[0].getUTCDay()).toBe(1); // Monday
    expect(occ[4].getUTCDay()).toBe(5); // Friday
  });

  it("empty rule → no occurrences", () => {
    expect(expandOccurrences("", new Date(), new Date(), new Date())).toEqual([]);
  });
});

describe("nextOccurrence", () => {
  it("finds the next daily occurrence on/after a date", () => {
    const rule = buildRRule({ freq: "daily" });
    const dtstart = new Date(Date.UTC(2026, 6, 1, 9, 0, 0));
    const next = nextOccurrence(rule, dtstart, new Date(Date.UTC(2026, 6, 5, 0, 0, 0)));
    expect(next?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
  });
});
