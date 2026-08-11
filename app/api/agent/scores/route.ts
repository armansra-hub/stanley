import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { assessDigest, normalizeScoreBatch } from "@/lib/agent/scores";
import { deriveStoredScores, effectiveRecordDeadReason, isRetiredTamDuplicate } from "@/lib/agent/scoreWrite";
import { ASSESSMENT_ARTIFACT_RULES, SCORE_STORAGE_RULES } from "@/lib/agent/scoreContract";

/**
 * Grade ingest — the replacement for the endpoint Codex built and deleted on
 * 2026-07-15 after its strict date rule rejected whole batches opaquely.
 *
 * What changed: auth (the original was a public write to every TAM score), per-row
 * errors instead of all-or-nothing rejection, loose input formats, a complete
 * reviewed-recovery before-image,
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

  let body: {
    rows?: unknown;
    dryRun?: unknown;
    label?: unknown;
    note?: unknown;
    agent?: unknown;
    resurfaceCurrentTam?: unknown;
  };
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
  const resurfaceCurrentTam = body.resurfaceCurrentTam === true
    || /^tam-v9-/i.test(label)
    || /^ars bs tam v9/i.test(label);
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
      .select("id, name, netsuite_internal_id, tam_score, codex_score, oldgold_score, score_adjust_note, qual_note, last_sql_date, erp_incumbent, record_dead, record_dead_reason, record_digest, oldgold_class, oldgold_reasons, revisit_on, tam_provisional, status, lists, claimable")
      .in("netsuite_internal_id", ids.slice(i, i + 300));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    found.push(...(data ?? []));
  }

  // One internal ID can map to several historical company rows. Retired
  // tam_duplicate rows are immutable; more than one non-retired row is ambiguous
  // and fails closed. Only the sole canonical row may receive a grade.
  const byNsid = new Map<string, Record<string, unknown>[]>();
  let retiredDuplicateRowsSkipped = 0;
  for (const c of found) {
    if (isRetiredTamDuplicate(c)) {
      retiredDuplicateRowsSkipped++;
      continue;
    }
    const key = String(c.netsuite_internal_id);
    byNsid.set(key, [...(byNsid.get(key) ?? []), c]);
  }
  const missing = ids.filter((id) => !byNsid.has(id));
  const ambiguousInternalIds = ids.filter((id) => (byNsid.get(id)?.length ?? 0) > 1);

  let writes: Record<string, unknown>[] = [];
  const hardZeroed: { name: string; reason: string }[] = [];
  const deadReasonFailures: { internalId: string; companyId: string }[] = [];

  for (const row of rows) {
    if (ambiguousInternalIds.includes(row.internalId)) continue;
    for (const company of byNsid.get(row.internalId) ?? []) {
      // Public signals are structurally absent from this pure write decision.
      const law = deriveStoredScores(row, company);
      const recordDeadReason = effectiveRecordDeadReason(row, company, law.recordDead);
      if (law.recordDead && !recordDeadReason) {
        deadReasonFailures.push({ internalId: row.internalId, companyId: String(company.id) });
        // This row is already known to violate the specific-dead-reason gate.
        // Reject it independently so it cannot roll back otherwise healthy rows;
        // the RPC still revalidates every retained row under its database lock.
        continue;
      }
      if (law.hardZeroReason) hardZeroed.push({ name: String(company.name), reason: law.hardZeroReason });
      writes.push({
        id: company.id,
        netsuite_internal_id: row.internalId,
        raw_score: row.tamScore,
        old_gold_score_input: row.oldGoldScore,
        record_dead_input: row.recordDead,
        record_dead_reason: row.recordDeadReason,
        record_dead_reason_provided: row.recordDeadReasonProvided,
        record_digest: row.recordDigest,
        old_gold_class: row.oldGoldClass,
        old_gold_class_provided: row.oldGoldClassProvided,
        old_gold_reasons: row.oldGoldReasons,
        old_gold_reasons_provided: row.oldGoldReasonsProvided,
        revisit_on: row.revisitOn,
        revisit_on_provided: row.revisitOnProvided,
        fallback_last_sql: row.lastSqlDate,
        note_prefix: String(body.note ?? label),
        // The RPC evaluates this intent against the row-locked current status,
        // so a concurrent reviewed/dismissed decision cannot be overwritten.
        resurface_exported: resurfaceCurrentTam,
      });
    }
  }

  // Rationale quality on this batch — never blocks, always reported.
  // A checkpoint seed transfers current TAM ownership to the fenced coordinator.
  // Exclude those known rows individually so dry-run is truthful and they cannot
  // roll back unrelated non-TAM writes in the atomic RPC.
  const coordinatorOnly: { internalId: string; companyId: string }[] = [];
  if (writes.length > 0) {
    const { data: seedRows, error: seedError } = await db
      .from("tam_regrade_checkpoint_seeds")
      .select("run_id")
      .limit(1000);
    if (seedError) {
      return NextResponse.json({ error: `checkpoint preflight failed: ${seedError.message}` }, { status: 500 });
    }
    const runIds = [...new Set((seedRows ?? []).map((seed) => String(seed.run_id)))];
    const candidateIds = writes.map((write) => String(write.id));
    const coordinatorIds = new Set<string>();
    for (let i = 0; i < candidateIds.length && runIds.length > 0; i += 300) {
      const { data: seededRecords, error: recordError } = await db
        .from("tam_regrade_records")
        .select("company_id,netsuite_internal_id")
        .in("run_id", runIds)
        .eq("is_current", true)
        .in("company_id", candidateIds.slice(i, i + 300));
      if (recordError) {
        return NextResponse.json({ error: `checkpoint record preflight failed: ${recordError.message}` }, { status: 500 });
      }
      for (const record of seededRecords ?? []) {
        const companyId = String(record.company_id);
        if (coordinatorIds.has(companyId)) continue;
        coordinatorIds.add(companyId);
        coordinatorOnly.push({ internalId: String(record.netsuite_internal_id), companyId });
      }
    }
    writes = writes.filter((write) => !coordinatorIds.has(String(write.id)));
  }

  const withDigest = rows.filter((r) => r.recordDigest);
  const unauditable = withDigest.filter((r) => !assessDigest(r.recordDigest, [...r.oldGoldReasons, r.qualNote ?? ""]).auditable).map((r) => r.internalId);
  const noDigest = rows.filter((r) => !r.recordDigest).map((r) => r.internalId);

  const scores = rows.map((r) => r.tamScore).sort((a, b) => a - b);
  const summary = {
    received: (body.rows as unknown[]).length,
    usable: rows.length,
    matchedCompanies: writes.length,
    missingInternalIds: missing.slice(0, 50),
    missingCount: missing.length,
    ambiguousInternalIds,
    ambiguousCount: ambiguousInternalIds.length,
    retiredDuplicateRowsSkipped,
    deadReasonFailures: deadReasonFailures.slice(0, 50),
    deadReasonFailureCount: deadReasonFailures.length,
    coordinatorOnly: coordinatorOnly.slice(0, 50),
    coordinatorOnlyCount: coordinatorOnly.length,
    duplicateInternalIds: duplicates,
    rowErrors: errors.slice(0, 50),
    errorCount: errors.length,
    hardZeroed: hardZeroed.slice(0, 20),
    hardZeroedCount: hardZeroed.length,
    resurfaceCurrentTam,
    resurfacedCount: 0,
    resurfaced: [] as string[],
    rationale: {
      withDigest: withDigest.length,
      missingDigest: noDigest.length,
      unauditableDigest: unauditable.length,
      sampleUnauditable: unauditable.slice(0, 10),
      note: "unauditable = a digest citing no date, figure, quote, named system, headcount or person. Not blocked; a grade nobody can check is still recorded, just flagged.",
    },
    scoreDistribution: {
      min: scores[0],
      median: scores[Math.floor(scores.length / 2)],
      max: scores[scores.length - 1],
      atOrAbove60: scores.filter((s) => s >= 60).length,
      zero: scores.filter((s) => s === 0).length,
    },
  };

  if (dryRun) return NextResponse.json({
    dryRun: true,
    wouldAttempt: writes.length,
    preflightEligible: writes.length,
    wouldRejectKnown: deadReasonFailures.length,
    lockedValidationRequired: true,
    ...summary,
  });

  if (writes.length === 0 && (
    ambiguousInternalIds.length > 0
    || deadReasonFailures.length > 0
    || coordinatorOnly.length > 0
  )) {
    return NextResponse.json({ error: "no safe score targets", label, ...summary }, { status: 422 });
  }

  if (writes.length > 0) {
    const { data: writeReceipt, error: writeError } = await db.rpc("apply_agent_score_batch", {
      p_label: label,
      p_rows: writes,
    });
    if (writeError) {
      return NextResponse.json({
        error: `atomic score batch rolled back: ${writeError.message}`,
        written: 0,
        label,
      }, { status: 500 });
    }
    const receipt = writeReceipt as {
      written?: unknown;
      label?: unknown;
      resurfaced?: unknown;
      resurfaced_internal_ids?: unknown;
      hard_zeroed?: unknown;
    } | null;
    Object.assign(summary, {
      resurfacedCount: Number(receipt?.resurfaced ?? 0),
      resurfaced: Array.isArray(receipt?.resurfaced_internal_ids)
        ? receipt.resurfaced_internal_ids.map(String).slice(0, 200)
        : [],
      hardZeroedCount: Array.isArray(receipt?.hard_zeroed) ? receipt.hard_zeroed.length : 0,
      hardZeroed: Array.isArray(receipt?.hard_zeroed) ? receipt.hard_zeroed.slice(0, 20) : [],
    });
    if (Number(receipt?.written) !== writes.length || receipt?.label !== label) {
      // The RPC returned success, so do not surface a retryable failure after a
      // possible commit. Preserve the anomaly in the response and timeline.
      Object.assign(summary, { databaseReceiptMismatch: true });
    }
  }

  let timelineLogged = true;
  await logEvent("headhunter", "agent.scores_imported", {
    summary: `${agent} imported ${writes.length} grades (${rows.length} leads, ${errors.length} bad rows, ${missing.length} unmatched, ${unauditable.length + noDigest.length} without auditable rationale) — label ${label}`,
    entity_type: "agent_bridge",
    meta: { agent, label, ...summary },
  }).catch(() => { timelineLogged = false; });

  return NextResponse.json({
    written: writes.length,
    label,
    snapshot: `score_snapshots where label='${label}' (atomic complete prior_values; restoration requires explicit review)`,
    timelineLogged,
    ...summary,
  });
}

/** GET — what a caller needs to know before posting, so the contract is discoverable. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  return NextResponse.json({
    post: {
      rows: "array (max 1000) of grade rows",
      dryRun: "boolean - always try this first",
      label: "string used to group the reviewed-recovery before-images",
      note: "score_adjust_note text",
      resurfaceCurrentTam: "optional boolean; restores current netsuite_tam rows from exported statuses only; reviewed/dismissed decisions remain hidden",
    },
    row: {
      internalId: "required — NetSuite internal ID, digits (aliases: internal_id, nsid, 'Internal ID')",
      tamScore: "required — 0-100 close probability (aliases: score, grade)",
      recordDigest: "optional — the grading rationale (aliases: digest, rationale)",
      recordDead: "optional boolean — true/false, yes/no, 1/0",
      recordDeadReason: "specific text required for an effective dead row; omit to preserve an existing dead reason; making the row live clears it",
      revisitOn: "optional date — YYYY-MM-DD, M/D/YYYY, ISO, Excel serial, or blank; omit to preserve, send null/blank to clear",
      oldGoldClass: "optional text; omit to preserve, send null/blank to clear",
      oldGoldReasons: "optional array or delimited string; omit to preserve, send []/null/blank to clear",
    },
    rules: SCORE_STORAGE_RULES,
    assessmentArtifactRules: ASSESSMENT_ARTIFACT_RULES,
  });
}
