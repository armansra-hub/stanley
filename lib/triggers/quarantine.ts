import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority, reconcilePublishableSignalFlags } from "@/lib/db/triggers";
import {
  isCareerEvidenceUrl,
  sourceRequiresCareerLink,
  triggerQuarantineReason,
  type FinanceHireCompanyEvidence,
  type TriggerEvidence,
} from "@/lib/triggers/signalIntegrity";
import {
  fetchPublicHttpStatus,
  UnsafeHttpTargetError,
} from "@/lib/triggers/urlSafety";

interface StoredTrigger extends TriggerEvidence {
  id: string;
  company_id: string;
  metadata?: Record<string, unknown> | null;
  companies: FinanceHireCompanyEvidence | FinanceHireCompanyEvidence[] | null;
}

interface QuarantineRpcResult {
  marker: Record<string, unknown>;
  changed: boolean;
}

export interface TriggerQuarantineReceipt {
  mode: "dry_run" | "apply";
  batch: string;
  scanned: number;
  planned: number;
  applied: number;
  readbackVerified: number;
  flagsCleared: number;
  failures: { id: string; reason: string }[];
  reasonCounts: Record<string, number>;
  nextCursor: string | null;
  hasMore: boolean;
}

const BATCH = "signal-integrity-2026-08-10";
const RELEVANT_TYPES = ["finance_hire", "funding", "gov_contract", "ma", "press", "new_entity"];

function companyFor(row: StoredTrigger): FinanceHireCompanyEvidence {
  const value = Array.isArray(row.companies) ? row.companies[0] : row.companies;
  return value ?? { name: "" };
}

async function verifyLiveCareerLink(url: string | null | undefined): Promise<string | null> {
  if (!isCareerEvidenceUrl(url)) return "finance_hire_invalid_evidence_url";
  try {
    const response = await fetchPublicHttpStatus(String(url), {
      timeoutMs: 4_500,
      maxRedirects: 4,
    });
    if (response.status < 200 || response.status >= 300) {
      return `finance_hire_career_http_${response.status}`;
    }
    if (!isCareerEvidenceUrl(response.finalUrl)) return "finance_hire_career_redirected_unrelated";
    return null;
  } catch (error) {
    if (error instanceof UnsafeHttpTargetError) return "finance_hire_career_unsafe_target";
    return "finance_hire_career_unverifiable";
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  }
  return out;
}

/**
 * Plan or apply one bounded cleanup page. Apply mode never deletes or rewrites
 * evidence fields: it atomically adds metadata.stanley_quarantine, reads it back,
 * and recomputes only the companies whose markers were verified.
 */
export async function quarantineInvalidTriggers(opts: {
  apply?: boolean;
  limit?: number;
  after?: string | null;
  verifyCareerLinks?: boolean;
} = {}): Promise<TriggerQuarantineReceipt> {
  const db = serviceClient();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  let query = db.from("triggers")
    .select("id,company_id,type,summary,source_name,source_url,metadata,companies!inner(name,record_dead,description,subindustry,ns_industry)")
    .in("type", RELEVANT_TYPES)
    .order("id", { ascending: true })
    .limit(limit);
  if (opts.after) query = query.gt("id", opts.after);
  const { data, error } = await query;
  if (error) throw new Error(`signal quarantine scan failed: ${error.message}`);
  const rows = (data ?? []) as unknown as StoredTrigger[];

  const planned = await mapConcurrent(rows, 8, async (row) => {
    const existingMarker = row.metadata?.stanley_quarantine;
    if (
      existingMarker
      && typeof existingMarker === "object"
      && !Array.isArray(existingMarker)
      && (existingMarker as Record<string, unknown>).active === true
    ) {
      const priorReason = String((existingMarker as Record<string, unknown>).reason ?? "").trim();
      return { row, reason: priorReason || "existing_active_quarantine" };
    }
    let reason = triggerQuarantineReason(row, companyFor(row));
    if (!reason && opts.verifyCareerLinks !== false && row.type === "finance_hire" && sourceRequiresCareerLink(row.source_name)) {
      reason = await verifyLiveCareerLink(row.source_url);
    }
    return reason ? { row, reason } : null;
  });
  const actions = planned.filter((value): value is { row: StoredTrigger; reason: string } => value !== null);
  const reasonCounts: Record<string, number> = {};
  for (const action of actions) reasonCounts[action.reason] = (reasonCounts[action.reason] ?? 0) + 1;

  const receipt: TriggerQuarantineReceipt = {
    mode: opts.apply ? "apply" : "dry_run",
    batch: BATCH,
    scanned: rows.length,
    planned: actions.length,
    applied: 0,
    readbackVerified: 0,
    flagsCleared: 0,
    failures: [],
    reasonCounts,
    nextCursor: rows.at(-1)?.id ?? null,
    hasMore: rows.length === limit,
  };
  if (!opts.apply || actions.length === 0) return receipt;

  const writes = await mapConcurrent(actions, 8, async ({ row, reason }) => {
    const { data, error: writeError } = await db.rpc("quarantine_trigger", {
      p_trigger_id: row.id,
      p_reason: reason,
      p_batch: BATCH,
      p_actor: "stanley-signal-integrity",
    });
    if (writeError) return { id: row.id, companyId: row.company_id, reason, marker: null, error: writeError.message, applied: false };
    const result = data as QuarantineRpcResult | null;
    if (!result?.marker) {
      return { id: row.id, companyId: row.company_id, reason, marker: null, error: "quarantine target missing", applied: false };
    }
    return {
      id: row.id,
      companyId: row.company_id,
      reason,
      marker: result.marker,
      error: null,
      applied: result.changed === true,
    };
  });
  receipt.applied = writes.filter((write) => write.applied).length;
  receipt.failures.push(...writes.filter((write) => write.error).map((write) => ({ id: write.id, reason: String(write.error) })));

  const expected = new Map<string, (typeof writes)[number] & { marker: Record<string, unknown> }>();
  for (const write of writes) {
    const marker = write.marker;
    if (!write.error && marker) expected.set(write.id, { ...write, marker });
  }
  const ids = [...expected.keys()];
  const readbackRows: { id: string; metadata: Record<string, unknown> | null }[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data: readback, error: readError } = await db.from("triggers").select("id,metadata").in("id", ids.slice(i, i + 100));
    if (readError) {
      receipt.failures.push({ id: `readback:${i}`, reason: readError.message });
      continue;
    }
    readbackRows.push(...((readback ?? []) as { id: string; metadata: Record<string, unknown> | null }[]));
  }

  const verifiedCompanyIds = new Set<string>();
  for (const row of readbackRows) {
    const want = expected.get(row.id);
    const marker = row.metadata?.stanley_quarantine as Record<string, unknown> | undefined;
    if (
      want
      && marker?.active === true
      && marker.reason === want.marker.reason
      && marker.batch === want.marker.batch
      && marker.actor === want.marker.actor
      && marker.quarantined_at === want.marker.quarantined_at
    ) {
      receipt.readbackVerified++;
      verifiedCompanyIds.add(want.companyId);
    } else if (want) {
      receipt.failures.push({ id: row.id, reason: "quarantine readback mismatch" });
    }
  }
  for (const id of ids) {
    if (!readbackRows.some((row) => row.id === id)) receipt.failures.push({ id, reason: "quarantine readback missing" });
  }

  const repairResults = await mapConcurrent([...verifiedCompanyIds], 8, async (companyId) => {
    const failures: { id: string; reason: string }[] = [];
    try {
      await recomputePriority(companyId);
    } catch (error) {
      failures.push({
        id: `priority:${companyId}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    let flagsCleared = false;
    try {
      flagsCleared = await reconcilePublishableSignalFlags(companyId);
    } catch (error) {
      failures.push({
        id: `flags:${companyId}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return { failures, flagsCleared };
  });
  receipt.flagsCleared = repairResults.filter((result) => result.flagsCleared).length;
  receipt.failures.push(...repairResults.flatMap((result) => result.failures));
  return receipt;
}
