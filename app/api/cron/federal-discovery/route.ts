import { saveFederalCoverageReceipts } from "@/lib/publicGrowth/federalCoverageStore";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serviceClient } from "@/lib/supabase/server";
import { discoverFederalCompany } from "@/lib/publicGrowth/federalDiscovery";
import { parseFederalDiscoveryContinuation, readFederalDiscoveryContinuations,
  type FederalDiscoveryContinuation } from "@/lib/publicGrowth/federalDiscoveryState";
import {
  applyPublicGrowthRetryOutcomes, beginPublicGrowthSweep, checkpointPublicGrowthSweep,
  completePublicGrowthSweep, failPublicGrowthSweep,
  publicGrowthAfterCompanyId, PublicGrowthSweepBusyError, queuePublicGrowthMainFailures,
  readPublicGrowthRetryState, type PublicGrowthCompanyOutcome, type PublicGrowthSweepLease,
} from "@/lib/publicGrowth/sweepState";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const SOURCE = "federal-discovery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONCURRENCY = 4;
// Change only when the provider request strategy deliberately changes. Old
// strategy records remain history; neither elapsed time nor a release clears them.
const REQUEST_STRATEGY = "name-only-v1";

type ReadbackHold = {
  version: 1;
  status: "unresolved";
  reason: "interrupted_wave_outcome_unknown";
  originalEventId: string;
  companyIds: string[];
  evidenceSha256: string;
  observedAt: string;
  heldAt: string;
};

// Only an explicitly reviewed state transition may create this hold. This route
// never converts a fresh fence into a hold, clears a hold, or resolves its debt.
function readbackHold(cursor: Record<string, unknown>): ReadbackHold | null {
  const raw = cursor.discoveryReadbackHold;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid discovery readback hold");
  const row = raw as ReadbackHold;
  const fields = ["version", "status", "reason", "originalEventId", "companyIds", "evidenceSha256", "observedAt", "heldAt"];
  const canonicalUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v === v.toLowerCase();
  // UTC timestamps retain up to PostgreSQL's six fractional digits; reject
  // rolled-over calendar dates instead of accepting Date.parse normalization.
  const timestampKey = (v: unknown): string | null => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v)) return null;
    const parsed = Date.parse(v);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== v.slice(0, 19)) return null;
    return v.slice(0, 19) + "." + (v.slice(19, -1).replace(/^\./, "")).padEnd(6, "0") + "Z";
  };
  const observed = timestampKey(row.observedAt);
  const held = timestampKey(row.heldAt);
  if (Object.keys(raw).length !== fields.length || Object.keys(raw).some((key) => !fields.includes(key))
      || row.version !== 1 || row.status !== "unresolved" || row.reason !== "interrupted_wave_outcome_unknown"
      || !canonicalUuid(row.originalEventId) || !Array.isArray(row.companyIds)
      || row.companyIds.length < 1 || row.companyIds.length > CONCURRENCY
      || row.companyIds.some((id) => !canonicalUuid(id)) || new Set(row.companyIds).size !== row.companyIds.length
      || typeof row.evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.evidenceSha256)
      || observed === null || held === null || held < observed) {
    throw new Error("invalid discovery readback hold fields");
  }
  return { ...row, companyIds: [...row.companyIds] };
}

type StrategyTimeout = {
  companyId: string;
  strategy: string;
  stage: "award_search" | "award_detail";
  timeoutCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  heldAt: string | null;
  lastResetAt?: string;
};

function strategyTimeouts(cursor: Record<string, unknown>): StrategyTimeout[] {
  const raw = cursor.discoveryStrategyTimeouts === undefined ? [] : cursor.discoveryStrategyTimeouts;
  if (!Array.isArray(raw)) throw new Error("invalid discovery strategy timeout state");
  const keys = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery strategy timeout entry");
    const row = value as StrategyTimeout;
    const timestamp = (v: unknown): v is string => typeof v === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
    if (typeof row.companyId !== "string" || !UUID.test(row.companyId)
        || typeof row.strategy !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.strategy)
        || !["award_search", "award_detail"].includes(row.stage)
        || !Number.isInteger(row.timeoutCount) || row.timeoutCount < 0 || row.timeoutCount > 2
        || !timestamp(row.firstObservedAt) || !timestamp(row.lastObservedAt)
        || Date.parse(row.lastObservedAt) < Date.parse(row.firstObservedAt)
        || (row.lastResetAt !== undefined && !timestamp(row.lastResetAt))
        || (row.timeoutCount === 0 && row.lastResetAt === undefined)
        || (row.timeoutCount < 2 ? row.heldAt !== null : !timestamp(row.heldAt) || row.heldAt !== row.lastObservedAt)) {
      throw new Error("invalid discovery strategy timeout fields");
    }
    const key = `${row.companyId}:${row.strategy}:${row.stage}`;
    if (keys.has(key)) throw new Error("duplicate discovery strategy timeout entry");
    keys.add(key);
    return { ...row };
  });
}

function heldCompanies(rows: StrategyTimeout[]): Set<string> {
  return new Set(rows.filter((row) => row.strategy === REQUEST_STRATEGY && row.heldAt !== null).map((row) => row.companyId));
}

function recordTimeouts(rows: StrategyTimeout[], outcomes: Outcome[], now: string): StrategyTimeout[] {
  const next = rows.map((row) => ({ ...row }));
  for (const outcome of outcomes) {
    if (outcome.status === "no_candidate" || outcome.status === "matched") {
      for (const row of next) {
        if (row.companyId === outcome.companyId && row.strategy === REQUEST_STRATEGY && row.heldAt === null) {
          row.timeoutCount = 0;
          row.lastResetAt = now;
        }
      }
      continue;
    }
    if (outcome.status !== "error" || outcome.reason !== "request_timeout"
        || outcome.mayHaveWritten !== false || !["award_search", "award_detail"].includes(outcome.stage)) continue;
    const stage = outcome.stage as StrategyTimeout["stage"];
    const index = next.findIndex((row) => row.companyId === outcome.companyId && row.strategy === REQUEST_STRATEGY && row.stage === stage);
    if (index < 0) next.push({ companyId: outcome.companyId, strategy: REQUEST_STRATEGY, stage,
      timeoutCount: 1, firstObservedAt: now, lastObservedAt: now, heldAt: null });
    else {
      const prior = next[index];
      if (prior.heldAt !== null) throw new Error("held discovery strategy was attempted");
      const count = prior.timeoutCount + 1;
      next[index] = { ...prior, timeoutCount: count, firstObservedAt: count === 1 ? now : prior.firstObservedAt,
        lastObservedAt: now, heldAt: count === 2 ? now : null };
    }
  }
  return next;
}

function authorized(req: NextRequest) {
  const bearer = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
  return Boolean(supplied && ((process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
    || (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)));
}

type Outcome = {
  companyId: string;
  status: "matched" | "no_candidate" | "in_progress" | "ambiguous" | "error";
  reason: string;
  stage: string;
  elapsedMs: number;
  sourceRequests: number | null;
  verified: boolean;
  historyComplete: false;
  exhaustive: false;
  mayHaveWritten: boolean | null;
  httpStatus?: number | null;
  continuation?: FederalDiscoveryContinuation;
  candidateDecision?: unknown;
};

function debtOutcome(row: Outcome): PublicGrowthCompanyOutcome {
  return row.status === "error" || row.status === "ambiguous"
    ? { companyId: row.companyId, status: "error", error: `${row.stage}:${row.reason}` }
    : { companyId: row.companyId, status: row.status };
}

function counter(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid discovery counter");
  return Number(value);
}

/**
 * A complete, saved no-write retry wave can finish its checkpoint without
 * replaying the provider. Missing/uncertain journals retain the original stop.
 * Restrict this to retries so no main-selection keyset must be reconstructed.
 */
async function resumeJournaledRetrySearch(lease: PublicGrowthSweepLease, hold: ReadbackHold | null) {
  const ids = lease.cursor.discoveryInFlight;
  const eventId = lease.cursor.discoveryInFlightEventId;
  const priorResume = lease.cursor.discoveryLastJournalResume as { eventId?: unknown } | undefined;
  const uncertain = lease.cursor.discoveryUncertainOutcomes;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > CONCURRENCY
      || ids.some((id) => typeof id !== "string" || !UUID.test(id) || id !== id.toLowerCase())
      || new Set(ids).size !== ids.length || typeof eventId !== "string" || !UUID.test(eventId)
      || priorResume?.eventId === eventId
      || (uncertain != null && (!Array.isArray(uncertain) || uncertain.length > 0))) return null;
  const timeouts = strategyTimeouts(lease.cursor);
  const held = new Set([...heldCompanies(timeouts), ...(hold?.companyIds ?? [])].map((id) => id.toLowerCase()));
  const retries = readPublicGrowthRetryState(lease.cursor);
  const planned = ids.map((id) => retries.retryQueue.find((row) => row.companyId === id));
  if (ids.some((id) => held.has(id)) || planned.some((row) => !row)) return null;

  const { data: event, error } = await serviceClient().from("app_events")
    .select("id,module,kind,entity_type,meta").eq("id", eventId).maybeSingle();
  if (error) throw new Error("discovery resume journal read failed");
  const meta = event?.meta;
  const holdSummary = { unresolvedReadbackCompanyIds: hold?.companyIds ?? [],
    unresolvedReadbackCompanies: hold?.companyIds.length ?? 0,
    readbackHoldStatus: hold?.status ?? null, readbackHoldReason: hold?.reason ?? null };
  if (event?.id !== eventId || event.module !== "headhunter" || event.kind !== "federal.discovery.attempts"
      || event.entity_type !== "cron" || !meta || meta.source !== SOURCE || meta.requestStrategy !== REQUEST_STRATEGY
      || meta.coverageVerified !== false || meta.historyComplete !== false
      || !isDeepStrictEqual(meta.newStrategyHeldCompanyIds, [])
      || meta.strategyHoldReason !== "second_identical_request_timeout"
      || meta.heldStrategyCompanies !== heldCompanies(timeouts).size
      || Object.entries(holdSummary).some(([key, value]) => !isDeepStrictEqual(meta[key], value))
      || typeof meta.attemptedAt !== "string" || !Number.isFinite(Date.parse(meta.attemptedAt))
      || Date.parse(meta.attemptedAt) > Date.now()
      || planned.some((row) => Date.parse(row!.lastAttemptedAt) > Date.parse(meta.attemptedAt))
      || !Array.isArray(meta.attemptedCompanies) || meta.attemptedCompanies.length !== ids.length) return null;

  const continuations = readFederalDiscoveryContinuations(lease.cursor);
  const wave: Outcome[] = [];
  for (let index = 0; index < ids.length; index++) {
    const row = meta.attemptedCompanies[index];
    if (!row || row.companyId !== ids[index] || row.status !== "in_progress" || row.stage !== "award_search"
        || !["candidate_search_continues", "searching_contract_vehicles", "next_verified_alias"].includes(row.reason)
        || row.mayHaveWritten !== false || row.verified !== false || row.historyComplete !== false || row.exhaustive !== false
        || row.sourceRequests !== 1 || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
        || (row.httpStatus != null && row.httpStatus !== 200)) return null;
    try { continuations[row.companyId] = parseFederalDiscoveryContinuation(row.continuation, row.companyId); }
    catch { return null; }
    wave.push(row as Outcome);
  }
  const resumedIds = new Set<string>(ids);
  const patch = applyPublicGrowthRetryOutcomes(lease.cursor, planned.filter((row) => row !== undefined),
    wave.map(debtOutcome), meta.attemptedAt).cursorPatch;
  // Shared retry parsing normalizes timestamps/extensions. Unrelated debt and
  // held evidence must retain their exact stored representation on this repair.
  const preserveUnrelated = <T extends { companyId: string }>(key: "retryQueue" | "deadLetters", rows: T[]): T[] => {
    const original = new Map(((lease.cursor[key] ?? []) as T[]).map((row) => [row.companyId, row]));
    return rows.map((row) => !resumedIds.has(row.companyId) && original.has(row.companyId)
      ? structuredClone(original.get(row.companyId)!) : row);
  };
  patch.retryQueue = preserveUnrelated("retryQueue", patch.retryQueue);
  patch.deadLetters = preserveUnrelated("deadLetters", patch.deadLetters);
  const resumedAt = new Date().toISOString();
  const receipt = { source: SOURCE, status: "journaled_retry_search_resumed", checked: 0, mainChecked: 0, retryChecked: 0,
    resumedAttempts: wave.length, resumedJournalId: eventId, resumedCompanyIds: ids,
    sourceRequests: 0, journaledSourceRequests: wave.length, providerReplay: false,
    afterCompanyId: publicGrowthAfterCompanyId(lease.cursor), pendingSearches: Object.keys(continuations).length,
    retryRemaining: patch.retryQueue.length, ...holdSummary,
    historyComplete: false, attemptCycleComplete: false, coverageVerified: false };
  await checkpointPublicGrowthSweep(lease, { ...patch, discoveryContinuations: continuations,
    discoveryInFlight: [], discoveryInFlightEventId: null,
    discoveryAttemptsTotal: counter(lease.cursor.discoveryAttemptsTotal) + wave.length,
    discoveryLastJournalResume: { eventId, companyIds: ids, attemptedAt: meta.attemptedAt, resumedAt },
    lastDiscoveryOutcomes: wave, lastDiscoveryAttemptedAt: meta.attemptedAt, lastDiscoveryReceipt: receipt });
  await completePublicGrowthSweep(lease, { ...receipt, done: false, advanceCursor: false, mode: "retry" });
  return receipt;
}

async function inspectState() {
  try {
    const { data, error } = await serviceClient().from("public_growth_sweep_state")
      .select("cursor,last_started_at,last_succeeded_at,last_error,lease_until").eq("source", SOURCE).maybeSingle();
    if (error) throw new Error("discovery inspection failed");
    const cursor = data ? data.cursor : {};
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error("invalid discovery cursor");
    const retries = readPublicGrowthRetryState(cursor);
    const continuations = readFederalDiscoveryContinuations(cursor);
    const timeouts = strategyTimeouts(cursor);
    const unresolvedHold = readbackHold(cursor);
    const inFlight = cursor.discoveryInFlight ?? [];
    if (!Array.isArray(inFlight) || inFlight.length > CONCURRENCY || inFlight.some((id) => typeof id !== "string" || !UUID.test(id))
        || new Set(inFlight).size !== inFlight.length) throw new Error("invalid discovery in-flight state");
    const safeTimestamp = (value: unknown) => {
      if (value == null) return null;
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
          || !Number.isFinite(Date.parse(value))) throw new Error("invalid discovery timestamp");
      return value;
    };
    const held = [...heldCompanies(timeouts)];
    return NextResponse.json({ source: SOURCE, status: data ? "read_only" : "not_started", readOnly: true,
      requestStrategy: REQUEST_STRATEGY, afterCompanyId: publicGrowthAfterCompanyId(cursor),
      attemptsTotal: counter(cursor.discoveryAttemptsTotal), retryCount: retries.retryQueue.length,
      pendingSearches: Object.keys(continuations).length,
      retryCompanyIds: retries.retryQueue.map((row) => row.companyId),
      unresolvedDeadLetterCount: retries.deadLetters.filter((row) => row.resolvedAt === null).length,
      unresolvedDeadLetterCompanyIds: retries.deadLetters.filter((row) => row.resolvedAt === null).map((row) => row.companyId),
      heldStrategyCompanies: held.length, heldCompanyIds: held,
      unresolvedReadbackCompanyIds: unresolvedHold?.companyIds ?? [],
      unresolvedReadbackCompanies: unresolvedHold?.companyIds.length ?? 0,
      readbackHoldStatus: unresolvedHold?.status ?? null,
      readbackHoldReason: unresolvedHold?.reason ?? null,
      historyComplete: false, attemptCycleComplete: false,
      strategyTimeoutCounts: timeouts.filter((row) => row.strategy === REQUEST_STRATEGY).map((row) => ({
        companyId: row.companyId, stage: row.stage, timeoutCount: row.timeoutCount, heldAt: row.heldAt,
      })),
      inFlightCompanyIds: inFlight, errorPresent: data?.last_error != null,
      lastStartedAt: safeTimestamp(data?.last_started_at), lastSucceededAt: safeTimestamp(data?.last_succeeded_at),
      leaseUntil: safeTimestamp(data?.lease_until), backoffUntil: safeTimestamp(cursor.discoveryBackoffUntil), coverageVerified: false });
  } catch {
    return NextResponse.json({ source: SOURCE, status: "inspection_failed", readOnly: true,
      error: "discovery_state_read_or_validation_failure" }, { status: 500 });
  }
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.has("inspect")) {
    if (url.searchParams.get("inspect") !== "1" || [...url.searchParams.keys()].length !== 1) {
      return NextResponse.json({ error: "Only exclusive inspect=1 is supported" }, { status: 400 });
    }
    return inspectState();
  }
  const limit = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || [...url.searchParams.keys()].some((key) => key !== "limit")) {
    return NextResponse.json({ error: "Only limit=1..20 is supported; discovery always uses its managed cursor" }, { status: 400 });
  }
  let lease: PublicGrowthSweepLease | null = null;
  try {
    lease = await beginPublicGrowthSweep(SOURCE, limit, null);
    const after = publicGrowthAfterCompanyId(lease.cursor);
    const unresolvedHold = readbackHold(lease.cursor);
    const readbackHeld = new Set(unresolvedHold?.companyIds ?? []);
    const backoff = lease.cursor.discoveryBackoffUntil;
    if (backoff !== undefined && backoff !== null && (typeof backoff !== "string" || !Number.isFinite(Date.parse(backoff)))) {
      throw new Error("invalid discovery backoff");
    }
    if (typeof backoff === "string" && Date.parse(backoff) > Date.now()) {
      await failPublicGrowthSweep(lease, new Error("federal_discovery_rate_limit_backoff"));
      return NextResponse.json({ source: SOURCE, status: "rate_limit_backoff", checked: 0, retryAt: backoff, coverageVerified: false },
        { status: 429, headers: { "Retry-After": String(Math.ceil((Date.parse(backoff) - Date.now()) / 1000)) } });
    }
    const inFlight = lease.cursor.discoveryInFlight ?? [];
    if (!Array.isArray(inFlight) || inFlight.length > 0) {
      const resumed = await resumeJournaledRetrySearch(lease, unresolvedHold);
      if (resumed) return NextResponse.json(resumed);
      await failPublicGrowthSweep(lease, new Error("interrupted_discovery_requires_readback"));
      return NextResponse.json({ source: SOURCE, status: "interrupted_attempt_requires_readback", checked: 0, coverageVerified: false }, { status: 409 });
    }
    let timeoutState = strategyTimeouts(lease.cursor);
    const strategyHeldAtStart = new Set([...heldCompanies(timeoutState)].map((id) => id.toLowerCase()));
    const heldAtStart = new Set([...strategyHeldAtStart, ...readbackHeld]);
    const retryState = readPublicGrowthRetryState(lease.cursor);
    let continuations = readFederalDiscoveryContinuations(lease.cursor);
    // A readback hold takes reporting precedence on overlap; category skip
    // counts remain disjoint, while strategy-history totals stay unchanged.
    const heldRetryExcluded = retryState.retryQueue.filter((row) => strategyHeldAtStart.has(row.companyId.toLowerCase()) && !readbackHeld.has(row.companyId.toLowerCase())).length;
    const readbackHeldRetryExcluded = retryState.retryQueue.filter((row) => readbackHeld.has(row.companyId.toLowerCase())).length;
    const failedIds = new Set([...retryState.retryQueue.map((row) => row.companyId),
      ...retryState.deadLetters.filter((row) => row.resolvedAt === null).map((row) => row.companyId)]);
    const pendingIds = Object.keys(continuations).filter((id) => !heldAtStart.has(id.toLowerCase()) && !failedIds.has(id))
      .sort().slice(0, Math.min(CONCURRENCY, limit));
    const retries = retryState.retryQueue.filter((row) => !heldAtStart.has(row.companyId.toLowerCase()))
      .slice(0, Math.min(CONCURRENCY, limit - pendingIds.length));
    const retryIds = new Set(retries.map((row) => row.companyId));
    const mainLimit = limit - retries.length - pendingIds.length;
    const { data, error } = mainLimit > 0
      ? await serviceClient().rpc("list_federal_discovery_tam_batch", { p_limit: mainLimit + 1, p_after_company_id: after })
      : { data: [], error: null };
    if (error) throw new Error("federal discovery selector failed");
    if (!Array.isArray(data) || data.length > mainLimit + 1) throw new Error("invalid discovery selector page");
    const rawIds: string[] = data.map((row) => String(row.id));
    let previous = after;
    for (const id of rawIds) {
      if (!UUID.test(id) || (previous !== null && id <= previous)) throw new Error("discovery selector did not advance exact keyset");
      previous = id;
    }
    const selectedMainIds = rawIds.slice(0, mainLimit);
    const skippedHeldCompanyIds = selectedMainIds.filter((id) => strategyHeldAtStart.has(id) && !readbackHeld.has(id));
    const skippedUncertainCompanyIds = selectedMainIds.filter((id) => readbackHeld.has(id));
    const readbackSummary = {
      unresolvedReadbackCompanyIds: unresolvedHold?.companyIds ?? [],
      unresolvedReadbackCompanies: readbackHeld.size,
      readbackHoldStatus: unresolvedHold?.status ?? null,
      readbackHoldReason: unresolvedHold?.reason ?? null,
      readbackHeldRetryExcluded, skippedUncertainCompanyIds,
      skippedUncertainCount: skippedUncertainCompanyIds.length, skippedUncertainAreAttempts: false,
    };
    const mainIds = selectedMainIds.filter((id) => !retryIds.has(id) && !pendingIds.includes(id) && !heldAtStart.has(id));
    const planned = [...pendingIds, ...retries.map((row) => row.companyId), ...mainIds];
    const deadlineMs = Date.now() + 240_000;
    const outcomes: Outcome[] = [];
    const attempted = new Set<string>();
    const initialTotal = counter(lease.cursor.discoveryAttemptsTotal);
    let nextAfter = after;
    let rateLimited = false;
    let backoffUntil: string | null = null;
    const advanceSelectedPrefix = () => {
      for (const id of selectedMainIds) {
        // Held skips are explicitly recorded and never counted as attempts.
        if (!attempted.has(id) && !heldAtStart.has(id)) break;
        nextAfter = id;
      }
    };
    for (let start = 0; start < planned.length && Date.now() < deadlineMs; start += CONCURRENCY) {
      const ids = planned.slice(start, start + CONCURRENCY);
      const eventId = randomUUID();
      await checkpointPublicGrowthSweep(lease, { discoveryInFlight: ids, discoveryInFlightEventId: eventId });
      const returned = await Promise.all(ids.map(async (id): Promise<Outcome | null> => {
        if (Date.now() >= deadlineMs) return null;
        try {
          const row = await discoverFederalCompany(id, { deadlineMs: Math.min(deadlineMs, Date.now() + 60_000),
            ...(continuations[id] ? { continuation: continuations[id] } : {}) });
          if (row.companyId !== id || !["matched", "no_candidate", "in_progress", "ambiguous", "error"].includes(row.status)
              || typeof row.mayHaveWritten !== "boolean") {
            throw new Error("invalid exact discovery outcome");
          }
          if (row.continuation) parseFederalDiscoveryContinuation(row.continuation, id);
          if (row.status === "in_progress" && (!row.continuation || row.mayHaveWritten)) throw new Error("invalid pending discovery outcome");
          return row;
        } catch {
          return { companyId: id, status: "error", reason: "worker_exception", stage: "worker", elapsedMs: 0,
            sourceRequests: null, verified: false, historyComplete: false, exhaustive: false, mayHaveWritten: null };
        }
      }));
      const wave = returned.filter((row): row is Outcome => row !== null);
      const observedAt = new Date().toISOString();
      const nextTimeoutState = recordTimeouts(timeoutState, wave, observedAt);
      const newlyHeldCompanyIds = [...heldCompanies(nextTimeoutState)].filter((id) => !heldCompanies(timeoutState).has(id));
      if (wave.length) {
        // Unlike best-effort logEvent, this exact attempt journal is required
        // before advancing. An uncertain insert retains the in-flight fence.
        const meta = { source: SOURCE, requestStrategy: REQUEST_STRATEGY, attemptedCompanies: wave, attemptedAt: observedAt,
          newStrategyHeldCompanyIds: newlyHeldCompanyIds, strategyHoldReason: "second_identical_request_timeout",
          heldStrategyCompanies: heldCompanies(nextTimeoutState).size,
          skippedHeldCount: skippedHeldCompanyIds.length, ...readbackSummary,
          coverageVerified: false, historyComplete: false };
        const { data: event, error: eventError } = await serviceClient().from("app_events").insert({
          id: eventId, module: "headhunter", kind: "federal.discovery.attempts", entity_type: "cron",
          summary: `Federal discovery: ${wave.length} bounded company attempts`, meta,
        }).select("id,meta").single();
        // JSONB preserves values and array order, but not object key order.
        // Compare the exact nested continuation structurally after readback.
        const signature = (rows: Outcome[]) => rows.map((row) => [row.companyId, row.status,
          row.reason, row.stage, row.sourceRequests, row.elapsedMs, row.verified, row.historyComplete, row.exhaustive,
          row.httpStatus ?? null, row.mayHaveWritten, row.continuation ?? null, row.candidateDecision ?? null]);
        if (eventError || event?.id !== eventId || !Array.isArray(event.meta?.attemptedCompanies)
            || event.meta.coverageVerified !== false || event.meta.historyComplete !== false || event.meta.requestStrategy !== REQUEST_STRATEGY
            || JSON.stringify(event.meta.newStrategyHeldCompanyIds) !== JSON.stringify(newlyHeldCompanyIds)
            || event.meta.strategyHoldReason !== meta.strategyHoldReason || event.meta.heldStrategyCompanies !== meta.heldStrategyCompanies
            || event.meta.skippedHeldCount !== meta.skippedHeldCount
            || Object.entries(readbackSummary).some(([key, value]) => JSON.stringify(event.meta[key]) !== JSON.stringify(value))
            || !isDeepStrictEqual(signature(event.meta.attemptedCompanies), signature(wave))) {
          throw new Error("discovery attempt journal not verified");
        }
      }
      const uncertain = wave.filter((row) => row.status !== "matched" && row.mayHaveWritten !== false);
      if (uncertain.length) {
        await checkpointPublicGrowthSweep(lease, { discoveryUncertainOutcomes: uncertain,
          discoveryReconciliationReason: "enrollment_write_requires_readback",
          lastDiscoveryOutcomes: [...outcomes, ...wave], discoveryAttemptsTotal: initialTotal + outcomes.length + wave.length });
        await failPublicGrowthSweep(lease, new Error("discovery_enrollment_write_requires_readback"));
        return NextResponse.json({ source: SOURCE, status: "enrollment_write_requires_readback", checked: outcomes.length + wave.length,
          uncertainCompanyIds: uncertain.map((row) => row.companyId), outcomes: [...outcomes, ...wave],
          afterCompanyId: nextAfter, ...readbackSummary, coverageVerified: false, historyComplete: false }, { status: 409 });
      }
      outcomes.push(...wave);
      for (const row of wave) attempted.add(row.companyId);
      const nextContinuations = { ...continuations };
      for (const row of wave) {
        if (row.continuation) nextContinuations[row.companyId] = row.continuation;
        else if (row.status === "matched" || row.status === "no_candidate") delete nextContinuations[row.companyId];
      }
      readFederalDiscoveryContinuations({ discoveryContinuations: nextContinuations });
      // Only journal-verified, known-no-write outcomes contribute. Legacy retry
      // counters mix failure types and never seed this strategy-specific count.
      timeoutState = nextTimeoutState;
      // A prefix advances only in the same fenced write that saves exact debt.
      const retryWave = retries.filter((entry) => wave.some((row) => row.companyId === entry.companyId));
      let patch: Record<string, unknown> = {};
      if (retryWave.length) patch = applyPublicGrowthRetryOutcomes(lease.cursor, retryWave,
        wave.filter((row) => retryIds.has(row.companyId)).map(debtOutcome)).cursorPatch;
      const mainWave = wave.filter((row) => !retryIds.has(row.companyId)).map(debtOutcome);
      if (mainWave.length) patch = queuePublicGrowthMainFailures({ ...lease.cursor, ...patch }, mainWave,
        mainWave.filter((row) => row.status === "error").length).cursorPatch;
      // Shared retry parsers normalize dates and drop extension fields. Held
      // rows have no new outcome: preserve their exact original evidence even
      // when an unrelated retry/main outcome rewrites the same arrays.
      for (const key of ["retryQueue", "deadLetters"] as const) {
        if (patch[key] === undefined) continue;
        const priorRows = (lease.cursor[key] ?? []) as { companyId: string }[];
        const heldRows = priorRows.filter((row) => heldAtStart.has(String(row.companyId).toLowerCase()));
        const nextRows = patch[key] as { companyId: string }[];
        for (const held of heldRows) {
          const positions = nextRows.flatMap((row, index) => row.companyId === held.companyId ? [index] : []);
          if (positions.length !== 1) throw new Error("held discovery debt changed unexpectedly");
          nextRows[positions[0]] = structuredClone(held);
        }
      }
      advanceSelectedPrefix();
      rateLimited = wave.some((row) => row.httpStatus === 429);
      if (rateLimited) {
        const streak = counter(lease.cursor.discoveryRateLimitStreak) + 1;
        backoffUntil = new Date(Date.now() + Math.min(3600, 900 * 2 ** Math.min(streak - 1, 2)) * 1000).toISOString();
        patch.discoveryRateLimitStreak = streak;
      }
      await checkpointPublicGrowthSweep(lease, { ...patch, afterCompanyId: nextAfter, discoveryInFlight: [], discoveryInFlightEventId: null,
        discoveryContinuations: nextContinuations,
        discoveryStrategyTimeouts: timeoutState, discoverySkippedHeldCompanyIds: skippedHeldCompanyIds,
        discoverySkippedUncertainCompanyIds: skippedUncertainCompanyIds,
        discoveryRequestStrategy: REQUEST_STRATEGY,
        discoveryAttemptsTotal: initialTotal + outcomes.length, discoveryBackoffUntil: backoffUntil,
        lastDiscoveryOutcomes: outcomes, lastDiscoveryAttemptedAt: new Date().toISOString() });
      continuations = nextContinuations;
      if (rateLimited) break;
    }
    if (outcomes.length === 0 && (skippedHeldCompanyIds.length > 0 || skippedUncertainCompanyIds.length > 0)) {
      advanceSelectedPrefix();
      // An all-held page has no provider work or attempt journal. Persist the
      // exact skipped IDs atomically with traversal, preserving all failure debt.
      await checkpointPublicGrowthSweep(lease, { afterCompanyId: nextAfter,
        discoverySkippedHeldCompanyIds: skippedHeldCompanyIds,
        discoverySkippedUncertainCompanyIds: skippedUncertainCompanyIds, discoveryRequestStrategy: REQUEST_STRATEGY });
    }
    const remaining = planned.filter((id) => !attempted.has(id));
    const selectionCycleComplete = mainLimit > 0 && rawIds.length <= mainLimit
      && rawIds.every((id) => attempted.has(id) || heldAtStart.has(id));
    const heldStrategyCompanies = heldCompanies(timeoutState).size;
    const attemptCycleComplete = selectionCycleComplete && heldStrategyCompanies === 0 && readbackHeld.size === 0
      && Object.keys(continuations).length === 0;
    const state = readPublicGrowthRetryState(lease.cursor);
    const receipt = { source: SOURCE, checked: outcomes.length, matched: outcomes.filter((x) => x.status === "matched").length,
      noCandidate: outcomes.filter((x) => x.status === "no_candidate").length, ambiguous: outcomes.filter((x) => x.status === "ambiguous").length,
      errors: outcomes.filter((x) => x.status === "error").length,
      inProgress: outcomes.filter((x) => x.status === "in_progress").length, pendingSearches: Object.keys(continuations).length,
      sourceRequests: outcomes.some((x) => x.sourceRequests === null) ? null : outcomes.reduce((n, x) => n + (x.sourceRequests ?? 0), 0),
      mainChecked: outcomes.filter((x) => !retryIds.has(x.companyId)).length, retryChecked: outcomes.filter((x) => retryIds.has(x.companyId)).length,
      attemptCycleComplete, selectionCycleComplete, afterCompanyId: selectionCycleComplete ? null : nextAfter, notAttemptedCompanyIds: remaining,
      requestStrategy: REQUEST_STRATEGY, heldStrategyCompanies, heldRetryExcluded, skippedHeldCompanyIds, ...readbackSummary,
      strategyHoldReason: "second_identical_request_timeout",
      skippedHeldCount: skippedHeldCompanyIds.length, skippedHeldAreAttempts: false,
      retryRemaining: state.retryQueue.length, unresolvedDeadLetters: state.deadLetters.filter((x) => x.resolvedAt === null).length,
      outcomes, rateLimited, backoffUntil, coverageVerified: false, historyComplete: false,
      reason: rateLimited ? "provider_rate_limited" : remaining.length ? "runtime_budget"
        : readbackHeld.size ? "bounded_selection_finished_with_unresolved_readback_holds"
        : skippedHeldCompanyIds.length ? "bounded_selection_finished_with_strategy_holds" : "bounded_attempts_finished" };
    await saveFederalCoverageReceipts("federal-discovery", outcomes);
    await completePublicGrowthSweep(lease, { ...receipt, done: attemptCycleComplete, advanceCursor: false, mode: "main+retry",
      cursorPatch: { afterCompanyId: receipt.afterCompanyId, lastDiscoveryReceipt: receipt,
        ...(!rateLimited && outcomes.length ? { discoveryRateLimitStreak: 0 } : {}) } });
    return NextResponse.json(receipt, rateLimited ? { status: 429,
      headers: { "Retry-After": String(Math.max(1, Math.ceil((Date.parse(backoffUntil!) - Date.now()) / 1000))) } } : undefined);
  } catch (error) {
    if (error instanceof PublicGrowthSweepBusyError) {
      return NextResponse.json({ source: SOURCE, status: "busy", retryAt: error.retryAt, checked: 0 }, { status: 409 });
    }
    if (lease) await failPublicGrowthSweep(lease, new Error("federal_discovery_state_or_checkpoint_failure")).catch(() => false);
    return NextResponse.json({ source: SOURCE, status: "failed", error: "discovery_state_or_checkpoint_failure", coverageVerified: false }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
