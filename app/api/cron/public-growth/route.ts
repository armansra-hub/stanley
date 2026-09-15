import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";
import {
  loadTamCompaniesByIds,
  sweepUsaspendingCompanySteps,
  sweepUsaspendingSubawardsCompany,
  sweepUsaspendingSubawardsTamBatch,
  sweepUsaspendingTamBatch,
} from "@/lib/publicGrowth/usaspendingSweep";
import { sweepSamCompany, sweepSamTamBatch } from "@/lib/publicGrowth/samSweep";
import { sweepRevenueTamBatch } from "@/lib/publicGrowth/revenueSweep";
import { sweepSamOpportunities } from "@/lib/publicGrowth/opportunitySweep";
import {
  applyPublicGrowthRetryOutcomes,
  beginPublicGrowthCompanyRecoverySweep,
  beginPublicGrowthRecoverySweep,
  beginPublicGrowthSweep,
  completePublicGrowthSweep,
  checkpointPublicGrowthSweep,
  failPublicGrowthSweep,
  inspectPublicGrowthCompanyRecovery,
  pendingPublicGrowthRetries,
  publicGrowthAfterCompanyId,
  PublicGrowthSweepBusyError,
  PublicGrowthSweepLeaseLostError,
  queuePublicGrowthMainFailures,
  shouldServicePublicGrowthRetry,
  type PublicGrowthCompanyOutcome,
  type PublicGrowthRetryEntry,
  type PublicGrowthSweepLease,
  type PublicGrowthSweepResult,
} from "@/lib/publicGrowth/sweepState";
import type { TamIdentity } from "@/lib/publicGrowth/types";

export const dynamic = "force-dynamic";
// Award-heavy incumbents can have hundreds of awards and thousands of
// transactions. Keep the ordinary batches small, but allow one exact company
// enough time to persist its complete history instead of failing at 60 seconds.
export const maxDuration = 300;

function authorized(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(supplied && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
  ));
}

type CompanyScopedSource = "usaspending" | "usaspending-subawards" | "sam-entity";
type RetryReceipt = PublicGrowthCompanyOutcome & Record<string, unknown>;

async function runCompanyRetryBatch(
  source: CompanyScopedSource,
  lease: PublicGrowthSweepLease,
  planned: PublicGrowthRetryEntry[],
  deadlineMs?: number,
) {
  const companies = await loadTamCompaniesByIds(planned.map((entry) => entry.companyId));
  const byId = new Map(companies.map((company) => [company.id, company]));
  const receipts: RetryReceipt[] = [];
  const attempted: PublicGrowthRetryEntry[] = [];
  for (const entry of planned) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) break;
    attempted.push(entry);
    const company = byId.get(entry.companyId);
    if (!company) {
      receipts.push({ companyId: entry.companyId, status: "no_longer_current", triggers: 0 });
      continue;
    }
    try {
      const receipt = source === "sam-entity"
        ? await sweepSamCompany(company)
        : source === "usaspending-subawards"
          ? await sweepUsaspendingSubawardsCompany(company, { subawardContinuation: entry.subawardContinuation, deadlineMs })
          : await sweepUsaspendingCompanySteps(company, {
            ...(entry.awardContinuation == null ? {} : { awardContinuation: entry.awardContinuation }),
            deadlineMs,
          }, 3);
      receipts.push(receipt as RetryReceipt);
    } catch (error) {
      receipts.push({
        companyId: entry.companyId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        triggers: 0,
      });
    }
  }
  const retry = applyPublicGrowthRetryOutcomes(lease.cursor, attempted, receipts);
  return {
    source,
    offset: lease.offset,
    checked: attempted.length,
    nextOffset: lease.offset,
    done: false,
    matched: receipts.filter((receipt) => receipt.status === "matched" || receipt.status === "linked").length,
    errors: retry.errors,
    triggers: receipts.reduce((sum, receipt) => sum + Number(receipt.triggers ?? 0), 0),
    receipts,
    retryDeadLettered: retry.deadLettered,
    retryRemaining: retry.cursorPatch.retryQueue.length,
    cursorPatch: retry.cursorPatch,
    advanceCursor: false,
    mode: "retry" as const,
  };
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url), source = url.searchParams.get("source") ?? "usaspending";
  const n = Math.min(Math.max(Number(url.searchParams.get("n") ?? 2) || 2, 1), 125);
  const explicitOffset = url.searchParams.has("offset")
    ? Math.max(Number(url.searchParams.get("offset")) || 0, 0)
    : null;
  const exactRecoveryId = url.searchParams.get("companyId")?.toLowerCase() ?? null;
  const inspectOnly = url.searchParams.get("inspect") === "1";
  if (url.searchParams.has("inspect") && (!inspectOnly || exactRecoveryId == null)) {
    return NextResponse.json({ error: "inspect=1 requires an exact companyId" }, { status: 400 });
  }
  if (url.searchParams.has("awardOffset") || url.searchParams.has("awardLimit")) {
    return NextResponse.json({ error: "numeric award continuation is no longer supported" }, { status: 400 });
  }
  if (!new Set(["usaspending", "usaspending-subawards", "sam-entity", "sam-opportunities", "revenue"]).has(source)) return NextResponse.json({ error: `unsupported source ${source}` }, { status: 400 });
  if (exactRecoveryId != null && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(exactRecoveryId)
    || !["usaspending", "usaspending-subawards"].includes(source)
    || explicitOffset != null || (url.searchParams.has("n") && n !== 1))) {
    return NextResponse.json({ error: "exact foundation requires one valid companyId, an award source, and no offset" }, { status: 400 });
  }
  const companyScopedSource = new Set(["usaspending", "usaspending-subawards", "sam-entity"]).has(source);
  if (source === "sam-opportunities" && explicitOffset != null) {
    return NextResponse.json({ error: "SAM opportunities requires its managed source checkpoint; legacy offsets are not supported" }, { status: 400 });
  }
  const requestedScope = url.searchParams.get("scope");
  if (requestedScope != null && requestedScope !== "verified" && requestedScope !== "tam") {
    return NextResponse.json({ error: "scope must be verified or tam" }, { status: 400 });
  }
  if (!companyScopedSource && requestedScope != null) {
    return NextResponse.json({ error: `scope is not supported for ${source}` }, { status: 400 });
  }
  const companyScope = (requestedScope ?? (explicitOffset == null && exactRecoveryId == null ? "verified" : "tam")) as "verified" | "tam";
  if (exactRecoveryId != null && companyScope !== "tam") return NextResponse.json({ error: "exact foundation requires scope=tam" }, { status: 400 });
  if (companyScopedSource && companyScope === "tam" && explicitOffset == null && exactRecoveryId == null) {
    return NextResponse.json({ error: "full-TAM public-growth sweeps require an explicit offset" }, { status: 400 });
  }
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 31) || 31));
  const opportunityLimit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));
  const revenueLimit = Math.min(4000, Math.max(n, Number(url.searchParams.get("limit") ?? 250) || 250));
  const batchSize = exactRecoveryId != null ? 1 : source === "sam-opportunities" ? opportunityLimit : source === "revenue" ? revenueLimit : n;
  const durableUsaspendingRecovery = source === "usaspending" && explicitOffset != null;
  const durableRecovery = durableUsaspendingRecovery || exactRecoveryId != null;
  let exactCompany: TamIdentity | null = null;
  if (exactRecoveryId != null) {
    try {
      const rows = await loadTamCompaniesByIds([exactRecoveryId]);
      exactCompany = rows.find((row) => row.id === exactRecoveryId) ?? null;
      if (!exactCompany) return NextResponse.json({ error: "company_not_current_tam", companyId: exactRecoveryId }, { status: 404 });
      if (inspectOnly) return NextResponse.json(await inspectPublicGrowthCompanyRecovery(source as "usaspending" | "usaspending-subawards", exactRecoveryId));
    } catch {
      return NextResponse.json({ error: "exact_company_load_failed" }, { status: 500 });
    }
  }
  let lease: Awaited<ReturnType<typeof beginPublicGrowthSweep>>;
  try {
    lease = exactRecoveryId != null
      ? await beginPublicGrowthCompanyRecoverySweep(source as "usaspending" | "usaspending-subawards", exactRecoveryId)
      : durableUsaspendingRecovery
      ? await beginPublicGrowthRecoverySweep(source, batchSize, explicitOffset)
      : await beginPublicGrowthSweep(source, batchSize, explicitOffset);
  } catch (error) {
    if (error instanceof PublicGrowthSweepBusyError) {
      const retryAtMs = error.retryAt ? new Date(error.retryAt).getTime() : Number.NaN;
      const retrySeconds = Number.isFinite(retryAtMs)
        ? Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))
        : 60;
      return NextResponse.json({
        error: "source_busy",
        source,
        retryAt: error.retryAt,
      }, { status: 409, headers: { "Retry-After": String(retrySeconds) } });
    }
    console.error("public-growth lease acquisition failed", { source, error });
    return NextResponse.json({
      error: "lease_acquire_failed",
      source,
    }, { status: 500 });
  }
  const offset = lease.offset;
  const sourceDeadlineMs = Date.now() + 240_000;
  let afterCompanyId: string | null;
  try {
    afterCompanyId = companyScopedSource ? publicGrowthAfterCompanyId(lease.cursor) : null;
    // A bounded USAspending company step still includes identity, award detail,
    // transaction-page, and persistence calls. Retry one exact continuation per
    // request while the main freshness page advances independently below.
    const retryLimit = source === "usaspending" || durableRecovery ? 1 : Math.min(10, n);
    const usaspendingCompanyLimit = lease.managed && source === "usaspending" ? Math.min(6, n) : n;
    const retryPlan = lease.managed && companyScopedSource
      ? pendingPublicGrowthRetries(lease.cursor, retryLimit)
      : [];
    const recoveryAlreadyComplete = durableRecovery && lease.cursor.recoveryComplete === true;
    const recoveryAlreadyBlocked = durableRecovery && lease.cursor.recoveryBlocked === true;
    const servicingRetry = retryPlan.length > 0
      && (durableRecovery || shouldServicePublicGrowthRetry(lease.cursor));
    const combinedRecurringAwards = lease.managed
      && (source === "usaspending" || source === "usaspending-subawards")
      && !durableRecovery
      && !recoveryAlreadyComplete
      && !recoveryAlreadyBlocked;
    let result = (combinedRecurringAwards
      ? await (async () => {
        // A recurring invocation always advances fresh-company coverage. It also
        // services one exact continuation so deep award histories keep moving
        // without cutting the 48-hour main-population cycle in half.
        const deadlineMs = sourceDeadlineMs;
        const retryResult = retryPlan.length > 0
          ? await runCompanyRetryBatch(source as CompanyScopedSource, lease, retryPlan, Math.min(deadlineMs, Date.now() + 60_000))
          : null;
        const mainResult = source === "usaspending-subawards"
          ? await sweepUsaspendingSubawardsTamBatch(n, offset, companyScope, afterCompanyId, { deadlineMs })
          : await sweepUsaspendingTamBatch(usaspendingCompanyLimit, offset, {
            scope: companyScope,
            afterCompanyId,
            deadlineMs,
          });
        const mainReceipts = Array.isArray(mainResult.receipts) ? mainResult.receipts as unknown as RetryReceipt[] : [];
        const retryCursor = retryResult?.cursorPatch ?? lease.cursor;
        const queued = queuePublicGrowthMainFailures(retryCursor, mainReceipts, Number(mainResult.errors ?? 0));
        return {
          ...mainResult,
          checked: mainResult.checked + Number(retryResult?.checked ?? 0),
          mainChecked: mainResult.checked,
          retryChecked: Number(retryResult?.checked ?? 0),
          matched: mainResult.matched + Number(retryResult?.matched ?? 0),
          errors: mainResult.errors + Number(retryResult?.errors ?? 0),
          triggers: mainResult.triggers + Number(retryResult?.triggers ?? 0),
          ...("stored" in mainResult ? { stored: Number(mainResult.stored) + Number(retryResult?.receipts.reduce((sum, receipt) => sum + Number(receipt.stored ?? 0), 0) ?? 0) } : {}),
          receipts: [...mainReceipts, ...(Array.isArray(retryResult?.receipts) ? retryResult.receipts : [])],
          retryQueued: queued.queued,
          retryRemaining: queued.cursorPatch.retryQueue.length,
          retryDeadLettered: retryResult?.retryDeadLettered ?? [],
          awardContinuationsQueued: queued.continuations,
          advanceCursor: false,
          cursorPatch: { ...(mainResult.cursorPatch ?? {}), ...queued.cursorPatch },
          mode: "main+retry" as const,
        };
      })()
      : recoveryAlreadyComplete
      ? {
        source, offset, checked: exactRecoveryId == null ? 1 : 0, nextOffset: offset, done: true,
        matched: 0, errors: 0, triggers: 0, receipts: [], retryRemaining: 0,
        recoveryComplete: true, advanceCursor: false, mode: "retry" as const,
        cursorPatch: { recoveryComplete: true },
      }
      : recoveryAlreadyBlocked
        ? {
          source, offset, checked: exactRecoveryId == null ? 1 : 0, nextOffset: offset, done: false,
          matched: 0, errors: 1, triggers: 0, receipts: [], retryRemaining: 0,
          retryDeadLettered: Array.isArray(lease.cursor.recoveryDeadLettered) ? lease.cursor.recoveryDeadLettered : [],
          recoveryBlocked: true, advanceCursor: false, mode: "retry" as const,
          cursorPatch: { recoveryBlocked: true, recoveryDeadLettered: lease.cursor.recoveryDeadLettered ?? [] },
        }
      : servicingRetry
      ? await runCompanyRetryBatch(source as CompanyScopedSource, lease, retryPlan, sourceDeadlineMs)
      : exactCompany
      ? await (async (company: TamIdentity) => {
        const receipt = source === "usaspending-subawards"
          ? await sweepUsaspendingSubawardsCompany(company, { deadlineMs: sourceDeadlineMs })
          : await sweepUsaspendingCompanySteps(company, { deadlineMs: sourceDeadlineMs }, 3);
        return {
          source, companyId: company.id, offset: 0, checked: 1, nextOffset: 0,
          done: false, matched: ["matched", "linked"].includes(receipt.status) ? 1 : 0,
          errors: receipt.status === "error" ? 1 : 0, triggers: receipt.triggers,
          ...("stored" in receipt ? { stored: receipt.stored } : {}),
          receipts: [receipt], advanceCursor: false,
        };
      })(exactCompany)
      : source === "sam-entity" ? await sweepSamTamBatch(n, offset, companyScope, afterCompanyId)
        : source === "sam-opportunities" ? await sweepSamOpportunities(days, offset, opportunityLimit, {
          cursor: lease.cursor.samOpportunityCursor, deadlineMs: sourceDeadlineMs,
          checkpoint: (cursor) => checkpointPublicGrowthSweep(lease, { samOpportunityCursor: cursor }),
        })
        : source === "revenue" ? await sweepRevenueTamBatch(revenueLimit, offset)
        : source === "usaspending-subawards" ? await sweepUsaspendingSubawardsTamBatch(n, offset, companyScope, afterCompanyId)
        : await sweepUsaspendingTamBatch(usaspendingCompanyLimit, offset, {
          scope: companyScope,
          afterCompanyId,
          deadlineMs: sourceDeadlineMs,
        })) as PublicGrowthSweepResult & Record<string, unknown>;
    if (!combinedRecurringAwards && !recoveryAlreadyComplete && !recoveryAlreadyBlocked && !servicingRetry && lease.managed && companyScopedSource) {
      const rawReceipts = "receipts" in result && Array.isArray(result.receipts)
        ? result.receipts as RetryReceipt[]
        : [];
      const errorCount = "errors" in result ? Number(result.errors ?? 0) : 0;
      const queued = queuePublicGrowthMainFailures(lease.cursor, rawReceipts, errorCount);
      result = {
        ...result,
        retryQueued: queued.queued,
        retryRemaining: queued.cursorPatch.retryQueue.length,
        awardContinuationsQueued: queued.continuations,
        cursorPatch: { ...(result.cursorPatch ?? {}), ...queued.cursorPatch },
        mode: "main" as const,
      };
    }
    if (!recoveryAlreadyComplete && !recoveryAlreadyBlocked && durableRecovery && Number(result.retryRemaining ?? 0) === 0) {
      const deadLettered = Array.isArray(result.retryDeadLettered) ? result.retryDeadLettered : [];
      const failed = Number(result.errors ?? 0) > 0 || deadLettered.length > 0;
      result = failed
        ? {
          ...result,
          advanceCursor: false,
          recoveryBlocked: true,
          cursorPatch: { ...(result.cursorPatch ?? {}), recoveryBlocked: true, recoveryDeadLettered: deadLettered },
        }
        : {
          ...result,
          advanceCursor: false,
          recoveryComplete: true,
          cursorPatch: { ...(result.cursorPatch ?? {}), recoveryComplete: true },
        };
    }
    if (exactRecoveryId != null) {
      result = { ...result, foundationCompanyId: exactRecoveryId, recoveryStateKey: lease.source };
    }
    if (source === "usaspending" || source === "usaspending-subawards") {
      const receipts = Array.isArray(result.receipts) ? result.receipts as RetryReceipt[] : [];
      result = {
        ...result,
        historiesCompleted: receipts.filter((row) => row.status !== "error" && (row.awardDone === true || row.subawardDone === true)).length,
        historiesIncomplete: receipts.filter((row) => row.awardDone === false || row.subawardDone === false).length,
      };
    }
    const nextCursor = await completePublicGrowthSweep(lease, result);
    const { cursorPatch: _cursorPatch, advanceCursor: _advanceCursor, ...publicResult } = result;
    void _cursorPatch; void _advanceCursor;
    const matched = "matched" in publicResult ? publicResult.matched : "matches" in publicResult ? publicResult.matches : "observed" in publicResult ? publicResult.observed : 0;
    try {
      await logEvent("headhunter", `public_growth.${source}`, { summary: `Public growth ${source}: ${matched}/${publicResult.checked} matched or observed, ${publicResult.triggers} trigger events`, entity_type: "cron", meta: { ...publicResult, receipts: undefined, nextCursor } });
    } catch { /* terminal logging cannot turn a fenced, committed sweep into a retry */ }
    const responseResult = {
      ...publicResult,
      ...("receipts" in publicResult && Array.isArray(publicResult.receipts)
        ? { receipts: publicResult.receipts.map((receipt) => {
          if (!receipt || typeof receipt !== "object") return receipt;
          const { error: _internalError, ...safeReceipt } = receipt as Record<string, unknown>;
          void _internalError;
          return safeReceipt;
        }) }
        : {}),
    };
    return NextResponse.json({ ...responseResult, nextCursor });
  } catch (error) {
    let leaseFailure: "released" | "not_owned" | "release_failed" = "released";
    try {
      leaseFailure = await failPublicGrowthSweep(lease, error) ? "released" : "not_owned";
    } catch {
      leaseFailure = "release_failed";
    }
    const leaseLost = error instanceof PublicGrowthSweepLeaseLostError;
    console.error("public-growth sweep failed", { source, offset, leaseLost, leaseFailure, error });
    return NextResponse.json({
      error: leaseLost ? "lease_lost" : "sweep_failed",
      source,
      offset,
      leaseFailure,
    }, { status: leaseLost ? 409 : 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
