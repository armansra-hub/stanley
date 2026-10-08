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
  return { source: SOURCE, readOnly: true, cursorSha256: federalSourceOnlyHash(cursor), capacityHold: hold, leaseUntil: state.lease_until,
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
  const { data, error } = await serviceClient().from("app_events").select("id,module,kind,entity_type,entity_id,summary,meta").eq("id", operationId).maybeSingle();
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
    const event = { id: request.operationId, module: "headhunter", kind: "federal.discovery.source_only", entity_type: "cron", entity_id: SOURCE,
      summary: "Captured bounded federal originals; independent source review remains incomplete", meta };
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

// Immutable identifiers/hash pins for the independently reviewed d4 incident.
const reviewedFirstStep = {
  "originalRequest": {
    "sourceOnly": true,
    "operationId": "624f17f4-41e5-487c-a47c-ee785fafd2b8",
    "continuations": [
      {
        "companyId": "5cb49e88-b779-467a-aa28-cb704eb4b808",
        "expectedSha256": "70af63a1ffbc568f7ee1869390a01cedef2e8b683d041307bc44e6d32ec7f452"
      },
      {
        "companyId": "5cb653c0-93c5-483a-a63d-4266c264a77b",
        "expectedSha256": "c42a329dd366fcf1f47cf15cb9bbf6bd576fb7b4c5fde801451c3900c1d5cb3d"
      },
      {
        "companyId": "5cb968f7-e56a-4b71-b6a5-a70846949aa3",
        "expectedSha256": "e5c25473f3391ae43dee4851911ceca7afcf985ed726fb47b6dc57635d67426b"
      },
      {
        "companyId": "5cbdb11f-d241-46e8-a3da-92f213378498",
        "expectedSha256": "bd4c5d7f902d7f327ba03d7acc89941a939e69eab97f59275be387b6161031e5"
      }
    ],
    "holdOperationId": "4a173495-2b1d-41d4-966d-cba64832fcc9"
  },
  "retainedSource": {
    "observationId": "dfffb638-5c44-472f-b0b6-cac340530ef0",
    "jobId": "db64a7e3-2607-4cc2-a0ae-8119fab094b7",
    "sourceKey": "66b77c52cbe91eec136e963894ead8a2d016b18646349cb00ef126c02265ee49",
    "requestSha256": "c1243ac35ad4efcfe72083cca6217383da08724da4624b517b1d315532b1a030",
    "retainedJsonSha256": "fc757405485bafe627208795a5010df673f1db91aef27d86e0699fc9879b142a"
  }
} as const;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Narrow reviewed recovery for the deployed serial first-step job-read defect.
 * This is not a general fence reset or permission to replay an uncertain call. */
export const federalPendingRecoverySchema = z.object({
  operationId: uuid, originalRequest: federalPendingSourceSchema, expectedCursorSha256: sha256,
  retainedSource: z.object({ observationId: uuid, jobId: uuid, sourceKey: sha256, requestSha256: sha256, retainedJsonSha256: sha256 }).strict(),
  incidentProof: z.object({
    kind: z.literal("first_job_read_missing_company_column_before_serial_checkpoint"),
    deployedCommit: z.literal("d4cb26f96eb37ab3c2d5e199629b0974809a88de"),
    readerTaskId: z.string().trim().min(1).max(160), reviewerTaskId: z.string().trim().min(1).max(160),
    evidenceSha256: sha256, reviewSha256: sha256,
    historicalSourceRequests: z.literal(1), remainingSourceRequests: z.literal(0),
  }).strict(),
}).strict().refine(value => isDeepStrictEqual(value.originalRequest, reviewedFirstStep.originalRequest)
  && isDeepStrictEqual(value.retainedSource, reviewedFirstStep.retainedSource)
  && value.operationId !== value.originalRequest.operationId && value.operationId !== value.originalRequest.holdOperationId
  && value.incidentProof.readerTaskId !== value.incidentProof.reviewerTaskId);
type RecoveryRequest = z.infer<typeof federalPendingRecoverySchema>;
function assertRecovery(cursor: Record<string, unknown>, request: RecoveryRequest) {
  const original = request.originalRequest, hold = readFederalDiscoveryCapacityHold(cursor);
  const parsed = readFederalDiscoveryContinuations(cursor);
  if (federalSourceOnlyHash(cursor) !== request.expectedCursorSha256 || hold?.operationId !== original.holdOperationId
    || !isDeepStrictEqual(cursor.discoveryInFlight, original.continuations.map(row => row.companyId))
    || cursor.discoveryInFlightEventId !== original.operationId
    || !isDeepStrictEqual(cursor.discoverySourceOnlyOperation, { version: 1, status: "in_flight", request: original, eventId: original.operationId })
    || cursor.discoveryReconciliationReason != null || !isDeepStrictEqual(cursor.discoveryUncertainOutcomes ?? [], [])) {
    throw new Error("reviewed exact first-step recovery fence mismatch");
  }
  for (const item of original.continuations) {
    if (!parsed[item.companyId] || parsed[item.companyId].sourceCapture?.status === "held"
      || federalSourceOnlyHash((cursor.discoveryContinuations as Record<string, unknown>)[item.companyId]) !== item.expectedSha256) {
      throw new Error("reviewed original continuation changed");
    }
  }
}
function verifiedRecovery(event: Awaited<ReturnType<typeof readEvent>>, request: RecoveryRequest, cursor: Record<string, unknown>) {
  const marker = cursor.discoverySourceOnlyOperation as { status?: unknown; request?: unknown; eventId?: unknown; reconciliationRequest?: unknown } | undefined;
  if (!event || event.id !== request.operationId || event.module !== "headhunter" || event.kind !== "federal.discovery.source_only_reconciled"
    || event.entity_type !== "cron" || event.entity_id !== SOURCE || !isDeepStrictEqual(event.meta?.request, request)
    || event.meta.sourceRequests !== 0 || event.meta.attemptsCredited !== 0 || event.meta.analysisComplete !== false
    || event.meta.historyComplete !== false || event.meta.operatorHoldRetained !== true
    || marker?.status !== "checkpointed" || marker.eventId !== event.id || !isDeepStrictEqual(marker.request, request.originalRequest)
    || !isDeepStrictEqual(marker.reconciliationRequest, request)
    || !isDeepStrictEqual(cursor.discoveryInFlight, []) || cursor.discoveryInFlightEventId !== null
    || federalSourceOnlyHash(cursor) !== event.meta.afterCursorSha256) throw new Error("source recovery requires exact event/state readback; never replay");
  return { ...event.meta, eventId: event.id, exactEventVerified: true, exactStateVerified: true };
}

/** Provider-free disposition of a reviewed first-step interruption. The worker
 * is structurally retained-only; the other three workers are never invoked.
 * The first source gains a review hold; the unattempted three stay unchanged. */
export async function reconcileFederalPendingSource(request: RecoveryRequest) {
  federalPendingRecoverySchema.parse(request);
  if (!intelligenceEnabled()) throw new Error("government source capture disabled");
  const prior = await currentState(), priorEvent = await readEvent(request.operationId);
  if (priorEvent) return { ...verifiedRecovery(priorEvent, request, prior.cursor), reusedReceipt: true };
  assertRecovery(prior.cursor, request);
  if (await readEvent(request.originalRequest.operationId)) throw new Error("original operation already has a journal");
  let lease: PublicGrowthSweepLease | undefined;
  try {
    lease = await beginPublicGrowthSweep(SOURCE, 4, null);
    assertRecovery(lease.cursor, request);
    if (await readEvent(request.originalRequest.operationId)) throw new Error("original journal appeared during recovery");
    const original = structuredClone(lease.cursor), next = structuredClone(original.discoveryContinuations as Record<string, unknown>);
    const firstId = request.originalRequest.continuations[0].companyId;
    const first = await captureFederalPendingSource(firstId, next[firstId] as Parameters<typeof captureFederalPendingSource>[1],
      request.originalRequest.operationId, Date.now() + 50_000, request.retainedSource);
    if (first.companyId !== firstId || first.sourceRequests !== 0 || first.reusedCapture !== true || first.sourceCaptured !== true
      || first.observationId !== request.retainedSource.observationId || first.jobId !== request.retainedSource.jobId
      || first.status !== "incomplete" || first.analysisComplete !== false || first.identityVerified !== false || first.historyComplete !== false
      || first.continuation.sourceCapture?.requestSha256 !== request.retainedSource.requestSha256
      || first.continuation.sourceCapture?.retainedJsonSha256 !== request.retainedSource.retainedJsonSha256) {
      throw new Error("first source exact retained-only reconstruction failed");
    }
    const outcomes: FederalSourceOnlyOutcome[] = request.originalRequest.continuations.map((item, index) => {
      const reason = index === 0 ? "retained_source_recovered_awaiting_independent_review" : "not_attempted_before_first_step_readback_failure";
      // Do not consume any search position, including the known first page.
      // The unattempted three acquire neither a source hold nor retry debt.
      if (index === 0) next[item.companyId] = { ...(next[item.companyId] as object),
        sourceCapture: { ...first.continuation.sourceCapture!, status: "held", reason } };
      const continuation = parseFederalDiscoveryContinuation(next[item.companyId], item.companyId);
      return { companyId: item.companyId, status: "incomplete", reason, sourceRequests: 0,
        reusedCapture: index === 0, sourceCaptured: index === 0, observationId: index === 0 ? first.observationId : null,
        jobId: index === 0 ? first.jobId : null, analysisComplete: false, identityVerified: false, historyComplete: false, continuation };
    });
    const marker = { version: 1, status: "checkpointed", eventId: request.operationId, request: request.originalRequest, reconciliationRequest: request };
    const expected = { ...original, offset: lease.offset, discoveryContinuations: next, discoveryInFlight: [], discoveryInFlightEventId: null, discoverySourceOnlyOperation: marker };
    const meta = { source: SOURCE, request, outcomes, beforeCursorSha256: request.expectedCursorSha256, afterCursorSha256: federalSourceOnlyHash(expected),
      sourceRequests: 0, historicalSourceRequests: 1, historicalSourceRequestCompanyId: firstId, remainingHistoricalSourceRequests: 0,
      retainedCapturesRecovered: 1, unattemptedIncomplete: 3, operatorHoldRetained: true, analysisComplete: false, historyComplete: false, coverageVerified: false,
      mainSelections: 0, retrySelections: 0, keysetAdvanced: false, attemptsCredited: 0, triggers: 0 };
    const event = { id: request.operationId, module: "headhunter", kind: "federal.discovery.source_only_reconciled", entity_type: "cron", entity_id: SOURCE,
      summary: "Recovered one retained federal source; three unattempted continuations preserved", meta };
    const { error } = await serviceClient().from("app_events").insert(event);
    if (error || !isDeepStrictEqual(await readEvent(request.operationId), event)) throw new Error("source recovery journal requires readback");
    // Exact lease + original cursor assertion retain the fence until all source
    // and independent incident proof gates have passed and the journal exists.
    await checkpointPublicGrowthSweep(lease, { discoveryContinuations: next, discoveryInFlight: [], discoveryInFlightEventId: null, discoverySourceOnlyOperation: marker });
    if (!await failPublicGrowthSweep(lease, new Error("source_recovery_incomplete_awaiting_review"))) throw new Error("source recovery lease release uncertain");
    const after = await currentState();
    if (!isDeepStrictEqual(after.cursor, expected) || after.lease_token != null || after.lease_until != null) throw new Error("source recovery state preservation requires readback");
    return { ...verifiedRecovery(await readEvent(request.operationId), request, after.cursor), reusedReceipt: false };
  } catch (error) {
    if (lease) await failPublicGrowthSweep(lease, new Error("source_recovery_requires_readback")).catch(() => false);
    throw error;
  }
}
