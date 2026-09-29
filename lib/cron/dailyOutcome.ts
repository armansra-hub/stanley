/** Child receipts describe reported batch outcomes, never full-TAM coverage. */
export type DailyChildOutcome = "reported_success" | "partial" | "failed" | "unverified";

const COUNT_FIELDS = [
  "attempted", "succeeded", "partial", "unavailable", "unsupported", "skipped", "error_count",
  "eligible", "remaining",
  "checked", "mainChecked", "retryChecked", "matched", "matches", "observed", "stored",
  "triggers", "errors", "failed", "historiesCompleted", "historiesIncomplete",
  "retryQueued", "retryRemaining", "awardContinuationsQueued", "offset", "nextOffset",
  "changed", "triggered", "parents", "dismissed", "detected", "with_board", "already_on_erp",
  "companies_triggered", "news_triggers", "finance_triggers", "erp_triggers", "new_triggers",
  "alerted", "fleet_growth", "ucc", "kept", "rejected", "promoted", "deferred",
  "deferred_fetch", "deferred_evidence", "deferred_verifier", "deferred_budget", "dropped",
] as const;
const FLAG_FIELDS = ["ok", "complete", "completed", "done", "coverageVerified", "recoveryComplete", "recoveryBlocked", "enabled"] as const;
const COLLECTOR_OUTCOMES = ["succeeded", "partial", "unavailable", "failed", "unsupported", "skipped"] as const;
const SOURCE_STATUSES = new Set([
  "success", "complete", "completed", "empty", "partial", "in_progress", "failed", "error",
  "unavailable", "busy", "rate_limit_backoff", "not_started", "disabled", "skipped", "blocked",
]);

export interface DailyChildReceipt {
  outcome: DailyChildOutcome;
  counts: Record<string, number>;
  flags: Record<string, boolean>;
  sourceStatus?: string;
  issue?: "http_error" | "source_error" | "invalid_receipt" | "receipt_unavailable" | "receipt_too_large";
}

export function summarizeDailyChild(status: number, body: unknown): DailyChildReceipt {
  const receipt: DailyChildReceipt = { outcome: "unverified", counts: {}, flags: {} };
  const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (data) {
    for (const field of COUNT_FIELDS) {
      const value = data[field];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) receipt.counts[field] = value;
    }
    for (const field of FLAG_FIELDS) if (typeof data[field] === "boolean") receipt.flags[field] = data[field] as boolean;
    if (typeof data.status === "string" && SOURCE_STATUSES.has(data.status)) receipt.sourceStatus = data.status;
    // Never retain free text, identifiers, cursors, source URLs or company-level receipts.
    if (Array.isArray(data.retryDeadLettered)) receipt.counts.retryDeadLettered = data.retryDeadLettered.length;
    if (Array.isArray(data.errors)) receipt.counts.errorSamples = data.errors.length;
  }
  if (status < 200 || status >= 300) return { ...receipt, outcome: "failed", issue: "http_error" };
  if (!data) return { ...receipt, issue: "invalid_receipt" };
  if ((data.error != null && data.error !== false && data.error !== "") || receipt.flags.ok === false
    || receipt.flags.recoveryBlocked === true
    || ["failed", "error", "unavailable", "busy", "rate_limit_backoff", "blocked"].includes(receipt.sourceStatus ?? "")) {
    return { ...receipt, outcome: "failed", issue: "source_error" };
  }
  const collector = "attempted" in data || "succeeded" in data;
  const errors = Math.max(receipt.counts.errors ?? 0, receipt.counts.error_count ?? 0, receipt.counts.errorSamples ?? 0,
    (receipt.counts.failed ?? 0) + (receipt.counts.unavailable ?? 0));
  if (errors > 0) {
    const hasProgress = collector
      ? (receipt.counts.succeeded ?? 0) + (receipt.counts.partial ?? 0) > 0
      : (receipt.counts.checked ?? 0) > errors;
    return { ...receipt, outcome: hasProgress ? "partial" : "failed", issue: "source_error" };
  }
  if (["partial", "historiesIncomplete", "retryRemaining", "retryQueued", "awardContinuationsQueued", "retryDeadLettered", "deferred"].some(field => (receipt.counts[field] ?? 0) > 0)
    || receipt.flags.complete === false || receipt.flags.completed === false || receipt.flags.done === false
    || ["partial", "in_progress"].includes(receipt.sourceStatus ?? "")) {
    return { ...receipt, outcome: "partial" };
  }
  if ((receipt.counts.unsupported ?? 0) + (receipt.counts.skipped ?? 0) > 0) {
    return { ...receipt, outcome: (receipt.counts.succeeded ?? 0) > 0 ? "partial" : "unverified" };
  }
  if (receipt.flags.enabled === false || ["not_started", "disabled", "skipped"].includes(receipt.sourceStatus ?? "")
    || (typeof data.status === "string" && !receipt.sourceStatus)) return receipt;
  if (("errors" in data && !Array.isArray(data.errors) && !("errors" in receipt.counts))
    || ["failed", "error_count"].some(field => field in data && !(field in receipt.counts))) {
    return { ...receipt, issue: "invalid_receipt" };
  }
  if (collector) {
    const counts = receipt.counts;
    if (!["attempted", "error_count", ...COLLECTOR_OUTCOMES].every(field => field in counts)
      || COLLECTOR_OUTCOMES.reduce((sum, field) => sum + counts[field], 0) !== counts.attempted) {
      return { ...receipt, issue: "invalid_receipt" };
    }
    return { ...receipt, outcome: "reported_success" };
  }
  // Explicit error totals or success flags support only the reported batch result.
  // Legacy {checked: N, triggers: M} responses say nothing about source failures.
  if (receipt.counts.errors === 0 || receipt.counts.failed === 0 || receipt.flags.ok === true
    || receipt.flags.complete === true || receipt.flags.completed === true
    || ["success", "complete", "completed", "empty"].includes(receipt.sourceStatus ?? "")) {
    receipt.outcome = "reported_success";
  }
  return receipt;
}

export const DAILY_RECEIPT_BYTE_LIMIT = 256 * 1024;

/** Read one bounded JSON response; no raw body or provider error reaches the log. */
export async function readDailyChildReceipt(response: Response): Promise<DailyChildReceipt> {
  const reader = response.body?.getReader();
  if (!reader) return summarizeDailyChild(response.status, null);
  let bytes = 0;
  let json = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DAILY_RECEIPT_BYTE_LIMIT) {
        void reader.cancel().catch(() => {});
        return { ...summarizeDailyChild(response.status, null), issue: "receipt_too_large" };
      }
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
    return summarizeDailyChild(response.status, JSON.parse(json));
  } catch {
    return { ...summarizeDailyChild(response.status, null), issue: "receipt_unavailable" };
  } finally {
    reader.releaseLock();
  }
}
