import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { discoverFederalCompany } from "@/lib/publicGrowth/federalDiscovery";
import {
  applyPublicGrowthRetryOutcomes, beginPublicGrowthSweep, checkpointPublicGrowthSweep,
  completePublicGrowthSweep, failPublicGrowthSweep, pendingPublicGrowthRetries,
  publicGrowthAfterCompanyId, PublicGrowthSweepBusyError, queuePublicGrowthMainFailures,
  readPublicGrowthRetryState, type PublicGrowthCompanyOutcome, type PublicGrowthSweepLease,
} from "@/lib/publicGrowth/sweepState";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const SOURCE = "federal-discovery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONCURRENCY = 4;

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

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
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
    const retries = pendingPublicGrowthRetries(lease.cursor, Math.min(CONCURRENCY, limit));
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
    const mainIds = rawIds.slice(0, mainLimit).filter((id) => !retryIds.has(id));
    const planned = [...retries.map((row) => row.companyId), ...mainIds];
    const deadlineMs = Date.now() + 240_000;
    const outcomes: Outcome[] = [];
    const attempted = new Set<string>();
    const initialTotal = counter(lease.cursor.discoveryAttemptsTotal);
    let nextAfter = after;
    let rateLimited = false;
    let backoffUntil: string | null = null;
    let attemptCycleComplete = false;
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
      if (wave.length) {
        // Unlike best-effort logEvent, this exact attempt journal is required
        // before advancing. An uncertain insert retains the in-flight fence.
        const meta = { source: SOURCE, attemptedCompanies: wave, attemptedAt: new Date().toISOString(),
          coverageVerified: false, historyComplete: false };
        const { data: event, error: eventError } = await serviceClient().from("app_events").insert({
          id: eventId, module: "headhunter", kind: "federal.discovery.attempts", entity_type: "cron",
          summary: `Federal discovery: ${wave.length} bounded company attempts`, meta,
        }).select("id,meta").single();
        const signature = (rows: Outcome[]) => JSON.stringify(rows.map((row) => [row.companyId, row.status,
          row.reason, row.stage, row.sourceRequests, row.elapsedMs, row.verified, row.historyComplete, row.exhaustive,
          row.httpStatus ?? null, row.mayHaveWritten]));
        if (eventError || event?.id !== eventId || !Array.isArray(event.meta?.attemptedCompanies)
            || event.meta.coverageVerified !== false || event.meta.historyComplete !== false
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
      // A prefix advances only in the same fenced write that saves exact debt.
      const retryWave = retries.filter((entry) => wave.some((row) => row.companyId === entry.companyId));
      let patch: Record<string, unknown> = {};
      if (retryWave.length) patch = applyPublicGrowthRetryOutcomes(lease.cursor, retryWave,
        wave.filter((row) => retryIds.has(row.companyId)).map(debtOutcome)).cursorPatch;
      const mainWave = wave.filter((row) => !retryIds.has(row.companyId)).map(debtOutcome);
      if (mainWave.length) patch = queuePublicGrowthMainFailures({ ...lease.cursor, ...patch }, mainWave,
        mainWave.filter((row) => row.status === "error").length).cursorPatch;
      for (const id of rawIds.slice(0, mainLimit)) {
        if (!attempted.has(id)) break;
        nextAfter = id;
      }
      rateLimited = wave.some((row) => row.httpStatus === 429);
      if (rateLimited) {
        const streak = counter(lease.cursor.discoveryRateLimitStreak) + 1;
        backoffUntil = new Date(Date.now() + Math.min(3600, 900 * 2 ** Math.min(streak - 1, 2)) * 1000).toISOString();
        patch.discoveryRateLimitStreak = streak;
      }
      await checkpointPublicGrowthSweep(lease, { ...patch, afterCompanyId: nextAfter, discoveryInFlight: [], discoveryInFlightEventId: null,
        discoveryAttemptsTotal: initialTotal + outcomes.length, discoveryBackoffUntil: backoffUntil,
        lastDiscoveryOutcomes: outcomes, lastDiscoveryAttemptedAt: new Date().toISOString() });
      if (rateLimited) break;
    }
    const remaining = planned.filter((id) => !attempted.has(id));
    attemptCycleComplete = mainLimit > 0 && rawIds.length <= mainLimit && rawIds.every((id) => attempted.has(id));
    const state = readPublicGrowthRetryState(lease.cursor);
    const receipt = { source: SOURCE, checked: outcomes.length, matched: outcomes.filter((x) => x.status === "matched").length,
      noCandidate: outcomes.filter((x) => x.status === "no_candidate").length, ambiguous: outcomes.filter((x) => x.status === "ambiguous").length,
      errors: outcomes.filter((x) => x.status === "error").length,
      sourceRequests: outcomes.some((x) => x.sourceRequests === null) ? null : outcomes.reduce((n, x) => n + (x.sourceRequests ?? 0), 0),
      mainChecked: outcomes.filter((x) => !retryIds.has(x.companyId)).length, retryChecked: outcomes.filter((x) => retryIds.has(x.companyId)).length,
      attemptCycleComplete, afterCompanyId: attemptCycleComplete ? null : nextAfter, notAttemptedCompanyIds: remaining,
      retryRemaining: state.retryQueue.length, unresolvedDeadLetters: state.deadLetters.filter((x) => x.resolvedAt === null).length,
      outcomes, rateLimited, backoffUntil, coverageVerified: false, historyComplete: false,
      reason: rateLimited ? "provider_rate_limited" : remaining.length ? "runtime_budget" : "bounded_attempts_finished" };
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
