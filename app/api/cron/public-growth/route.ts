import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";
import { sweepUsaspendingSubawardsTamBatch, sweepUsaspendingTamBatch } from "@/lib/publicGrowth/usaspendingSweep";
import { sweepSamTamBatch } from "@/lib/publicGrowth/samSweep";
import { sweepRevenueTamBatch } from "@/lib/publicGrowth/revenueSweep";
import { sweepSamOpportunities } from "@/lib/publicGrowth/opportunitySweep";
import {
  beginPublicGrowthSweep,
  completePublicGrowthSweep,
  failPublicGrowthSweep,
  PublicGrowthSweepBusyError,
  PublicGrowthSweepLeaseLostError,
} from "@/lib/publicGrowth/sweepState";

export const dynamic = "force-dynamic";
// Award-heavy incumbents can have hundreds of awards and thousands of
// transactions. Keep the ordinary batches small, but allow one exact company
// enough time to persist its complete history instead of failing at 60 seconds.
export const maxDuration = 300;

function authorized(req: NextRequest) {
  const url = new URL(req.url), auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(supplied && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
  ));
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url), source = url.searchParams.get("source") ?? "usaspending";
  const n = Math.min(Math.max(Number(url.searchParams.get("n") ?? 2) || 2, 1), 10);
  const explicitOffset = url.searchParams.has("offset")
    ? Math.max(Number(url.searchParams.get("offset")) || 0, 0)
    : null;
  const chunkAwards = url.searchParams.has("awardOffset") || url.searchParams.has("awardLimit");
  const awardOffset = Math.max(Number(url.searchParams.get("awardOffset") ?? 0) || 0, 0);
  const awardLimit = Math.min(100, Math.max(Number(url.searchParams.get("awardLimit") ?? 10) || 10, 1));
  if (!new Set(["usaspending", "usaspending-subawards", "sam-entity", "sam-opportunities", "revenue"]).has(source)) return NextResponse.json({ error: `unsupported source ${source}` }, { status: 400 });
  if (chunkAwards && explicitOffset == null) return NextResponse.json({ error: "award chunking requires an explicit company offset" }, { status: 400 });
  const companyScopedSource = new Set(["usaspending", "usaspending-subawards", "sam-entity"]).has(source);
  const requestedScope = url.searchParams.get("scope");
  if (requestedScope != null && requestedScope !== "verified" && requestedScope !== "tam") {
    return NextResponse.json({ error: "scope must be verified or tam" }, { status: 400 });
  }
  if (!companyScopedSource && requestedScope != null) {
    return NextResponse.json({ error: `scope is not supported for ${source}` }, { status: 400 });
  }
  const companyScope = (requestedScope ?? (explicitOffset == null ? "verified" : "tam")) as "verified" | "tam";
  if (companyScopedSource && companyScope === "tam" && explicitOffset == null) {
    return NextResponse.json({ error: "full-TAM public-growth sweeps require an explicit offset" }, { status: 400 });
  }
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 31) || 31));
  const opportunityLimit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));
  const revenueLimit = Math.min(500, Math.max(n, Number(url.searchParams.get("limit") ?? 250) || 250));
  const batchSize = source === "sam-opportunities" ? opportunityLimit : source === "revenue" ? revenueLimit : n;
  let lease: Awaited<ReturnType<typeof beginPublicGrowthSweep>>;
  try {
    lease = await beginPublicGrowthSweep(source, batchSize, explicitOffset);
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
    return NextResponse.json({
      error: "lease_acquire_failed",
      source,
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
  const offset = lease.offset;
  try {
    const result = source === "sam-entity" ? await sweepSamTamBatch(n, offset, companyScope)
      : source === "sam-opportunities" ? await sweepSamOpportunities(days, offset, opportunityLimit)
      : source === "revenue" ? await sweepRevenueTamBatch(revenueLimit, offset)
      : source === "usaspending-subawards" ? await sweepUsaspendingSubawardsTamBatch(n, offset, companyScope)
      : await sweepUsaspendingTamBatch(n, offset, {
        ...(chunkAwards ? { awardOffset, awardLimit } : {}),
        scope: companyScope,
      });
    const nextCursor = await completePublicGrowthSweep(lease, result);
    const matched = "matched" in result ? result.matched : "matches" in result ? result.matches : "observed" in result ? result.observed : 0;
    try {
      await logEvent("headhunter", `public_growth.${source}`, { summary: `Public growth ${source}: ${matched}/${result.checked} matched or observed, ${result.triggers} trigger events`, entity_type: "cron", meta: { ...result, receipts: undefined, nextCursor } });
    } catch { /* terminal logging cannot turn a fenced, committed sweep into a retry */ }
    return NextResponse.json({ ...result, nextCursor });
  } catch (error) {
    let leaseFailure: "released" | "not_owned" | "release_failed" = "released";
    try {
      leaseFailure = await failPublicGrowthSweep(lease, error) ? "released" : "not_owned";
    } catch {
      leaseFailure = "release_failed";
    }
    const leaseLost = error instanceof PublicGrowthSweepLeaseLostError;
    return NextResponse.json({
      error: leaseLost ? "lease_lost" : "sweep_failed",
      detail: error instanceof Error ? error.message : String(error),
      source,
      offset,
      leaseFailure,
    }, { status: leaseLost ? 409 : 500 });
  }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
