import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";
import { quarantineInvalidTriggers } from "@/lib/triggers/quarantine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const supplied = req.headers.get("x-cron-secret") ?? (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
  return Boolean(supplied && (
    (process.env.TAM_GROWTH_SWEEP_SECRET && supplied === process.env.TAM_GROWTH_SWEEP_SECRET)
    || (process.env.CRON_SECRET && supplied === process.env.CRON_SECRET)
  ));
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({})) as {
      apply?: unknown;
      confirm?: unknown;
      limit?: unknown;
      after?: unknown;
      verifyCareerLinks?: unknown;
    };
    const apply = body.apply === true;
    if (apply && body.confirm !== "PRESERVE_ROWS_AND_QUARANTINE") {
      return NextResponse.json({ error: "apply requires confirm=PRESERVE_ROWS_AND_QUARANTINE" }, { status: 400 });
    }
    const receipt = await quarantineInvalidTriggers({
      apply,
      limit: Number(body.limit) || 50,
      after: typeof body.after === "string" && body.after ? body.after : null,
      verifyCareerLinks: body.verifyCareerLinks !== false,
    });
    if (apply) {
      await logEvent("headhunter", "signals.quarantined", {
        summary: `Signal cleanup preserved and quarantined ${receipt.readbackVerified}/${receipt.planned} planned rows`,
        entity_type: "trigger_cleanup",
        meta: receipt as unknown as Record<string, unknown>,
      });
    }
    return NextResponse.json(receipt, { status: receipt.failures.length ? 409 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
