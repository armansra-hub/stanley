import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { setCompaniesStatus } from "@/lib/db/companies";

type StatusDecision = "new" | "reviewed" | "dismissed";
export interface StatusEventLike { ts: string; meta?: Record<string, unknown> | null }

/** Reconstruct each company's latest explicit human worklist decision. */
export function latestHumanStatusByCompany(events: StatusEventLike[]): Map<string, StatusDecision> {
  const latest = new Map<string, StatusDecision>();
  const ordered = [...events].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  for (const event of ordered) {
    const status = event.meta?.status;
    if (status !== "new" && status !== "reviewed" && status !== "dismissed") continue;
    const ids = Array.isArray(event.meta?.ids) ? event.meta.ids : [];
    for (const rawId of ids) {
      const id = String(rawId ?? "").trim();
      if (id && !latest.has(id)) latest.set(id, status);
    }
  }
  return latest;
}

export async function reconcileHumanHiddenStatuses(opts: { dryRun?: boolean } = {}) {
  const db = serviceClient();
  const events: StatusEventLike[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("app_events")
      .select("ts,meta")
      .eq("module", "headhunter")
      .eq("kind", "lead.status_changed")
      .order("ts", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(`status log read failed: ${error.message}`);
    events.push(...((data ?? []) as StatusEventLike[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  const latest = latestHumanStatusByCompany(events);
  const desired = [...latest.entries()].filter(([, status]) => status === "reviewed" || status === "dismissed");
  const current: { id: string; name: string; netsuite_internal_id: string | null; status: string }[] = [];
  const ids = desired.map(([id]) => id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from("companies").select("id,name,netsuite_internal_id,status").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`company status read failed: ${error.message}`);
    current.push(...((data ?? []) as { id: string; name: string; netsuite_internal_id: string | null; status: string }[]));
  }
  const currentById = new Map(current.map((row) => [String(row.id), String(row.status)]));
  const restoreReviewed: string[] = [], restoreDismissed: string[] = [];
  for (const [id, status] of desired) {
    // Signal resurfacing writes `new`. Preserve exports, TAM removal, and other
    // hidden states that were set through separate workflows.
    if (currentById.get(id) !== "new") continue;
    if (status === "reviewed") restoreReviewed.push(id);
    else restoreDismissed.push(id);
  }
  if (!opts.dryRun) {
    await setCompaniesStatus(restoreReviewed, "reviewed");
    await setCompaniesStatus(restoreDismissed, "dismissed");
  }
  const restoredIds = new Set([...restoreReviewed, ...restoreDismissed]);
  const candidates = current.filter((row) => restoredIds.has(row.id)).map((row) => ({
    id: row.id,
    name: row.name,
    netsuiteInternalId: row.netsuite_internal_id,
    from: row.status,
    to: latest.get(row.id),
  }));
  const result = {
    eventsRead: events.length,
    accountsWithExplicitStatus: latest.size,
    latestHiddenDecisions: desired.length,
    reviewedRestored: restoreReviewed.length,
    dismissedRestored: restoreDismissed.length,
    restored: restoreReviewed.length + restoreDismissed.length,
    dryRun: opts.dryRun === true,
    candidates,
  };
  if (!opts.dryRun) {
    await logEvent("system", "hidden-policy.reconciled", {
      summary: `Restored ${result.restored} human-reviewed/dismissed leads to hidden status`,
      entity_type: "companies",
      meta: { ...result, candidates: candidates.slice(0, 100) },
    });
  }
  return result;
}
