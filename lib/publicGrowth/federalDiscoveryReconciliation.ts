import "server-only";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { serviceClient } from "@/lib/supabase/server";
import { parseFederalDiscoveryContinuation, readFederalDiscoveryCapacityHold, readFederalDiscoveryContinuations } from "./federalDiscoveryState";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const federalCapacityReconciliationSchema = z.object({
  operationId: uuid,
  journalId: uuid,
  companyIds: z.array(uuid).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
  expectedCursorMd5: z.string().regex(/^[0-9a-f]{32}$/),
  expectedJournalMd5: z.string().regex(/^[0-9a-f]{32}$/),
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  readerTaskId: z.string().trim().min(1).max(200),
  reviewerTaskId: z.string().trim().min(1).max(200),
}).strict().refine(value => value.operationId !== value.journalId && value.readerTaskId !== value.reviewerTaskId);
type Request = z.infer<typeof federalCapacityReconciliationSchema>;

/** A recovery is not a sweep: the RPC atomically preserves its event and state,
 * and this exact readback cannot invoke the provider or the identity classifier. */
export async function reconcileFederalDiscoveryCapacity(request: Request) {
  const { data: journal, error: journalError } = await serviceClient().from("app_events")
    .select("id,module,kind,entity_type,meta").eq("id", request.journalId).maybeSingle();
  const rows = journal?.meta?.attemptedCompanies;
  if (journalError || journal?.id !== request.journalId || journal.module !== "headhunter"
    || journal.kind !== "federal.discovery.attempts" || journal.entity_type !== "cron"
    || journal.meta?.source !== "federal-discovery" || journal.meta.requestStrategy !== "name-only-v1"
    || journal.meta.coverageVerified !== false || journal.meta.historyComplete !== false
    || !Array.isArray(rows) || !isDeepStrictEqual(rows.map(row => row?.companyId), request.companyIds)) {
    throw new Error("capacity recovery journal mismatch");
  }
  for (const row of rows) {
    if (row.status !== "in_progress" || row.stage !== "award_search" || row.reason !== "searching_contract_vehicles"
      || row.sourceRequests !== 1 || row.mayHaveWritten !== false || row.verified !== false
      || row.historyComplete !== false || row.exhaustive !== false) throw new Error("capacity recovery requires exact unfinished no-write searches");
    parseFederalDiscoveryContinuation(row.continuation, row.companyId);
  }
  const { data: priorState, error: priorError } = await serviceClient().from("public_growth_sweep_state")
    .select("cursor").eq("source", "federal-discovery").maybeSingle();
  if (priorError || !priorState?.cursor) throw new Error("capacity recovery prior state unavailable");
  readFederalDiscoveryContinuations(priorState.cursor);
  const priorHold = readFederalDiscoveryCapacityHold(priorState.cursor);
  if (priorHold && priorHold.operationId !== request.operationId) throw new Error("different capacity hold already present");
  const { data, error } = await serviceClient().rpc("reconcile_federal_discovery_capacity_hold", { p_request: request });
  if (error || !data || data.eventId !== request.operationId || data.status !== "held"
    || data.sourceRequests !== 0 || data.attemptsCredited !== 0 || data.providerReplay !== false
    || data.coverageVerified !== false || data.historyComplete !== false) throw new Error("capacity recovery transaction not verified");
  const { data: event, error: eventError } = await serviceClient().from("app_events")
    .select("id,module,kind,entity_type,entity_id,meta").eq("id", request.operationId).maybeSingle();
  const { data: state, error: stateError } = await serviceClient().from("public_growth_sweep_state")
    .select("cursor").eq("source", "federal-discovery").maybeSingle();
  if (eventError || event?.id !== request.operationId || event.module !== "headhunter"
    || event.kind !== "federal.discovery.capacity_hold" || event.entity_type !== "cron" || event.entity_id !== "federal-discovery"
    || !isDeepStrictEqual(event.meta, data) || !isDeepStrictEqual(event.meta.request, request)
    || stateError || !state?.cursor || !isDeepStrictEqual(state.cursor.discoveryInFlight, [])
    || state.cursor.discoveryInFlightEventId !== null) throw new Error("capacity recovery exact readback failed");
  const hold = readFederalDiscoveryCapacityHold(state.cursor);
  const continuations = readFederalDiscoveryContinuations(state.cursor);
  if (!hold || hold.operationId !== request.operationId || !isDeepStrictEqual(hold, data.hold)
    || Object.keys(continuations).length !== data.pendingSearches
    || state.cursor.afterCompanyId !== data.afterCompanyId || state.cursor.discoveryAttemptsTotal !== data.attemptsTotal
    || rows.some(row => !isDeepStrictEqual(state.cursor.discoveryContinuations[row.companyId], row.continuation))) {
    throw new Error("capacity recovery retained state mismatch");
  }
  const preserved = (cursor: Record<string, unknown>) => Object.fromEntries(Object.entries(cursor).filter(([key]) =>
    !["discoveryContinuations", "discoveryInFlight", "discoveryInFlightEventId", "discoveryCapacityHold"].includes(key)));
  if (!isDeepStrictEqual(preserved(priorState.cursor), preserved(state.cursor))
    || Object.entries(priorState.cursor.discoveryContinuations).some(([id, value]) =>
      !isDeepStrictEqual(value, state.cursor.discoveryContinuations[id]))
    || (priorHold && !isDeepStrictEqual(priorState.cursor, state.cursor))) {
    throw new Error("capacity recovery changed unrelated retained state");
  }
  return { ...data, exactEventVerified: true, exactStateVerified: true };
}
