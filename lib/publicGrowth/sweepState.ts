import "server-only";
import { advanceCursorOffset } from "@/lib/cron/rotation";
import { serviceClient } from "@/lib/supabase/server";

export interface PublicGrowthSweepLease {
  source: string;
  offset: number;
  batchSize: number;
  managed: boolean;
  cursor: Record<string, unknown>;
  token: string | null;
  leaseUntil: string | null;
}

export interface PublicGrowthSweepResult {
  checked: number;
  nextOffset?: number;
  done?: boolean;
  triggers?: number;
  matched?: number;
  matches?: number;
  observed?: number;
}

/** Sixty-second fencing margin beyond the route's 300-second runtime ceiling. */
export const PUBLIC_GROWTH_LEASE_SECONDS = 360;

export class PublicGrowthSweepBusyError extends Error {
  constructor(public readonly source: string, public readonly retryAt: string | null) {
    super(`public-growth source ${source} already has an active sweep`);
    this.name = "PublicGrowthSweepBusyError";
  }
}

export class PublicGrowthSweepLeaseLostError extends Error {
  constructor(public readonly source: string) {
    super(`public-growth source ${source} no longer owns its sweep lease`);
    this.name = "PublicGrowthSweepLeaseLostError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function offsetFromCursor(cursor: unknown): number {
  if (!cursor || typeof cursor !== "object") return 0;
  const value = Number((cursor as Record<string, unknown>).offset ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Explicit offsets are manual/recovery calls and do not mutate the scheduled
 * cursor. Scheduled calls omit offset and advance public_growth_sweep_state.
 */
export async function beginPublicGrowthSweep(
  source: string,
  batchSize: number,
  explicitOffset: number | null,
): Promise<PublicGrowthSweepLease> {
  if (explicitOffset != null) {
    return {
      source,
      offset: explicitOffset,
      batchSize,
      managed: false,
      cursor: { offset: explicitOffset },
      token: null,
      leaseUntil: null,
    };
  }

  const { data, error } = await serviceClient().rpc("acquire_public_growth_sweep_lease", {
    p_source: source,
    p_lease_seconds: PUBLIC_GROWTH_LEASE_SECONDS,
  });
  if (error) throw new Error(`public-growth lease acquisition failed for ${source}: ${error.message}`);
  const payload = objectRecord(data);
  if (!payload) throw new Error(`public-growth lease acquisition returned an invalid receipt for ${source}`);
  const leaseUntil = typeof payload.lease_until === "string" ? payload.lease_until : null;
  if (payload.acquired !== true) throw new PublicGrowthSweepBusyError(source, leaseUntil);
  const token = typeof payload.lease_token === "string" ? payload.lease_token : "";
  if (!token) throw new Error(`public-growth lease acquisition omitted its token for ${source}`);
  const cursor = objectRecord(payload.cursor) ?? {};
  return {
    source,
    offset: offsetFromCursor(cursor),
    batchSize,
    managed: true,
    cursor: { ...cursor },
    token,
    leaseUntil,
  };
}

export async function completePublicGrowthSweep(
  lease: PublicGrowthSweepLease,
  result: PublicGrowthSweepResult,
): Promise<number> {
  if (!lease.managed) return lease.offset;
  if (!lease.token) throw new PublicGrowthSweepLeaseLostError(lease.source);
  const nextOffset = advanceCursorOffset({
    currentOffset: lease.offset,
    checked: result.checked,
    batchSize: lease.batchSize,
    done: result.done === true,
    reportedNextOffset: result.nextOffset,
  });
  const now = new Date().toISOString();
  const nextCursor = { ...lease.cursor, offset: nextOffset };
  const receipt = {
    checked: result.checked,
    nextOffset,
    done: result.done === true,
    triggers: result.triggers ?? 0,
    matched: result.matched ?? result.matches ?? result.observed ?? 0,
    completedAt: now,
  };
  const { data, error } = await serviceClient().rpc("complete_public_growth_sweep_lease", {
    p_source: lease.source,
    p_lease_token: lease.token,
    p_cursor: nextCursor,
    p_receipt: receipt,
  });
  if (error) throw new Error(`public-growth cursor advance failed for ${lease.source}: ${error.message}`);
  if (data !== true) throw new PublicGrowthSweepLeaseLostError(lease.source);
  return nextOffset;
}

export async function failPublicGrowthSweep(lease: PublicGrowthSweepLease, error: unknown): Promise<boolean> {
  if (!lease.managed) return true;
  if (!lease.token) return false;
  const message = error instanceof Error ? error.message : String(error);
  const { data, error: rpcError } = await serviceClient().rpc("fail_public_growth_sweep_lease", {
    p_source: lease.source,
    p_lease_token: lease.token,
    p_error: message.slice(0, 1000),
  });
  if (rpcError) throw new Error(`public-growth failure receipt failed for ${lease.source}: ${rpcError.message}`);
  return data === true;
}
