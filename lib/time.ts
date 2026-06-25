/**
 * App-wide time authority. One place that knows "what time is it now" and the
 * recency rules everything else relies on. The prospecting bot — and the
 * Missions calendar we'll build on top of this later — should read time ONLY
 * from here, never `new Date()` scattered across the code.
 *
 * Rules (2026-06-25):
 *  - Signals/news/job posts MUST be dated 2026-01-01 or later (MIN_SIGNAL_DATE).
 *    Anything older is stale and gets dropped at ingest.
 *  - More recent signals are worth more (recencyMultiplier) so the freshest
 *    buying intent floats to the top.
 */

/** Hard floor: ignore anything before this date. Bump as the year turns. */
export const MIN_SIGNAL_DATE = "2026-01-01T00:00:00.000Z";
const MIN_SIGNAL_MS = Date.parse(MIN_SIGNAL_DATE);

/** Display timezone (the AE's territory skews US-West). Override via env. */
export const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Los_Angeles";

/** Authoritative current instant. */
export function now(): Date {
  return new Date();
}
export function nowMs(): number {
  return Date.now();
}
export function nowISO(): string {
  return new Date().toISOString();
}

/** Today as YYYY-MM-DD in the app timezone (for the prompt + calendar later). */
export function todayISO(tz: string = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Human current date+time, e.g. "Jun 25, 2026, 9:41 AM PDT". */
export function formatNow(tz: string = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date());
}

/**
 * Best-effort parse of the many date shapes sources hand us (ISO strings, RSS
 * pubDate, epoch seconds/millis, "2026-03-04", "3 days ago" → null). Returns an
 * ISO string or null when we genuinely can't tell.
 */
export function parseDateLoose(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs millis
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
    return null; // relative phrases like "3 days ago" — unknown, treat as undated
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

/** Is this date on/after the 2026 floor? Unknown dates (null) pass — we don't
 * punish a real signal just because the source omitted a timestamp. */
export function isOnOrAfterMinDate(dateISO: string | null | undefined): boolean {
  if (!dateISO) return true;
  const t = Date.parse(dateISO);
  if (Number.isNaN(t)) return true;
  return t >= MIN_SIGNAL_MS;
}

/** Recency weight for scoring. Fresh = full value; decays with age. Undated
 * signals are treated as full value (no penalty). */
export function recencyMultiplier(dateISO: string | null | undefined, ref: number = Date.now()): number {
  if (!dateISO) return 1;
  const t = Date.parse(dateISO);
  if (Number.isNaN(t)) return 1;
  const days = (ref - t) / 86_400_000;
  if (days <= 30) return 1;     // last month — hottest
  if (days <= 90) return 0.85;  // this quarter
  if (days <= 180) return 0.7;  // first half of the year
  return 0.55;                  // older (still ≥2026, just cooler)
}
