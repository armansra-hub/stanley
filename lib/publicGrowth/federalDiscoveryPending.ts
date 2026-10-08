import "server-only";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { parseFederalDiscoveryContinuation, readFederalDiscoveryCapacityHold, readFederalDiscoveryContinuations } from "./federalDiscoveryState";
import { beginPublicGrowthSweep, checkpointPublicGrowthSweep, failPublicGrowthSweep, readPublicGrowthRetryState, type PublicGrowthSweepLease } from "./sweepState";
import { captureFederalPendingSource, federalSourceOnlyHash, type FederalSourceOnlyOutcome } from "./federalDiscoverySourceOnly";

const SOURCE = "federal-discovery";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const federalPendingSourceSchema = z.object({
  operationId: uuid, holdOperationId: uuid, sourceOnly: z.literal(true),
  continuations: z.array(z.object({ companyId: uuid, expectedSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(4),
}).strict().refine(value => value.operationId !== value.holdOperationId
  && new Set(value.continuations.map(row => row.companyId)).size === value.continuations.length);
export const federalPendingInspectSchema = z.array(uuid).min(1).max(4).refine(ids => new Set(ids).size === ids.length);
type Request = z.infer<typeof federalPendingSourceSchema>;

async function currentState() {
  const { data, error } = await serviceClient().from("public_growth_sweep_state").select("cursor,lease_until,lease_token")
    .eq("source", SOURCE).maybeSingle();
  if (error || !data?.cursor || typeof data.cursor !== "object" || Array.isArray(data.cursor)) throw new Error("federal pending state unavailable");
  return data;
}
export async function inspectFederalPendingSources(companyIds: string[]) {
  federalPendingInspectSchema.parse(companyIds);
  const state = await currentState(), cursor = state.cursor;
  const hold = readFederalDiscoveryCapacityHold(cursor), continuations = readFederalDiscoveryContinuations(cursor);
  return { source: SOURCE, readOnly: true, capacityHold: hold, leaseUntil: state.lease_until,
    inFlight: cursor.discoveryInFlight ?? [], sourceOnlyOperation: cursor.discoverySourceOnlyOperation ?? null,
    items: companyIds.map(companyId => ({ companyId, present: Boolean(continuations[companyId]),
      expectedSha256: continuations[companyId] ? federalSourceOnlyHash(cursor.discoveryContinuations[companyId]) : null,
      continuation: continuations[companyId] ? cursor.discoveryContinuations[companyId] : null })),
    analysisComplete: false, historyComplete: false };
}
function assertAdmission(cursor: Record<string, unknown>, request: Request) {
  const hold = readFederalDiscoveryCapacityHold(cursor), parsed = readFederalDiscoveryContinuations(cursor);
  const priorOperation = cursor.discoverySourceOnlyOperation as { status?: unknown; eventId?: unknown } | undefined;
  if (!hold || hold.operationId !== request.holdOperationId || !isDeepStrictEqual(cursor.discoveryInFlight ?? [], [])
    || cursor.discoveryInFlightEventId != null || cursor.discoveryReconciliationReason != null
    || !isDeepStrictEqual(cursor.discoveryUncertainOutcomes ?? [], [])
    || priorOperation && (priorOperation.status !== "checkpointed" || priorOperation.eventId === request.operationId)) throw new Error("exact operator hold or in-flight fence mismatch");
  const backoff = cursor.discoveryBackoffUntil;
  if (backoff != null && (typeof backoff !== "string" || !Number.isFinite(Date.parse(backoff)) || Date.parse(backoff) > Date.now())) throw new Error("federal backoff");
  const oldHold = cursor.discoveryReadbackHold as { companyIds?: unknown } | undefined;
  const timeouts = cursor.discoveryStrategyTimeouts ?? [];
  const debt = readPublicGrowthRetryState(cursor);
  if (oldHold && !Array.isArray(oldHold.companyIds) || !Array.isArray(timeouts)) throw new Error("invalid federal holds");
  for (const item of request.continuations) {
    if (!parsed[item.companyId] || parsed[item.companyId].sourceCapture?.status === "held"
      || (oldHold?.companyIds as unknown[] | undefined)?.includes(item.companyId)
      || timeouts.some(row => !row || typeof row !== "object" || row.companyId === item.companyId && (row.heldAt != null || row.timeoutCount !== 0))
      || debt.retryQueue.some(row => row.companyId === item.companyId && row.failureAttempts > 0)
      || debt.deadLetters.some(row => row.companyId === item.companyId && row.resolvedAt === null)
      || federalSourceOnlyHash((cursor.discoveryContinuations as Record<string, unknown>)[item.companyId]) !== item.expectedSha256) {
      throw new Error("exact pending continuation is absent, held or changed");
    }
  }
  return parsed;
}
async function readEvent(operationId: string) {
  const { data, error } = await serviceClient().from("app_events").select("id,module,kind,entity_type,entity_id,meta").eq("id", operationId).maybeSingle();
  if (error) throw new Error("source-only operation readback unavailable");
  return data;
}
function verifiedEvent(event: Awaited<ReturnType<typeof readEvent>>, request: Request, cursor: Record<string, unknown>) {
  const marker = cursor.discoverySourceOnlyOperation as { status?: unknown; request?: unknown; eventId?: unknown } | undefined;
  if (!event || event.id !== request.operationId || event.module !== "headhunter" || event.kind !== "federal.discovery.source_only"
    || event.entity_type !== "cron" || event.entity_id !== SOURCE || !isDeepStrictEqual(event.meta?.request, request)
    || event.meta.analysisComplete !== false || event.meta.historyComplete !== false || event.meta.operatorHoldRetained !== true
    || marker?.status !== "checkpointed" || marker.eventId !== event.id || !isDeepStrictEqual(marker.request, request)
    || !isDeepStrictEqual(cursor.discoveryInFlight, []) || cursor.discoveryInFlightEventId !== null
    || !Array.isArray(event.meta.outcomes) || event.meta.outcomes.length !== request.continuations.length
    || event.meta.outcomes.some((row: FederalSourceOnlyOutcome, index: number) => row.companyId !== request.continuations[index].companyId
      || federalSourceOnlyHash((cursor.discoveryContinuations as Record<string, unknown>)?.[row.companyId]) !== event.meta.afterHashes?.[row.companyId])) {
    throw new Error("source-only operation requires exact readback; never replay");
  }
  return { ...event.meta, eventId: event.id, exactEventVerified: true, exactStateVerified: true };
}

/** Explicit foreground scope only. Reuses the same lease, continuations and
 * observation publisher; ordinary scheduling remains stopped by capacityHold. */
export async function continueFederalPendingSources(request: Request) {
  federalPendingSourceSchema.parse(request);
  if (!intelligenceEnabled()) throw new Error("government source capture disabled");
  const prior = await currentState(), priorEvent = await readEvent(request.operationId);
  if (priorEvent) return { ...verifiedEvent(priorEvent, request, prior.cursor), reusedReceipt: true };
  assertAdmission(prior.cursor, request);
  let lease: PublicGrowthSweepLease | undefined;
  try {
    lease = await beginPublicGrowthSweep(SOURCE, request.continuations.length, null);
    const parsed = assertAdmission(lease.cursor, request), original = structuredClone(lease.cursor);
    // The durable fence precedes every provider or observation write. Unknown
    // completion retains this exact operation; new UUIDs cannot bypass it.
    const pending = { version: 1, status: "in_flight", request, eventId: request.operationId };
    await checkpointPublicGrowthSweep(lease, { discoveryInFlight: request.continuations.map(row => row.companyId),
      discoveryInFlightEventId: request.operationId, discoverySourceOnlyOperation: pending });
    const outcomes: FederalSourceOnlyOutcome[] = [];
    let providerUnavailable = false;
    for (const item of request.continuations) {
      const outcome: FederalSourceOnlyOutcome = providerUnavailable ? { companyId: item.companyId, status: "incomplete",
        reason: "not_attempted_after_provider_failure", sourceRequests: 0, reusedCapture: false, sourceCaptured: false,
        observationId: null, jobId: null, analysisComplete: false, identityVerified: false, historyComplete: false,
        continuation: parsed[item.companyId] }
        : await captureFederalPendingSource(item.companyId,
          (original.discoveryContinuations as Record<string, typeof parsed[string]>)[item.companyId], request.operationId, Date.now() + 50_000);
      if (outcome.companyId !== item.companyId || outcome.status !== "incomplete" || outcome.analysisComplete !== false
        || outcome.identityVerified !== false || outcome.historyComplete !== false || ![0, 1].includes(outcome.sourceRequests)
        || outcome.sourceCaptured && (!outcome.observationId || !outcome.jobId)) throw new Error("invalid source-only outcome");
      parseFederalDiscoveryContinuation(outcome.continuation, item.companyId);
      outcomes.push(outcome);
      providerUnavailable ||= outcome.reason === "provider_unavailable_no_retry";
      // Retain every known outcome even if a later selected step is uncertain.
      await checkpointPublicGrowthSweep(lease, { discoverySourceOnlyOperation: { ...pending, outcomes: structuredClone(outcomes) } });
    }
    const next = structuredClone(original.discoveryContinuations as Record<string, unknown>);
    for (const outcome of outcomes) {
      // Preserve unknown retained extensions, but do not resurrect an optional
      // candidate/page field deliberately consumed by the validated step.
      const extensions = { ...(next[outcome.companyId] as Record<string, unknown>) };
      for (const key of Object.keys(parsed[outcome.companyId])) delete extensions[key];
      next[outcome.companyId] = { ...extensions, ...outcome.continuation };
    }
    const afterHashes = Object.fromEntries(outcomes.map(row => [row.companyId, federalSourceOnlyHash(next[row.companyId])]));
    const meta = { source: SOURCE, request, outcomes, afterHashes, sourceRequests: outcomes.reduce((n, row) => n + row.sourceRequests, 0),
      captured: outcomes.filter(row => row.sourceCaptured).length, reusedCaptures: outcomes.filter(row => row.reusedCapture).length,
      operatorHoldRetained: true, analysisComplete: false, historyComplete: false, coverageVerified: false,
      mainSelections: 0, retrySelections: 0, keysetAdvanced: false, attemptsCredited: 0, triggers: 0 };
    const event = { id: request.operationId, module: "headhunter", kind: "federal.discovery.source_only", entity_type: "cron", entity_id: SOURCE, meta };
    const { error } = await serviceClient().from("app_events").insert(event);
    if (error || !isDeepStrictEqual(await readEvent(request.operationId), event)) throw new Error("source-only journal requires readback");
    await checkpointPublicGrowthSweep(lease, { discoveryContinuations: next, discoveryInFlight: [], discoveryInFlightEventId: null,
      discoverySourceOnlyOperation: { ...pending, status: "checkpointed" } });
    // Releasing the lease does not certify a complete sweep or advance success time.
    if (!await failPublicGrowthSweep(lease, new Error("source_only_capture_incomplete_awaiting_review"))) throw new Error("source-only lease release uncertain");
    const after = await currentState();
    const expected = { ...original, offset: lease.offset, discoveryContinuations: next, discoveryInFlight: [], discoveryInFlightEventId: null,
      discoverySourceOnlyOperation: { ...pending, status: "checkpointed" } };
    if (!isDeepStrictEqual(after.cursor, expected) || after.lease_token != null || after.lease_until != null) throw new Error("source-only state preservation requires readback");
    return { ...verifiedEvent(await readEvent(request.operationId), request, after.cursor), reusedReceipt: false };
  } catch (error) {
    if (lease) await failPublicGrowthSweep(lease, new Error("source_only_incomplete_requires_readback")).catch(() => false);
    throw error;
  }
}
