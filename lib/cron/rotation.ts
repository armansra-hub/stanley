/** Pure helpers shared by the daily manifest and durable source cursors. */

export function utcDayIndex(now = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/**
 * Pick a deterministic, wrapping window. Advancing `step` eventually exposes every
 * item, including when `count` is smaller than the source list.
 */
export function rotatingWindow<T>(items: readonly T[], step: number, count: number): T[] {
  if (!Number.isInteger(step) || step < 0) throw new Error("rotation step must be a non-negative integer");
  if (!Number.isInteger(count) || count < 0) throw new Error("rotation count must be a non-negative integer");
  if (items.length === 0 || count === 0) return [];
  const take = Math.min(count, items.length);
  const start = (step * take) % items.length;
  return Array.from({ length: take }, (_, index) => items[(start + index) % items.length]);
}

export interface CursorAdvance {
  currentOffset: number;
  checked: number;
  batchSize: number;
  done: boolean;
  reportedNextOffset?: number;
}

/**
 * Advance a persisted offset only by observed work. A source-confirmed end-of-list
 * wraps to zero; empty non-final results retain the cursor so a transient source
 * failure cannot silently skip records.
 */
export function advanceCursorOffset(input: CursorAdvance): number {
  const current = Math.max(0, Math.trunc(input.currentOffset));
  const checked = Math.max(0, Math.trunc(input.checked));
  if (input.done) return 0;
  if (checked === 0) return current;
  const reported = input.reportedNextOffset;
  return reported != null && Number.isFinite(reported) && reported > current
    ? Math.trunc(reported)
    : current + checked;
}
