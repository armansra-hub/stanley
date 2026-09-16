import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { discoverFederalCompany } from "@/lib/publicGrowth/federalDiscovery";
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
  status: "matched" | "no_candidate" | "ambiguous" | "error";
  reason: string;
  stage: string;
  elapsedMs: number;
  sourceRequests: number | null;
  verified: boolean;
  historyComplete: false;
  exhaustive: false;
  mayHaveWritten: boolean | null;
  httpStatus?: number | null;
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

async function inspectState() {
  try {
    const { data, error } = await serviceClient().from("public_growth_sweep_state")
      .select("cursor,last_started_at,last_succeeded_at,last_error,lease_until").eq("source", SOURCE).maybeSingle();
    if (error) throw new Error("discovery inspection failed");
    const cursor = data ? data.cursor : {};
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error("invalid discovery cursor");
    const retries = readPublicGrowthRetryState(cursor);
    const timeouts = strategyTimeouts(cursor);
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
      retryCompanyIds: retries.retryQueue.map((row) => row.companyId),
      unresolvedDeadLetterCount: retries.deadLetters.filter((row) => row.resolvedAt === null).length,
      unresolvedDeadLetterCompanyIds: retries.deadLetters.filter((row) => row.resolvedAt === null).map((row) => row.companyId),
      heldStrategyCompanies: held.length, heldCompanyIds: held,
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
      await failPublicGrowthSweep(lease, new Error("interrupted_discovery_requires_readback"));
      return NextResponse.json({ source: SOURCE, status: "interrupted_attempt_requires_readback", checked: 0, coverageVerified: false }, { status: 409 });
    }
    let timeoutState = strategyTimeouts(lease.cursor);
    const heldAtStart = heldCompanies(timeoutState);
    const retryState = readPublicGrowthRetryState(lease.cursor);
    const heldRetryExcluded = retryState.retryQueue.filter((row) => heldAtStart.has(row.companyId)).length;
    const retries = retryState.retryQueue.filter((row) => !heldAtStart.has(row.companyId)).slice(0, Math.min(CONCURRENCY, limit));
    const retryIds = new Set(retries.map((row) => row.companyId));
    const mainLimit = limit - retries.length;
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
    const skippedHeldCompanyIds = selectedMainIds.filter((id) => heldAtStart.has(id));
    const mainIds = selectedMainIds.filter((id) => !retryIds.has(id) && !heldAtStart.has(id));
    const planned = [...retries.map((row) => row.companyId), ...mainIds];
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
          const row = await discoverFederalCompany(id, { deadlineMs: Math.min(deadlineMs, Date.now() + 60_000) });
          if (row.companyId !== id || !["matched", "no_candidate", "ambiguous", "error"].includes(row.status)
              || typeof row.mayHaveWritten !== "boolean") {
            throw new Error("invalid exact discovery outcome");
          }
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
          skippedHeldCount: skippedHeldCompanyIds.length,
          coverageVerified: false, historyComplete: false };
        const { data: event, error: eventError } = await serviceClient().from("app_events").insert({
          id: eventId, module: "headhunter", kind: "federal.discovery.attempts", entity_type: "cron",
          summary: `Federal discovery: ${wave.length} bounded company attempts`, meta,
        }).select("id,meta").single();
        const signature = (rows: Outcome[]) => JSON.stringify(rows.map((row) => [row.companyId, row.status,
          row.reason, row.stage, row.sourceRequests, row.elapsedMs, row.verified, row.historyComplete, row.exhaustive,
          row.httpStatus ?? null, row.mayHaveWritten]));
        if (eventError || event?.id !== eventId || !Array.isArray(event.meta?.attemptedCompanies)
            || event.meta.coverageVerified !== false || event.meta.historyComplete !== false || event.meta.requestStrategy !== REQUEST_STRATEGY
            || JSON.stringify(event.meta.newStrategyHeldCompanyIds) !== JSON.stringify(newlyHeldCompanyIds)
            || event.meta.strategyHoldReason !== meta.strategyHoldReason || event.meta.heldStrategyCompanies !== meta.heldStrategyCompanies
            || event.meta.skippedHeldCount !== meta.skippedHeldCount
            || signature(event.meta.attemptedCompanies) !== signature(wave)) {
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
          afterCompanyId: nextAfter, coverageVerified: false, historyComplete: false }, { status: 409 });
      }
      outcomes.push(...wave);
      for (const row of wave) attempted.add(row.companyId);
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
      advanceSelectedPrefix();
      rateLimited = wave.some((row) => row.httpStatus === 429);
      if (rateLimited) {
        const streak = counter(lease.cursor.discoveryRateLimitStreak) + 1;
        backoffUntil = new Date(Date.now() + Math.min(3600, 900 * 2 ** Math.min(streak - 1, 2)) * 1000).toISOString();
        patch.discoveryRateLimitStreak = streak;
      }
      await checkpointPublicGrowthSweep(lease, { ...patch, afterCompanyId: nextAfter, discoveryInFlight: [], discoveryInFlightEventId: null,
        discoveryStrategyTimeouts: timeoutState, discoverySkippedHeldCompanyIds: skippedHeldCompanyIds,
        discoveryRequestStrategy: REQUEST_STRATEGY,
        discoveryAttemptsTotal: initialTotal + outcomes.length, discoveryBackoffUntil: backoffUntil,
        lastDiscoveryOutcomes: outcomes, lastDiscoveryAttemptedAt: new Date().toISOString() });
      if (rateLimited) break;
    }
    if (outcomes.length === 0 && skippedHeldCompanyIds.length > 0) {
      advanceSelectedPrefix();
      // An all-held page has no provider work or attempt journal. Persist the
      // exact skipped IDs atomically with traversal, preserving all failure debt.
      await checkpointPublicGrowthSweep(lease, { afterCompanyId: nextAfter,
        discoverySkippedHeldCompanyIds: skippedHeldCompanyIds, discoveryRequestStrategy: REQUEST_STRATEGY });
    }
    const remaining = planned.filter((id) => !attempted.has(id));
    const selectionCycleComplete = mainLimit > 0 && rawIds.length <= mainLimit
      && rawIds.every((id) => attempted.has(id) || heldAtStart.has(id));
    const heldStrategyCompanies = heldCompanies(timeoutState).size;
    const attemptCycleComplete = selectionCycleComplete && heldStrategyCompanies === 0;
    const state = readPublicGrowthRetryState(lease.cursor);
    const receipt = { source: SOURCE, checked: outcomes.length, matched: outcomes.filter((x) => x.status === "matched").length,
      noCandidate: outcomes.filter((x) => x.status === "no_candidate").length, ambiguous: outcomes.filter((x) => x.status === "ambiguous").length,
      errors: outcomes.filter((x) => x.status === "error").length,
      sourceRequests: outcomes.some((x) => x.sourceRequests === null) ? null : outcomes.reduce((n, x) => n + (x.sourceRequests ?? 0), 0),
      mainChecked: outcomes.filter((x) => !retryIds.has(x.companyId)).length, retryChecked: outcomes.filter((x) => retryIds.has(x.companyId)).length,
      attemptCycleComplete, selectionCycleComplete, afterCompanyId: selectionCycleComplete ? null : nextAfter, notAttemptedCompanyIds: remaining,
      requestStrategy: REQUEST_STRATEGY, heldStrategyCompanies, heldRetryExcluded, skippedHeldCompanyIds,
      strategyHoldReason: "second_identical_request_timeout",
      skippedHeldCount: skippedHeldCompanyIds.length, skippedHeldAreAttempts: false,
      retryRemaining: state.retryQueue.length, unresolvedDeadLetters: state.deadLetters.filter((x) => x.resolvedAt === null).length,
      outcomes, rateLimited, backoffUntil, coverageVerified: false, historyComplete: false,
      reason: rateLimited ? "provider_rate_limited" : remaining.length ? "runtime_budget"
        : skippedHeldCompanyIds.length ? "bounded_selection_finished_with_strategy_holds" : "bounded_attempts_finished" };
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
