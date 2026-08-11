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

  // One internal ID can map to several company rows (the base import created ~20
  // duplicate NetSuite IDs). The grade belongs to all of them, but each row's
  // Old Gold status is its own — hence the per-row scoring pass below.
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

  const writes: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const hardZeroed: { name: string; reason: string }[] = [];
  const deadReasonFailures: { internalId: string; companyId: string }[] = [];
  const resurfaced: { id: string; internalId: string; priorStatus: string }[] = [];
  // Automated regrades may refresh exported leads, but a human review/dismissal
  // is a durable worklist decision and must never be undone here.
  const hiddenStatuses = new Set(["exported_csv", "exported_sql"]);

  for (const row of rows) {
    if (ambiguousInternalIds.includes(row.internalId)) continue;
    for (const company of byNsid.get(row.internalId) ?? []) {
      // Public signals are structurally absent from this pure write decision.
      const law = deriveStoredScores(row, company);
      const recordDeadReason = effectiveRecordDeadReason(row, company, law.recordDead);
      if (law.recordDead && !recordDeadReason) {
        deadReasonFailures.push({ internalId: row.internalId, companyId: String(company.id) });
        continue;
      }
      const companyLists = Array.isArray(company.lists) ? company.lists.map(String) : [];
      const priorStatus = String(company.status ?? "new");
      const shouldResurface = resurfaceCurrentTam
        && company.claimable === true
        && companyLists.includes("netsuite_tam")
        && hiddenStatuses.has(priorStatus);
      if (shouldResurface) {
        resurfaced.push({
          id: String(company.id),
          internalId: row.internalId,
          priorStatus,
        });
      }
      if (law.hardZeroReason) hardZeroed.push({ name: String(company.name), reason: law.hardZeroReason });
      snapshots.push({
        label,
        company_id: company.id,
        netsuite_internal_id: row.internalId,
        tam_score: company.tam_score ?? null,
        codex_score: company.codex_score ?? null,
        oldgold_score: company.oldgold_score ?? null,
        score_adjust_note: company.score_adjust_note ?? null,
        prior_values: {
          tam_score: company.tam_score ?? null,
          codex_score: company.codex_score ?? null,
          oldgold_score: company.oldgold_score ?? null,
          score_adjust_note: company.score_adjust_note ?? null,
          tam_provisional: company.tam_provisional ?? null,
          status: company.status ?? null,
          record_dead: company.record_dead ?? null,
          record_dead_reason: company.record_dead_reason ?? null,
          record_digest: company.record_digest ?? null,
          oldgold_class: company.oldgold_class ?? null,
          oldgold_reasons: company.oldgold_reasons ?? null,
          revisit_on: company.revisit_on ?? null,
        },
      });
      writes.push({
        id: company.id,
        // PostgREST upsert is INSERT … ON CONFLICT, and NOT NULL is checked on the
        // proposed row before the conflict resolves — so `name` must be carried
        // through unchanged or the whole batch fails. It is the only such column.
        name: company.name,
        tam_score: law.tamScore,
        codex_score: law.codexScore,
        oldgold_score: law.oldGoldScore,
        tam_provisional: false,
        status: shouldResurface ? "new" : priorStatus,
        record_dead: law.recordDead,
        record_dead_reason: recordDeadReason,
        ...(row.recordDigest ? { record_digest: row.recordDigest } : {}),
        ...(row.oldGoldClassProvided ? { oldgold_class: row.oldGoldClass } : {}),
        ...(row.oldGoldReasonsProvided ? { oldgold_reasons: row.oldGoldReasons } : {}),
        ...(row.revisitOnProvided ? { revisit_on: row.revisitOn } : {}),
        // Provenance plus the immutable raw-grade/hard-zero invariant.
        score_adjust_note: [String(body.note ?? label), law.scoreNote]
          .filter(Boolean).join("; ").slice(0, 400),
      });
    }
  }

  // Rationale quality on this batch — never blocks, always reported.
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
    duplicateInternalIds: duplicates,
    rowErrors: errors.slice(0, 50),
    errorCount: errors.length,
    hardZeroed: hardZeroed.slice(0, 20),
    hardZeroedCount: hardZeroed.length,
    resurfaceCurrentTam,
    resurfacedCount: resurfaced.length,
    resurfaced: resurfaced.slice(0, 200),
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

  if (dryRun) return NextResponse.json({ dryRun: true, wouldWrite: writes.length, ...summary });

  if (writes.length === 0 && (ambiguousInternalIds.length > 0 || deadReasonFailures.length > 0)) {
    return NextResponse.json({ error: "no safe score targets", label, ...summary }, { status: 422 });
  }

  for (let i = 0; i < snapshots.length; i += 500) {
    const { error } = await db.from("score_snapshots").insert(snapshots.slice(i, i + 500));
    if (error) {
      return NextResponse.json({
        error: `score snapshot failed before any company write: ${error.message}`,
        label,
        snapshottedBeforeFailure: i,
      }, { status: 500 });
    }
  }
  for (let i = 0; i < writes.length; i += 500) {
    const { error } = await db.from("companies").upsert(writes.slice(i, i + 500), { onConflict: "id" });
    if (error) {
      return NextResponse.json({ error: error.message, writtenBefore: i, label, hint: "prior values are in score_snapshots under this label" }, { status: 500 });
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
    snapshot: `score_snapshots where label='${label}' (complete prior_values; restoration requires explicit review)`,
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
