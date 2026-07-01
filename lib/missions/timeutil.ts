/**
 * Wall-clock ↔ UTC conversion against an IANA timezone, so the AI can reason in
 * the user's local time ("Friday at 2pm") and we resolve it to a correct UTC
 * instant deterministically (no LLM timezone math).
 */

/** Minutes that `tz` is ahead of UTC at the given instant (handles DST). */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour === 24 ? 0 : +m.hour, +m.minute, +m.second);
  return (asUtc - instant.getTime()) / 60_000;
}

/** Interpret a naive local datetime ("YYYY-MM-DDTHH:MM") as wall-clock in `tz`,
 * returning the UTC instant. Refines once for DST boundary correctness. */
export function wallClockToUtc(localIso: string, tz: string): Date {
  const naive = new Date(localIso.length === 16 ? `${localIso}:00Z` : `${localIso}Z`);
  if (Number.isNaN(naive.getTime())) return new Date(NaN);
  const off1 = tzOffsetMinutes(naive, tz);
  let utc = new Date(naive.getTime() - off1 * 60_000);
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = new Date(naive.getTime() - off2 * 60_000);
  return utc;
}

/** Current local wall-clock string + label for the AI prompt. */
export function nowLocal(tz: string): { iso: string; pretty: string } {
  const now = new Date();
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(now).replace(" ", "T"); // sv-SE → "YYYY-MM-DD HH:MM"
  const pretty = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(now);
  return { iso, pretty };
}
