import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { agentAuthOk } from "@/lib/agent/auth";
import { publishValidatedTamGrade } from "@/lib/db/tamCoordination";
import {
  finalGradePublishBatchSchema,
  finalGradePublishSchema,
  type FinalGradePublishInput,
} from "@/lib/tamRegrade";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isTamMachineAuthorized(req: NextRequest) {
  return agentAuthOk(req);
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

  let grade: FinalGradePublishInput;
  try {
    const isBatch = Boolean(body && typeof body === "object" && "grades" in body);
    grade = isBatch
      ? finalGradePublishBatchSchema.parse(body).grades[0]
      : finalGradePublishSchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid validated grade", issues: error.issues },
        { status: 400 },
      );
    }
    throw error;
  }

  try {
    const published = await publishValidatedTamGrade(grade);
    return NextResponse.json({
      ok: true,
      netsuiteInternalId: grade.netsuiteInternalId,
      published,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      netsuiteInternalId: grade.netsuiteInternalId,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 409 });
  }
}
