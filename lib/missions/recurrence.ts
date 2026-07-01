import { RRule, rrulestr, type Options } from "rrule";

/**
 * Recurrence helpers built on the `rrule` lib. buildRRule() turns a normalized
 * intent (from the NL parser) into an RRULE string; expandOccurrences() lists the
 * concrete start times in a range (for materializing recurring missions and the
 * auto-scheduler). NOTE: rrule operates in floating/UTC time — the scheduling
 * layer resolves wall-clock times against user_prefs.timezone.
 */

export interface RecurrenceIntent {
  freq: "daily" | "weekdays" | "weekly" | "monthly";
  interval?: number;
  /** 0=Mon … 6=Sun (only for freq="weekly"). */
  byweekday?: number[];
  count?: number;
  until?: Date;
}

const WD = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];

export function buildRRule(intent: RecurrenceIntent): string {
  const opts: Partial<Options> = {}; // set freq first so toString emits FREQ first
  switch (intent.freq) {
    case "daily":
      opts.freq = RRule.DAILY;
      break;
    case "weekdays":
      opts.freq = RRule.WEEKLY;
      opts.byweekday = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR];
      break;
    case "weekly":
      opts.freq = RRule.WEEKLY;
      if (intent.byweekday?.length) opts.byweekday = intent.byweekday.map((i) => WD[((i % 7) + 7) % 7]);
      break;
    case "monthly":
      opts.freq = RRule.MONTHLY;
      break;
  }
  if (intent.interval && intent.interval > 1) opts.interval = intent.interval;
  if (intent.count && intent.count > 0) opts.count = intent.count;
  if (intent.until) opts.until = intent.until;
  return new RRule(opts).toString(); // includes the "RRULE:" prefix
}

/** Concrete start times for an RRULE within [rangeStart, rangeEnd] (inclusive). */
export function expandOccurrences(
  rruleStr: string,
  dtstart: Date,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  if (!rruleStr) return [];
  const rule = rrulestr(rruleStr, { dtstart });
  return rule.between(rangeStart, rangeEnd, true);
}

/** Next single occurrence on/after `after` (used to compute a recurring task's next due). */
export function nextOccurrence(rruleStr: string, dtstart: Date, after: Date): Date | null {
  if (!rruleStr) return null;
  const rule = rrulestr(rruleStr, { dtstart });
  return rule.after(after, true);
}
