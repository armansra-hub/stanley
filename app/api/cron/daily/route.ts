import { NextRequest, NextResponse } from "next/server";
import { buildDailyWavePaths } from "@/lib/cron/dailyPlan";
import { logEvent } from "@/lib/db/events";

/**
 * The one Vercel daily cron. It dispatches a finite, deduplicated manifest of
 * independently time-boxed sweep functions. See dailyPlan.ts for the hard child
 * request ceiling and coverage-volume assertions.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const wavePaths = buildDailyWavePaths();
  await logEvent("headhunter", "daily.fired", {
    summary: `Daily cron fired — dispatching ${wavePaths.length} bounded sweeps`,
    entity_type: "cron",
    meta: { total: wavePaths.length },
  }).catch(() => {});

  const base = process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : url.origin);
  const cronSecret = process.env.CRON_SECRET;
  const controllers = new Set<AbortController>();
  const hit = async (path: string) => {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { "x-cron-secret": cronSecret! },
        cache: "no-store",
        signal: controller.signal,
      });
      // The parent only needs status. Do not retain dozens of response payloads.
      await response.body?.cancel().catch(() => {});
      return { path, status: response.status };
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) };
    } finally {
      controllers.delete(controller);
    }
  };

  // Creating these promises dispatches the fixed manifest once. There is no retry,
  // recursion, pagination loop, or follow-on self-scheduling.
  const completed: Array<{ path: string; status?: number; error?: string }> = [];
  const waves = wavePaths.map((path) => hit(path).then((result) => {
    completed.push(result);
    return result;
  }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(waves),
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 50_000); }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (settled) {
    const ok = settled.filter((result) =>
      result.status === "fulfilled" && "status" in result.value && result.value.status === 200,
    ).length;
    await logEvent("headhunter", "daily.done", {
      summary: `Daily sweep — ${ok}/${wavePaths.length} waves OK`,
      entity_type: "cron",
      meta: { status: "complete", ok, failed: wavePaths.length - ok, completed: wavePaths.length, total: wavePaths.length },
    }).catch(() => {});
    return NextResponse.json({ ran: settled.length, ok });
  }

  // Release the parent invocation's open sockets at its deadline, but still emit an
  // honest terminal receipt. Previously this branch omitted daily.done entirely.
  const activeAtDeadline = controllers.size;
  for (const controller of controllers) controller.abort();
  const ok = completed.filter((result) => result.status === 200).length;
  const failed = completed.length - ok;
  await logEvent("headhunter", "daily.done", {
    summary: `Daily sweep deadline: ${ok}/${completed.length} completed waves OK; ${activeAtDeadline} still active`,
    entity_type: "cron",
    meta: {
      status: "deadline",
      ok,
      failed,
      completed: completed.length,
      active_at_deadline: activeAtDeadline,
      total: wavePaths.length,
    },
  }).catch(() => {});
  return NextResponse.json({
    dispatched: wavePaths.length,
    completed: completed.length,
    ok,
    activeAtDeadline,
    note: "parent observation ended at 50s; see per-sweep events for child completion",
  });
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
