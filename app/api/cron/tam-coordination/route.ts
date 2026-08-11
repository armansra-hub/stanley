import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tamMachineAuthOk } from "@/lib/agent/auth";
import {
  appendTamEvent,
  beginTamCheckpointSeed,
  bootstrapTamRegradeRun,
  claimTamGradeWork,
  getTamRegradeStatus,
  heartbeatTamActor,
  finalizeTamCheckpointSeed,
  listTamRegradeRecords,
  markTamMembershipRemoved,
  seedTamCheckpointBatch,
  setTamGradeWorkStatus,
  updateTamPdfStatus,
  upsertTamMembership,
} from "@/lib/db/tamCoordination";
import {
  DEFAULT_TAM_RUN_SLUG,
  tamCoordinationActionSchema,
} from "@/lib/tamRegrade";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isTamMachineAuthorized(req: NextRequest) {
  return tamMachineAuthOk(req);
}

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid request", issues: error.issues },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 409 },
  );
}

export async function GET(req: NextRequest) {
  if (!isTamMachineAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const runSlug = url.searchParams.get("run") || DEFAULT_TAM_RUN_SLUG;
  if (url.searchParams.get("view") === "records") {
    try {
      const currentParam = url.searchParams.get("current");
      const isCurrent = currentParam == null
        ? undefined
        : currentParam === "true"
          ? true
          : currentParam === "false"
            ? false
            : undefined;
      return NextResponse.json(await listTamRegradeRecords({
        runSlug,
        netsuiteInternalId: url.searchParams.get("id") || undefined,
        isCurrent,
        membershipStatus: (url.searchParams.get("membership") || undefined) as
          | "new"
          | "overlap"
          | "removed"
          | undefined,
        pdfStatus: (url.searchParams.get("pdf") || undefined) as
          | "missing"
          | "queued"
          | "downloading"
          | "verified"
          | "error"
          | "stale"
          | undefined,
        gradeStatus: (url.searchParams.get("grade") || undefined) as
          | "pending"
          | "reading"
          | "hold"
          | "final"
          | "published"
          | undefined,
        lastActor: url.searchParams.get("actor") || undefined,
        limit: Number(url.searchParams.get("limit") ?? 100),
        offset: Number(url.searchParams.get("offset") ?? 0),
      }));
    } catch (error) {
      return errorResponse(error);
    }
  }
  const eventLimit = Number(url.searchParams.get("events") ?? 50);
  try {
    return NextResponse.json(
      await getTamRegradeStatus(
        runSlug,
        Number.isFinite(eventLimit) ? eventLimit : 50,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isTamMachineAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const action = tamCoordinationActionSchema.parse(body);
    switch (action.action) {
      case "bootstrap":
        return NextResponse.json({ run: await bootstrapTamRegradeRun(action) });
      case "checkpoint_seed_begin":
        return NextResponse.json({ seed: await beginTamCheckpointSeed(action) });
      case "checkpoint_seed_batch":
        return NextResponse.json({ seed: await seedTamCheckpointBatch(action) });
      case "checkpoint_seed_finalize":
        return NextResponse.json({ seed: await finalizeTamCheckpointSeed(action) });
      case "heartbeat":
        return NextResponse.json(await heartbeatTamActor(action));
      case "event":
        await appendTamEvent(action);
        return NextResponse.json({ appended: true });
      case "membership":
        return NextResponse.json(await upsertTamMembership(action));
      case "removed":
        return NextResponse.json(await markTamMembershipRemoved(action));
      case "pdf":
        return NextResponse.json({ record: await updateTamPdfStatus(action) });
      case "claim":
        return NextResponse.json({ record: await claimTamGradeWork(action) });
      case "grade_status":
        return NextResponse.json({ record: await setTamGradeWorkStatus(action) });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
