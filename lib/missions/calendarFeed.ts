import "server-only";
import { parseIcsEvents } from "./ics";
import { expandOccurrences } from "./recurrence";
import type { BusyBlock } from "./types";

const clamp = (d: Date, lo: Date, hi: Date) => (d < lo ? lo : d > hi ? hi : d);

/**
 * Read the user's published Outlook calendar (read-only ICS feed) into BUSY blocks
 * for a day. Titles are deliberately ignored — we only surface "Busy" (the feed
 * may be availability-only, and the user only wants busy/free anyway). Expands
 * recurring meetings into the day's instances. Returns [] when no feed is set.
 */
export async function fetchBusyForRange(icsUrl: string | null | undefined, rangeStart: Date, rangeEnd: Date, tz = "America/Los_Angeles"): Promise<BusyBlock[]> {
  if (!icsUrl) return [];
  try {
    const res = await fetch(icsUrl, { cache: "no-store" });
    if (!res.ok) return [];
    const text = await res.text();
    const events = parseIcsEvents(text, tz);
    const blocks: BusyBlock[] = [];
    for (const ev of events) {
      if (ev.transparent || !ev.start) continue; // free / undated
      const durMs = ev.end ? Math.max(0, ev.end.getTime() - ev.start.getTime()) : 30 * 60_000;
      const starts = ev.rrule ? expandOccurrences(ev.rrule, ev.start, rangeStart, rangeEnd) : [ev.start];
      for (const s of starts) {
        const e = new Date(s.getTime() + durMs);
        if (e <= rangeStart || s >= rangeEnd) continue; // no overlap with the range
        blocks.push({
          id: `${ev.uid ?? "ics"}-${s.getTime()}`,
          external_uid: ev.uid,
          title: "Busy",
          start: clamp(s, rangeStart, rangeEnd).toISOString(),
          end: clamp(e, rangeStart, rangeEnd).toISOString(),
          busy: true,
        });
      }
    }
    return blocks.sort((a, b) => a.start.localeCompare(b.start));
  } catch {
    return [];
  }
}
