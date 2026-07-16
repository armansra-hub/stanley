import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ScoreRow = {
  internalId: string;
  tamScore: number;
  oldGoldScore: number | null;
  oldGoldClass: string | null;
  oldGoldReasons: string[];
  recordDigest: string;
  recordDead: boolean;
  recordDeadReason: string | null;
  revisitOn: string | null;
};

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validRow(value: unknown): value is ScoreRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ScoreRow>;
  return (
    typeof row.internalId === "string" &&
    /^\d+$/.test(row.internalId) &&
    validScore(row.tamScore) &&
    (row.oldGoldScore === null || validScore(row.oldGoldScore)) &&
    (row.oldGoldClass === null || typeof row.oldGoldClass === "string") &&
    Array.isArray(row.oldGoldReasons) &&
    row.oldGoldReasons.every((reason) => typeof reason === "string") &&
    typeof row.recordDigest === "string" &&
    typeof row.recordDead === "boolean" &&
    (row.recordDeadReason === null || typeof row.recordDeadReason === "string") &&
    (row.revisitOn === null || /^\d{4}-\d{2}-\d{2}$/.test(row.revisitOn))
  );
}

export async function POST(req: Request) {
  let body: { rows?: unknown[]; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 250) {
    return NextResponse.json({ error: "rows must contain 1-250 score records" }, { status: 400 });
  }
  if (!body.rows.every(validRow)) {
    return NextResponse.json({ error: "One or more score records are invalid" }, { status: 400 });
  }

  const rows = body.rows as ScoreRow[];
  const db = serviceClient();
  const internalIds = [...new Set(rows.map((row) => row.internalId))];
  const { data: companies, error: lookupError } = await db
    .from("companies")
    .select("id,name,netsuite_internal_id")
    .in("netsuite_internal_id", internalIds);

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }

  const scoreByInternalId = new Map(rows.map((row) => [row.internalId, row]));
  const matchedIds = new Set((companies ?? []).map((company) => String(company.netsuite_internal_id)));
  const missing = internalIds.filter((internalId) => !matchedIds.has(internalId));

  if (body.dryRun) {
    return NextResponse.json({ requested: internalIds.length, matched: matchedIds.size, missing });
  }

  const updates = (companies ?? []).flatMap((company) => {
    const score = scoreByInternalId.get(String(company.netsuite_internal_id));
    if (!score) return [];
    return [{
      id: company.id,
      name: company.name,
      tam_score: score.tamScore,
      codex_score: score.tamScore,
      tam_provisional: false,
      oldgold_score: score.oldGoldScore,
      oldgold_class: score.oldGoldClass,
      oldgold_reasons: score.oldGoldReasons,
      record_digest: score.recordDigest,
      record_dead: score.recordDead,
      record_dead_reason: score.recordDeadReason,
      revisit_on: score.revisitOn,
      score_adjust_note: "Codex full-record regrade 2026-07-15; no outside-signal adjustment applied",
    }];
  });

  if (updates.length) {
    const { error: updateError } = await db.from("companies").upsert(updates, { onConflict: "id" });
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ requested: internalIds.length, updated: updates.length, missing });
}
