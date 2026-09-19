import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export type FederalCoverageSource = "federal-discovery" | "usaspending" | "usaspending-subawards" | "sam-entity";
export const FEDERAL_SOURCE_SCOPE: Record<FederalCoverageSource, string> = {
  "federal-discovery": "USAspending recipient discovery across contracts and IDVs; first verified award only",
  usaspending: "USAspending contract awards, IDVs and their transactions for frozen verified recipients and aliases",
  "usaspending-subawards": "USAspending reported first-tier contract subawards for verified recipients",
  "sam-entity": "Public SAM registration results for frozen legal-name, DBA, UEI and CAGE queries",
};
type Receipt = Record<string, unknown> & { companyId: string; status: string };
export function federalCoverageReceipt(source: FederalCoverageSource, receipt: Receipt, observedAt: string) {
  const partial = receipt.awardDone === false || receipt.subawardDone === false || receipt.samDone === false || receipt.status === "in_progress";
  const complete = receipt.awardDone === true || receipt.subawardDone === true || receipt.samDone === true;
  const status = receipt.status === "error" ? "failed" : receipt.status === "ambiguous" ? "ambiguous" : receipt.status === "not_linked" ? "partial"
    : partial ? "partial" : receipt.status === "no_candidate" ? "no_match" : complete || source === "federal-discovery" && receipt.status === "matched" ? "complete" : "partial";
  const continuation = (receipt.awardContinuation ?? receipt.subawardContinuation ?? receipt.continuation ?? {}) as Record<string, unknown>;
  const end = receipt.searchEndDate ?? continuation.searchEndDate;
  return { company_id: receipt.companyId, source, status, scope: FEDERAL_SOURCE_SCOPE[source],
    searched_from: source === "sam-entity" ? null : "2007-10-01",
    searched_through: typeof end === "string" ? end : null,
    last_attempted_at: observedAt,
    ...(status === "complete" || status === "no_match" ? { last_completed_at: observedAt } : {}),
    detail: { stage: typeof receipt.stage === "string" ? receipt.stage : null,
      reason: typeof receipt.reason === "string" ? receipt.reason : null,
      collection: continuation.collection ?? null, exhaustiveFederalMarket: false } };
}

export async function saveFederalCoverageReceipts(source: string, receipts: unknown[]): Promise<void> {
  if (!(source in FEDERAL_SOURCE_SCOPE)) return;
  const now = new Date().toISOString();
  // Combined runs place newer main work before earlier retry work. Keep the
  // first exact-company receipt; Postgres rejects duplicate conflict keys.
  const seen = new Set<string>();
  const rows = receipts.filter((value): value is Receipt => Boolean(value && typeof value === "object"
    && typeof (value as Receipt).companyId === "string" && typeof (value as Receipt).status === "string"))
    .filter((value) => value.status !== "no_longer_current")
    .filter((value) => { if (seen.has(value.companyId)) return false; seen.add(value.companyId); return true; })
    .map((value) => federalCoverageReceipt(source as FederalCoverageSource, value, now));
  if (!rows.length) return;
  const { error } = await serviceClient().from("company_federal_source_coverage").upsert(rows, { onConflict: "company_id,source" });
  if (error) throw new Error("federal source coverage receipt write failed");
}
