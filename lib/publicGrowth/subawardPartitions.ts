/** Subaward search uses sub_action_date for both inclusive time-period bounds.
 * Do not reuse these partitions for prime awards, whose default bounds differ. */
export interface SubawardSearchWindow { startDate: string; endDate: string }

export const SUBAWARD_HISTORY_START = "2007-10-01";
export const SUBAWARD_SEARCH_PAGE_SIZE = 100;
/** Local work budget, not a claim about the provider's deployed result limit. */
export const SUBAWARD_PARTITION_PAGE_BUDGET = 100;
const DAY_MS = 86_400_000;
const MAX_WINDOWS = 16_384;

export function subawardDateMillis(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be an ISO date`);
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a valid ISO date`);
  return millis;
}

export function parseSubawardPartitions(row: Record<string, unknown>, searchEndDate: string, label: string): {
  searchWindows?: SubawardSearchWindow[]; searchWindowIndex?: number;
} {
  if (row.searchWindows === undefined && row.searchWindowIndex === undefined) return {};
  if (!Array.isArray(row.searchWindows) || !row.searchWindows.length || row.searchWindows.length > MAX_WINDOWS) throw new Error(`${label} has invalid search windows`);
  let nextStart = subawardDateMillis(SUBAWARD_HISTORY_START, label);
  const searchWindows = row.searchWindows.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} has invalid search window`);
    const window = value as Record<string, unknown>;
    const start = subawardDateMillis(window.startDate, `${label}.window.startDate`);
    const end = subawardDateMillis(window.endDate, `${label}.window.endDate`);
    if (start !== nextStart || end < start) throw new Error(`${label} search windows must be contiguous and nonoverlapping`);
    nextStart = end + DAY_MS;
    return { startDate: window.startDate as string, endDate: window.endDate as string };
  });
  if (searchWindows[searchWindows.length - 1].endDate !== searchEndDate) throw new Error(`${label} search windows must preserve the frozen date scope`);
  const searchWindowIndex = row.searchWindowIndex;
  if (typeof searchWindowIndex !== "number" || !Number.isInteger(searchWindowIndex) || searchWindowIndex < 0 || searchWindowIndex >= searchWindows.length) throw new Error(`${label} has invalid search window index`);
  return { searchWindows, searchWindowIndex };
}

interface PartitionCursor {
  searchEndDate: string;
  searchPage: number;
  searchPassFoundNew: boolean;
  searchWindows?: SubawardSearchWindow[];
  searchWindowIndex?: number;
}

export function currentSubawardWindow(state: PartitionCursor): SubawardSearchWindow {
  return state.searchWindows?.[state.searchWindowIndex ?? 0] ?? { startDate: SUBAWARD_HISTORY_START, endDate: state.searchEndDate };
}

/** Split only the current scope. Completed windows and globally seen IDs survive. */
export function splitSubawardWindow(state: PartitionCursor, reason: "local_page_budget" | "provider_result_window"): void {
  const window = currentSubawardWindow(state);
  const start = subawardDateMillis(window.startDate, "subaward window start");
  const end = subawardDateMillis(window.endDate, "subaward window end");
  if (start === end) throw new Error(`subaward history remains partial: same-day ${reason} at ${window.startDate}; sequential provider cursor or source export required`);
  if ((state.searchWindows?.length ?? 1) >= MAX_WINDOWS) throw new Error("subaward history remains partial: supported date-partition bound reached");
  const midpoint = start + Math.floor((end - start) / DAY_MS / 2) * DAY_MS;
  const windows = state.searchWindows ? [...state.searchWindows] : [window];
  const index = state.searchWindowIndex ?? 0;
  windows.splice(index, 1,
    { startDate: window.startDate, endDate: new Date(midpoint).toISOString().slice(0, 10) },
    { startDate: new Date(midpoint + DAY_MS).toISOString().slice(0, 10), endDate: window.endDate });
  state.searchWindows = windows;
  state.searchWindowIndex = index;
  state.searchPage = 1;
  state.searchPassFoundNew = false;
}

/** Only the provider's explicit result-window error justifies automatic splitting. */
export function isSubawardResultWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^422\b/.test(message) && /Page #\d+ with limit \d+ is over the maximum result limit \d+/i.test(message)
    && /last_record_sort_value/.test(message) && /last_record_unique_id/.test(message);
}
