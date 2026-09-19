/** Provider-owned search_after pair. Preserve the sort value verbatim; it is
 * not necessarily formatted like the displayed award/subaward date. */
export interface UsaspendingSearchCursor {
  lastRecordUniqueId: number;
  lastRecordSortValue: string;
}

/** undefined = legacy offset mode; null = sequential mode at its first page. */
export type UsaspendingSearchAfter = UsaspendingSearchCursor | null | undefined;
export const USASPENDING_LEGACY_PAGE_BUDGET = 100;

export function parseUsaspendingSearchAfter(value: unknown): UsaspendingSearchAfter {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid USAspending search cursor");
  const row = value as Record<string, unknown>;
  if (typeof row.lastRecordUniqueId !== "number" || !Number.isSafeInteger(row.lastRecordUniqueId) || row.lastRecordUniqueId < 1
      || typeof row.lastRecordSortValue !== "string" || !row.lastRecordSortValue.trim() || row.lastRecordSortValue.length > 2048
      || row.lastRecordSortValue === "None") throw new Error("invalid USAspending search cursor pair");
  return { lastRecordUniqueId: row.lastRecordUniqueId, lastRecordSortValue: row.lastRecordSortValue };
}

export function usaspendingCursorField(row: { searchAfter?: unknown }): { searchAfter?: UsaspendingSearchCursor | null } {
  return row.searchAfter === undefined ? {} : { searchAfter: parseUsaspendingSearchAfter(row.searchAfter) };
}

export function usaspendingCursorRequest(value: UsaspendingSearchAfter) {
  const cursor = parseUsaspendingSearchAfter(value);
  return cursor ? { last_record_unique_id: cursor.lastRecordUniqueId, last_record_sort_value: cursor.lastRecordSortValue } : {};
}

export function usaspendingNextCursor(
  metadata: Record<string, unknown>, rowCount: number, requestCursor: UsaspendingSearchAfter,
): UsaspendingSearchCursor | undefined {
  const id = metadata.last_record_unique_id, sort = metadata.last_record_sort_value;
  // The provider emits {id:null, sort:"None"} on its terminal page.
  const absent = id == null && (sort == null || sort === "None");
  if (absent) {
    if (metadata.hasNext && requestCursor !== undefined) throw new Error("USAspending sequential search omitted its next cursor; history remains partial");
    return undefined;
  }
  const next = parseUsaspendingSearchAfter({ lastRecordUniqueId: id, lastRecordSortValue: sort })!;
  if (metadata.hasNext && !rowCount) throw new Error("USAspending search cursor cannot advance from an empty page");
  if (metadata.hasNext && requestCursor && next.lastRecordUniqueId === requestCursor.lastRecordUniqueId
      && next.lastRecordSortValue === requestCursor.lastRecordSortValue) throw new Error("USAspending search cursor did not advance");
  return metadata.hasNext ? next : undefined;
}

/** Called only after all eligible IDs on this page have completed their writes. */
export function advanceUsaspendingCursor(
  state: { searchAfter?: UsaspendingSearchCursor | null }, hasNext: boolean, next?: UsaspendingSearchCursor,
): void {
  if (hasNext) {
    if (next) state.searchAfter = parseUsaspendingSearchAfter(next);
    else if (state.searchAfter !== undefined) throw new Error("USAspending sequential search omitted its next cursor; history remains partial");
  } else if (state.searchAfter !== undefined) state.searchAfter = null;
}

export function isUsaspendingResultWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^422\b/.test(message) && /Page #\d+ with limit \d+ is over the maximum result limit \d+/i.test(message)
    && /last_record_sort_value/.test(message) && /last_record_unique_id/.test(message);
}
