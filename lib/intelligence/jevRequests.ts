import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import type { EvaluationUsage } from "./evaluation";
import { JevBudgetDeferredError, withJevDispatchPermit, type JevBudgetDeferral } from "./budget";

export type JevPurpose = "operating_catalog" | "public_interpretation" | "research_ranking" | "saved_view" | "private_tam" | "federal_identity" | "event_match" | "codex_connector";
export type JevWorkload = "initial_coverage" | "monitoring" | "manual" | "unattributed";
export type JevSpendContext = { purpose: JevPurpose; companyId?: string | null; observationId?: string | null;
  sourceKind?: string | null; workload?: JevWorkload };
type StoredEvaluation = { ok: boolean; usage: EvaluationUsage | null };
type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
type Dependencies = { rpc?: Rpc };
export type DurableJevResult<T> = { status: "complete"; evaluation: T; reused: boolean }
  | { status: "busy" } | JevBudgetDeferral;

/** Cache keys bind the exact native input and its target account. No source
 * text, identity data or private record excerpts are stored in this key. */
export function scopedJevFingerprint(fingerprint: string, context: JevSpendContext): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid Jev fingerprint");
  return createHash("sha256").update(JSON.stringify(["jev-receipt-v1", context.purpose, context.companyId ?? null, fingerprint])).digest("hex");
}

/** Public responses only. The private-TAM endpoint retains its no-response-storage contract. */
export async function durableJevRequest<T extends StoredEvaluation>(args: {
  fingerprint: string; context: JevSpendContext; execute: () => Promise<T>;
}, deps: Dependencies = {}): Promise<DurableJevResult<T>> {
  if (args.context.purpose === "private_tam") throw new Error("Private evidence cannot use the public response cache");
  const rpc = deps.rpc ?? ((name, values) => serviceClient().rpc(name, values));
  const fingerprint = scopedJevFingerprint(args.fingerprint, args.context);
  const { data, error } = await rpc("intelligence_jev_claim", {
    p_fingerprint: fingerprint, p_purpose: args.context.purpose, p_company: args.context.companyId ?? null,
    p_observation: args.context.observationId ?? null, p_source_kind: args.context.sourceKind ?? null,
    p_workload: args.context.workload ?? "unattributed",
  });
  if (error || !data || typeof data !== "object") throw new Error("Jev receipt claim unavailable");
  const claim = data as { status: string; evaluation?: T; reservationId?: string; leaseToken?: string; reused?: boolean; reason?: string; retryAt?: string | null; policyId?: string };
  if (claim.status === "busy") return { status: "busy" };
  if (claim.status === "budget_deferred") return { status: "budget_deferred", reason: claim.reason ?? "budget_unavailable",
    retryAt: claim.retryAt ?? null, ...(claim.policyId ? { policyId: claim.policyId } : {}) };
  if (!claim.reservationId) throw new Error("Invalid Jev receipt claim");
  const settle = async () => {
    try { await rpc("intelligence_jev_settle", { p_fingerprint: fingerprint, p_reservation: claim.reservationId }); }
    catch { /* Durable receipt is retried by the worker; no second model call. */ }
  };
  if (claim.status === "complete" && claim.evaluation && typeof claim.evaluation.ok === "boolean") {
    await settle();
    return { status: "complete", evaluation: claim.evaluation, reused: true };
  }
  if (claim.status !== "execute" || !claim.leaseToken) throw new Error("Invalid Jev receipt claim");
  // If execution itself throws, preserve the unknown-usage reservation. The
  // expiring lease permits one separately accounted recovery, not a blind loop.
  let evaluation: T;
  try {
    evaluation = await withJevDispatchPermit({ fingerprint, rawFingerprint: args.fingerprint,
      reservationId: claim.reservationId, leaseToken: claim.leaseToken, rpc }, args.execute);
  } catch (error) {
    if (!(error instanceof JevBudgetDeferredError)) throw error;
    // No provider HTTP attempt occurred. Unlike an accepted timeout, this is
    // proof of zero usage; failed bookkeeping conservatively retains the hold.
    try { await rpc("intelligence_settle", { p_id: claim.reservationId, p_actual: 0, p_tokens: 0 }); } catch { /* Retain hold. */ }
    return error.decision;
  }
  const receiptArgs = { p_fingerprint: fingerprint, p_lease: claim.leaseToken,
    p_reservation: claim.reservationId, p_evaluation: evaluation };
  const save = async () => {
    try { return await rpc("intelligence_jev_record", receiptArgs); }
    catch { return { data: null, error: true }; }
  };
  let saved = await save();
  // This is a bounded idempotent database retry of the same received response,
  // never a retry of the paid inference.
  if (saved.error || saved.data !== true) saved = await save();
  if (saved.error || saved.data !== true) throw new Error("Jev paid answer could not be checkpointed");
  await settle();
  return { status: "complete", evaluation, reused: false };
}

/** Recover bookkeeping only. Results remain readable even while accounting is unavailable. */
export async function reconcileJevReceipts(limit = 24): Promise<void> {
  const db = serviceClient();
  const { data, error } = await db.from("intelligence_jev_requests").select("fingerprint,reservation_id")
    .not("completed_at", "is", null).is("settled_at", null).order("completed_at").limit(Math.max(1, Math.min(48, limit)));
  if (error || !data?.length) return;
  await Promise.allSettled(data.map(row => db.rpc("intelligence_jev_settle", {
    p_fingerprint: row.fingerprint, p_reservation: row.reservation_id,
  })));
}
