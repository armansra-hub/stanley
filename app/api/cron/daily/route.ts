import { NextRequest, NextResponse } from "next/server";
import { buildDailyWavePaths, DAILY_STAGE_SIZE } from "@/lib/cron/dailyPlan";
import { logEvent } from "@/lib/db/events";

/**
 * Vercel invokes this route hourly. Each independent root invocation rotates to
 * the next five-worker stage, so the full manifest rotates without a
 * concurrency burst or a recursive function chain (which Vercel rejects at a
 * bounded recursion depth). Explicit stage/run parameters support exact audits.
 */
export const dynamic = "force-dynamic";
// Public-growth workers already use the production plan's 300-second ceiling.
// The dispatcher needs enough headroom to observe five 48-60 second workers,
// persist their receipt, and hand off the next stage.
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? bearer;
  return Boolean(secret && (
    (process.env.CRON_SECRET && secret === process.env.CRON_SECRET)
    || (process.env.TAM_GROWTH_SWEEP_SECRET && secret === process.env.TAM_GROWTH_SWEEP_SECRET)
  ));
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const paths = buildDailyWavePaths();
  const stageCount = Math.ceil(paths.length / DAILY_STAGE_SIZE);
  const hourSlot = Math.floor(Date.now() / 3_600_000);
  const explicitStage = url.searchParams.get("stage");
  const stage = explicitStage == null ? hourSlot % stageCount : Number(explicitStage);
  if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
    return NextResponse.json({ error: "invalid_stage", stageCount }, { status: 400 });
  }

  const suppliedRunId = url.searchParams.get("run")?.trim();
  const runId = suppliedRunId && /^[a-zA-Z0-9-]{8,80}$/.test(suppliedRunId)
    ? suppliedRunId
    : `hourly-${Math.floor(hourSlot / stageCount)}`;
  const stagePaths = paths.slice(stage * DAILY_STAGE_SIZE, (stage + 1) * DAILY_STAGE_SIZE);
  const base = process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : url.origin);
  const cronSecret = process.env.CRON_SECRET!;

  if (stage === 0) {
    await logEvent("headhunter", "daily.fired", {
      summary: `Hourly sweep rotation started — ${paths.length} sweeps across ${stageCount} independent stages`,
      entity_type: "cron",
      meta: { runId, total: paths.length, stageCount, stageSize: DAILY_STAGE_SIZE },
    }).catch(() => {});
  }

  const results = await Promise.all(stagePaths.map(async (path) => {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { "x-cron-secret": cronSecret },
        cache: "no-store",
      });
      void response.body?.cancel().catch(() => {});
      return { path, status: response.status };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const ok = results.filter((result) => result.status === 200).length;
  const failed = results.length - ok;
  await logEvent("headhunter", "daily.stage", {
    summary: `Daily stage ${stage + 1}/${stageCount}: ${ok}/${results.length} sweeps OK`,
    entity_type: "cron",
    meta: { runId, stage, stageCount, ok, failed, results },
  }).catch(() => {});

  if (stage + 1 === stageCount) {
    await logEvent("headhunter", "daily.done", {
      summary: `Hourly sweep rotation reached stage ${stageCount}/${stageCount}`,
      entity_type: "cron",
      meta: { runId, status: "rotation_complete", total: paths.length, stageCount },
    }).catch(() => {});
  }

  return NextResponse.json({ completed: true, runId, stage, stageCount, children: stagePaths.length, ok, failed });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
