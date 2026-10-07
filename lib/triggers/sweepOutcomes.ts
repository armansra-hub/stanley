/** Company outcomes, independent of the timestamps used to reserve rotation work. */
export type SweepOutcome = "succeeded" | "partial" | "unavailable" | "failed" | "unsupported" | "skipped";
export type SweepCompanyReceipt = { companyId: string; outcome: SweepOutcome; reason: string; captured: boolean; complete: boolean; completionStamped: boolean };
export type SweepOutcomes = Record<SweepOutcome | "attempted", number> & {
  error_count: number;
  errors: { companyId?: string; source: string; stage: string; code: string; databaseCode?: string }[];
};

export function newSweepOutcomes(): SweepOutcomes {
  return { attempted: 0, succeeded: 0, partial: 0, unavailable: 0, failed: 0, unsupported: 0, skipped: 0, error_count: 0, errors: [] };
}

/** Keep a bounded diagnostic sample even when an entire provider or store fails. */
export function sweepError(stats: SweepOutcomes, source: string, stage: string, error: unknown, companyId?: string): void {
  stats.error_count++;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const databaseCode = /(?:persistence|state read|state write|checkpoint read|checkpoint write|jobs read|lifecycle write|pattern read|pattern receipt) failed:\s*([A-Z0-9]{5})\b/i.exec(message)?.[1].toUpperCase();
  // Aggregate cron receipts never copy provider bodies, URLs, or credentials.
  const code = /timeout|timed out|deadline/i.test(message) ? "timeout"
    : /rate.?limit|429/i.test(message) ? "rate_limited"
    : /state|storage|persistence|database|checkpoint|lifecycle|observation/i.test(message) ? "storage_failure"
    : /cursor/i.test(message) ? "cursor_changed"
    : /403|forbidden|blocked/i.test(message) ? "blocked"
    : "source_failure";
  if (stats.errors.length < 10) stats.errors.push({ ...(companyId ? { companyId } : {}), source, stage,
    code, ...(databaseCode ? { databaseCode } : {}) });
}
