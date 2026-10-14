import { httpFailureSamples, type HttpFailureSample } from "@/lib/sources/outcomes";
import type { ObservationStorageDiagnostics } from "@/lib/intelligence/observations";

function observationDiagnostics(error: unknown): ObservationStorageDiagnostics | undefined {
  try {
    const raw = (error as { observationDiagnostics?: unknown })?.observationDiagnostics;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const v = raw as Record<string, unknown>;
    const integer = (x: unknown, max: number): x is number => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= max;
    if (v.schema !== "observation-unicode-diagnostics-v1" || typeof v.scanComplete !== "boolean" || typeof v.samplesTruncated !== "boolean"
      || !integer(v.examinedCodeUnits, 131072) || !integer(v.examinedStrings, 96) || !integer(v.visitedNodes, 256)
      || !Array.isArray(v.samples) || v.samples.length > 8) return;
    const samples: ObservationStorageDiagnostics["samples"] = [];
    for (const value of v.samples) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const s = value as Record<string, unknown>;
      if (!["p_company", "p_source_key", "p_source_kind", "p_url", "p_title", "p_text", "p_hash", "p_event_date", "p_observed_at", "p_metadata", "p_sections", "p_version"].includes(s.field as string)
        || !Array.isArray(s.path) || s.path.length > 8 || ![...s.path].every(n => integer(n, 255))
        || !["key", "value"].includes(s.member as string) || typeof s.complete !== "boolean"
        || !integer(s.stringCodeUnits, Number.MAX_SAFE_INTEGER) || !integer(s.examinedCodeUnits, 65536)
        || s.examinedCodeUnits > s.stringCodeUnits || s.examinedCodeUnits > v.examinedCodeUnits
        || s.complete !== (s.stringCodeUnits === s.examinedCodeUnits) || (v.scanComplete && !s.complete)
        || !integer(s.nulCount, s.examinedCodeUnits) || !integer(s.unpairedHighCount, s.examinedCodeUnits)
        || !integer(s.unpairedLowCount, s.examinedCodeUnits)
        || s.nulCount + s.unpairedHighCount + s.unpairedLowCount > s.examinedCodeUnits
        || (s.complete ? typeof s.utf16leSha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.utf16leSha256) : s.utf16leSha256 !== undefined)) return;
      samples.push({ field: s.field as ObservationStorageDiagnostics["samples"][number]["field"], path: [...s.path],
        member: s.member as "key" | "value", stringCodeUnits: s.stringCodeUnits, examinedCodeUnits: s.examinedCodeUnits,
        complete: s.complete, nulCount: s.nulCount, unpairedHighCount: s.unpairedHighCount, unpairedLowCount: s.unpairedLowCount,
        ...(s.complete ? { utf16leSha256: s.utf16leSha256 as string } : {}) });
    }
    return { schema: "observation-unicode-diagnostics-v1", scanComplete: v.scanComplete, samplesTruncated: v.samplesTruncated,
      examinedCodeUnits: v.examinedCodeUnits, examinedStrings: v.examinedStrings, visitedNodes: v.visitedNodes, samples };
  } catch { return; }
}

/** Company outcomes, independent of the timestamps used to reserve rotation work. */
export type SweepOutcome = "succeeded" | "partial" | "unavailable" | "failed" | "unsupported" | "skipped";
export type SweepCompanyReceipt = { companyId: string; outcome: SweepOutcome; reason: string; captured: boolean; complete: boolean; completionStamped: boolean };
export type SweepOutcomes = Record<SweepOutcome | "attempted", number> & {
  error_count: number;
  errors: { companyId?: string; source: string; stage: string; code: string; databaseCode?: string; httpDiagnostics?: HttpFailureSample[]; observationDiagnostics?: ObservationStorageDiagnostics }[];
};

export function newSweepOutcomes(): SweepOutcomes {
  return { attempted: 0, succeeded: 0, partial: 0, unavailable: 0, failed: 0, unsupported: 0, skipped: 0, error_count: 0, errors: [] };
}

/** Keep a bounded diagnostic sample even when an entire provider or store fails. */
export function sweepError(stats: SweepOutcomes, source: string, stage: string, error: unknown, companyId?: string, queries?: unknown): void {
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
  const diagnostics = source === "news" && stage === "feed" ? httpFailureSamples(queries) : [];
  const storage = stage === "observation" && (databaseCode === "22P05" || databaseCode === "22P02") ? observationDiagnostics(error) : undefined;
  if (stats.errors.length < 10) stats.errors.push({ ...(companyId ? { companyId } : {}), source, stage,
    code, ...(databaseCode ? { databaseCode } : {}), ...(diagnostics.length ? { httpDiagnostics: diagnostics } : {}),
    ...(storage ? { observationDiagnostics: storage } : {}) });
}
