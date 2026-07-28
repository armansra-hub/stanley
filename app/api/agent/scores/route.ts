import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { applyScoringLaw, normalizeScoreBatch } from "@/lib/agent/scores";

/**
 * Grade ingest — the replacement for the endpoint Codex built and deleted on
 * 2026-07-15 after its strict date rule rejected whole batches opaquely.
 *
 * What changed: auth (the original was a public write to every TAM score), per-row
 * errors instead of all-or-nothing rejection, loose input formats, an undo snapshot,
 * and Stanley's hard-zero + derived-old-gold rules enforced at write time.
 *
 * POST { rows: [...], dryRun?: boolean, label?: string, note?: string }
 *   rows[]: { internalId, tamScore, recordDigest?, recordDead?, recordDeadReason?,
 *             revisitOn?, oldGoldClass?, oldGoldReasons?, qualNote?, lastSqlDate? }
 *             — field names are matched loosely (see lib/agent/coerce.ts#pick).
 *
 * Always dry-run first: it reports matches, misses and bad rows without writing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 1000;

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();

  let body: { rows?: unknown; dryRun?: unknown; label?: unknown; note?: unknown; agent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows must be a non-empty array" }, { status: 400 });
  }
  if (body.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `rows capped at ${MAX_ROWS} per request`, received: body.rows.length, hint: "send sequential batches; re-sending a batch is safe" },
      { status: 400 },
    );
  }

  const agent = callerAgent(req, body.agent);
  const dryRun = body.dryRun === true;
  const label = String(body.label ?? `${agent}-import`).slice(0, 80);
  const { rows, errors, duplicates } = normalizeScoreBatch(body.rows as Record<string, unknown>[]);

  if (!rows.length) {
    return NextResponse.json(
      { error: "no usable rows", rowErrors: errors.slice(0, 50), errorCount: errors.length },
      { status: 422 },
    );
  }

  const db = serviceClient();
  const ids = rows.map((r) => r.internalId);
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db
      .from("companies")
      .select("id, name, netsuite_internal_id, tam_score, codex_score, oldgold_score, score_adjust_note, qual_note, last_sql_date, erp_incumbent")
      .in("netsuite_internal_id", ids.slice(i, i + 300));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    found.push(...(data ?? []));
  }

  // One internal ID can map to several company rows (the base import created ~20
  // duplicate NetSuite IDs). The grade belongs to all of them, but each row's
  // Old Gold status is its own — hence the per-row scoring pass below.
  const byNsid = new Map<string, Record<string, unknown>[]>();
  for (const c of found) {
    const key = String(c.netsuite_internal_id);
    byNsid.set(key, [...(byNsid.get(key) ?? []), c]);
  }
  const missing = ids.filter((id) => !byNsid.has(id));

  const writes: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const hardZeroed: { name: string; reason: string }[] = [];

  for (const row of rows) {
    for (const company of byNsid.get(row.internalId) ?? []) {
      const law = applyScoringLaw(row, company as never);
      if (law.hardZeroReason) hardZeroed.push({ name: String(company.name), reason: law.hardZeroReason });
      snapshots.push({
        label,
        company_id: company.id,
        netsuite_internal_id: row.internalId,
        tam_score: company.tam_score ?? null,
        codex_score: company.codex_score ?? null,
        oldgold_score: company.oldgold_score ?? null,
        score_adjust_note: company.score_adjust_note ?? null,
      });
      writes.push({
        id: company.id,
        tam_score: law.tamScore,
        codex_score: row.tamScore, // the grader's raw number, preserved for side-by-side reading
        oldgold_score: law.oldGoldScore,
        tam_provisional: false,
        record_dead: row.recordDead,
        ...(row.recordDeadReason ? { record_dead_reason: row.recordDeadReason } : {}),
        ...(row.recordDigest ? { record_digest: row.recordDigest } : {}),
        ...(row.oldGoldClass ? { oldgold_class: row.oldGoldClass } : {}),
        ...(row.oldGoldReasons.length ? { oldgold_reasons: row.oldGoldReasons } : {}),
        ...(row.revisitOn ? { revisit_on: row.revisitOn } : {}),
        score_adjust_note: String(body.note ?? `${label}: raw grade, no outside-signal adjustment applied`).slice(0, 400),
      });
    }
  }

  const scores = rows.map((r) => r.tamScore).sort((a, b) => a - b);
  const summary = {
    received: (body.rows as unknown[]).length,
    usable: rows.length,
    matchedCompanies: writes.length,
    missingInternalIds: missing.slice(0, 50),
    missingCount: missing.length,
    duplicateInternalIds: duplicates,
    rowErrors: errors.slice(0, 50),
    errorCount: errors.length,
    hardZeroed: hardZeroed.slice(0, 20),
    hardZeroedCount: hardZeroed.length,
    scoreDistribution: {
      min: scores[0],
      median: scores[Math.floor(scores.length / 2)],
      max: scores[scores.length - 1],
      atOrAbove60: scores.filter((s) => s >= 60).length,
      zero: scores.filter((s) => s === 0).length,
    },
  };

  if (dryRun) return NextResponse.json({ dryRun: true, wouldWrite: writes.length, ...summary });

  for (let i = 0; i < snapshots.length; i += 500) {
    await db.from("score_snapshots").insert(snapshots.slice(i, i + 500));
  }
  for (let i = 0; i < writes.length; i += 500) {
    const { error } = await db.from("companies").upsert(writes.slice(i, i + 500), { onConflict: "id" });
    if (error) {
      return NextResponse.json({ error: error.message, writtenBefore: i, label, hint: "prior values are in score_snapshots under this label" }, { status: 500 });
    }
  }

  await logEvent("headhunter", "agent.scores_imported", {
    summary: `${agent} imported ${writes.length} grades (${rows.length} leads, ${errors.length} bad rows, ${missing.length} unmatched) — label ${label}`,
    entity_type: "agent_bridge",
    meta: { agent, label, ...summary },
  });

  return NextResponse.json({ written: writes.length, label, undo: `score_snapshots where label='${label}'`, ...summary });
}

/** GET — what a caller needs to know before posting, so the contract is discoverable. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return NextResponse.json({
    post: { rows: "array (max 1000) of grade rows", dryRun: "boolean — always try this first", label: "string used for the undo snapshot", note: "score_adjust_note text" },
    row: {
      internalId: "required — NetSuite internal ID, digits (aliases: internal_id, nsid, 'Internal ID')",
      tamScore: "required — 0-100 close probability (aliases: score, grade)",
      recordDigest: "optional — the grading rationale (aliases: digest, rationale)",
      recordDead: "optional boolean — true/false, yes/no, 1/0",
      recordDeadReason: "optional text",
      revisitOn: "optional date — YYYY-MM-DD, M/D/YYYY, ISO, Excel serial, or blank",
      oldGoldClass: "optional text", oldGoldReasons: "optional array or delimited string",
    },
    rules: [
      "record_dead rows and NetSuite incumbents are forced to 0 regardless of the pushed score",
      "oldgold_score is derived, never copied: it equals tam_score only when the row has both a qual note and a last SQL date",
      "codex_score keeps the raw pushed number; tam_score is what the UI ranks on",
      "Stanley's ±15 outside-signal adjustment is a separate pass (system/codex_rescore.py) — it is not applied here",
      "duplicate NetSuite internal IDs exist; every company row sharing an ID receives the grade, scored per row",
    ],
  });
}
