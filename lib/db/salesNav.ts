import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Sales Navigator request bookkeeping (table from migration 0007). All ops are
 * graceful before the migration runs (no-op / empty) so the pipeline never
 * breaks. init records a pending request; the next cron fetches ready ones.
 */

export interface SalesNavRequest {
  id: string;
  search_key: string;
  request_id: string;
  status: string;
  pages_fetched: number;
  created_at: string;
}

/** Is the sales_nav_requests table present (migration 0007 run)? Guards against
 * spending the $0.50 init fee before we can persist the request_id. */
export async function salesNavTableReady(): Promise<boolean> {
  try {
    const db = serviceClient();
    const { error } = await db.from("sales_nav_requests").select("id").limit(1);
    // PGRST205 = table not in schema cache (migration not run).
    return !error;
  } catch {
    return false;
  }
}

/** Record a freshly-initialized search request. */
export async function recordSalesRequest(searchKey: string, requestId: string): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("sales_nav_requests").insert({ search_key: searchKey, request_id: requestId });
  } catch {
    /* table missing → no-op */
  }
}

/** Pending requests old enough that results are ready (default ≥10 min). */
export async function getReadySalesRequests(minAgeMinutes = 10): Promise<SalesNavRequest[]> {
  try {
    const db = serviceClient();
    const cutoff = new Date(Date.now() - minAgeMinutes * 60_000).toISOString();
    const { data } = await db
      .from("sales_nav_requests")
      .select("id, search_key, request_id, status, pages_fetched, created_at")
      .eq("status", "pending")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(20);
    return (data ?? []) as SalesNavRequest[];
  } catch {
    return [];
  }
}

export async function markSalesRequestDone(id: string, results: number, pages: number, note?: string): Promise<void> {
  try {
    const db = serviceClient();
    await db
      .from("sales_nav_requests")
      .update({ status: "done", results, pages_fetched: pages, fetched_at: new Date().toISOString(), note: note ?? null })
      .eq("id", id);
  } catch {
    /* no-op */
  }
}

export async function markSalesRequestError(id: string, note: string): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("sales_nav_requests").update({ status: "error", note, fetched_at: new Date().toISOString() }).eq("id", id);
  } catch {
    /* no-op */
  }
}

/** Has this search already been init'd within the last `hours`? (cadence guard
 * against double-spending the $0.50 init fee on the same day.) */
export async function searchInitedRecently(searchKey: string, hours = 20): Promise<boolean> {
  try {
    const db = serviceClient();
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data } = await db
      .from("sales_nav_requests")
      .select("id")
      .eq("search_key", searchKey)
      .gte("created_at", cutoff)
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false; // can't tell → allow (the cron weekday gate is the main guard)
  }
}
