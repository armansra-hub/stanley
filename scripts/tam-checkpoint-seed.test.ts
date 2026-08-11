import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, sha256Text } from "./tam-coordination-sync.mjs";
import {
  applyCheckpointSeed,
  buildCheckpointSeedBundle,
  CHECKPOINT_SEED_APPLY_CONFIRMATION,
  parseCheckpointArgs,
  pythonAsciiCanonicalJson,
  validateCompletedEvidenceGate,
} from "./tam-checkpoint-seed.mjs";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function orderedIdHash(ids: string[]) {
  return sha256(ids.map((id) => `${id}\n`).join(""));
}

function pdfBindingSha256(row: any) {
  const verifiedAt = new Date(row.pdfVerifiedAt).toISOString()
    .replace(/\.(\d{3})Z$/, (_match, milliseconds) => `.${milliseconds}000Z`);
  return sha256(`${row.netsuiteInternalId}\t${row.pdfObjectPath}\t${row.pdfSha256}\t${row.pdfPageCount}\t${verifiedAt}\n`);
}

function csv(rows: Array<Array<string | number>>) {
  return `${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
}

async function writeJson(filePath: string, value: unknown) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, bytes);
  return sha256(bytes);
}

async function makeCheckpointFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tam-checkpoint-seed-"));
  const directories = {
    provenance: path.join(root, "provenance"),
    receipts: path.join(root, "published"),
    holds: path.join(root, "holds"),
  };
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));
  const ids = ["101", "202", "303", "404", "505"];
  const snapshot = "a".repeat(64);
  const priorSnapshot = "b".repeat(64);
  const membershipPath = path.join(root, "coordination_membership.jsonl");
  const removedMembershipPath = path.join(root, "coordination_removed_ids.json");
  const evidenceMembershipPath = path.join(root, "current_membership.csv");
  const pdfInventoryPath = path.join(root, "current_pdf_inventory.csv");
  const pdfReconciliationPath = path.join(root, "pdf_reconciliation.json");
  const finalAssessmentsPath = path.join(root, "final_assessments.jsonl");
  const publishQueuePath = path.join(root, "publish_queue.jsonl");
  const gradingManifestPath = path.join(root, "grading_manifest.json");
  const liveReconciliationPath = path.join(root, "live_reconciliation.json");
  const evidenceStatePath = path.join(root, "evidence_state.json");
  const evidenceReceiptPath = path.join(root, "evidence_receipt.json");

  const membershipText = `${ids.map((netsuiteInternalId, index) => JSON.stringify({
    netsuiteInternalId,
    tableRowsSha256: (index + 10).toString(16).repeat(64),
  })).join("\n")}\n`;
  const evidenceMembershipText = csv([["Internal ID"], ...ids.map((id) => [id])]);
  const evidenceEntries = ids.map((id, index) => ({
    netsuiteInternalId: id,
    locator: `leads/${id}/print.pdf`,
    sha256: String(index + 1).repeat(64),
    pageCount: index + 1,
    verifiedAt: `2026-08-0${index + 1}T12:00:00.000Z`,
    bytes: 1_000 + index,
    captureSha256: (index + 6).toString(16).repeat(64),
    captureSnapshotSha256: index === 0 ? snapshot : priorSnapshot,
  }));
  const inventoryText = csv([
    [
      "Internal ID",
      "Captured At UTC",
      "PDF SHA256",
      "PDF Pages",
      "PDF Bytes",
      "Capture Metadata SHA256",
      "Capture Snapshot SHA256",
    ],
    ...evidenceEntries.map((entry) => [
      entry.netsuiteInternalId,
      entry.verifiedAt,
      entry.sha256,
      entry.pageCount,
      entry.bytes,
      entry.captureSha256,
      entry.captureSnapshotSha256,
    ]),
  ]);
  await Promise.all([
    writeFile(membershipPath, membershipText),
    writeFile(evidenceMembershipPath, evidenceMembershipText),
    writeFile(pdfInventoryPath, inventoryText),
    writeJson(removedMembershipPath, { runSlug: "ars-bs-tam-current", netsuiteInternalIds: ["606"] }),
  ]);
  await writeJson(pdfReconciliationPath, {
    schema: "tam-current-pdf-reconciliation",
    version: 1,
    status: "complete",
    current_snapshot_sha256: snapshot,
    allowed_prior_snapshot_sha256: [priorSnapshot],
    counts: { current_membership_ids: ids.length },
    exact_set_checks: {
      every_current_id_has_one_valid_package: true,
      historical_inventory_exactly_equals_removed: true,
    },
    inputs: { membership: { sha256: sha256(evidenceMembershipText) } },
    outputs: { current_pdf_inventory_sha256: sha256(inventoryText) },
  });

  const validation = {
    status: "passed",
    validated_by: "validator",
    validated_at: "2026-08-10T20:00:00.000Z",
  };
  const completeAssessment = {
    exact_id: "101",
    final_score: 20,
    record_digest: "2026-08-10 — complete chronology.",
    score_adjust_note: "No adjustment.",
    pdf_sha256: evidenceEntries[0].sha256,
    pdf_page_count: evidenceEntries[0].pageCount,
    old_gold_score: 12,
    old_gold_class: "insufficient",
    old_gold_reasons: ["No verified opportunity."],
    intro_call_exists: false,
    opportunity_exists: false,
    revisit_on: null,
    dq_reason: "",
    validation,
  };
  const legacyAssessment = {
    exact_id: "202",
    final_score: 18,
    record_digest: "Legacy schema final.",
    validation,
  };
  const provenanceData = {
    schema: "tam-grade-provenance",
    version: 1,
    runSlug: "ars-bs-tam-current",
    netsuiteInternalId: "101",
    method: "full-record-reader-plus-independent-full-record-validator",
    validatorHashScope: "canonical-record",
    snapshotSha256: snapshot,
    pdfSha256: evidenceEntries[0].sha256,
    pdfPageCount: evidenceEntries[0].pageCount,
    assessment: completeAssessment,
  };
  const canonicalProvenance = pythonAsciiCanonicalJson(provenanceData);
  await writeFile(path.join(directories.provenance, "101.json"), canonicalProvenance);
  const queueRows = [{
    netsuiteInternalId: "101",
    finalScore: 20,
    codexScore: 9,
    recordDigest: completeAssessment.record_digest,
    scoreAdjustNote: completeAssessment.score_adjust_note,
    provenance: {
      data: provenanceData,
      objectPath: "ars-bs-tam-current/101/grade-provenance.json",
      sha256: sha256(canonicalProvenance),
    },
    validation: {
      status: "passed",
      validatedBy: validation.validated_by,
      validatedAt: validation.validated_at,
    },
  }, {
    netsuiteInternalId: "202",
    finalScore: 18,
    codexScore: 18,
    recordDigest: legacyAssessment.record_digest,
  }];
  const finalText = `${[completeAssessment, legacyAssessment].map((row) => JSON.stringify(row)).join("\n")}\n`;
  const queueText = `${queueRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await Promise.all([
    writeFile(finalAssessmentsPath, finalText),
    writeFile(publishQueuePath, queueText),
  ]);
  await writeJson(path.join(directories.receipts, "101.json"), {
    publishedAt: "2026-08-10T20:01:00.123456+00:00",
    record: completeAssessment,
  });
  const lostReceiptPath = path.join(directories.receipts, "303.json");
  const lostReceiptSha256 = await writeJson(lostReceiptPath, {
    publishedAt: "2026-08-10T20:02:00Z",
    record: { exact_id: "303" },
  });
  await Promise.all([
    writeJson(path.join(directories.holds, "404.json"), {
      exact_id: "404",
      validation: { status: "hold", hold_reason: "Exact identity needs adjudication." },
    }),
    // A later final supersedes a stale hold artifact; it is not an active hold.
    writeJson(path.join(directories.holds, "101.json"), {
      exact_id: "101",
      validation: { status: "hold", hold_reason: "Superseded by the exact final." },
    }),
  ]);
  const liveReconciliationSha256 = await writeJson(liveReconciliationPath, {
    schema: "tam-live-final-reconciliation",
    version: 1,
    allCanonicalFinalsLive: true,
    canonicalFinals: 2,
    liveExactIds: 2,
    mismatchCountAfter: 0,
    duplicateLiveIds: [],
  });
  await writeJson(gradingManifestPath, {
    assessment_sha256: sha256(finalText),
    queue_sha256: sha256(queueText),
    staged_final_count: 2,
    production_reconciliation_sha256: liveReconciliationSha256,
  });

  const exactIdsSha256 = sha256Text(canonicalJsonBytes(ids));
  const corpusSha256 = sha256Text(canonicalJsonBytes(evidenceEntries));
  const evidenceReadbackSha256 = sha256Text(canonicalJsonBytes(evidenceEntries.map((entry) => ({
    netsuiteInternalId: entry.netsuiteInternalId,
    locator: entry.locator,
    sha256: entry.sha256,
    pageCount: entry.pageCount,
    verifiedAt: entry.verifiedAt,
  }))));
  const sharedEvidence = {
    runSlug: "ars-bs-tam-current",
    expectedCount: ids.length,
    membershipFileSha256: sha256(evidenceMembershipText),
    inventoryFileSha256: sha256(inventoryText),
    exactIdsSha256,
    corpusSha256,
  };
  await writeJson(evidenceStatePath, {
    schema: "tam-local-evidence-sync",
    version: 1,
    ...sharedEvidence,
    evidenceReadbackSha256,
    status: "complete",
    confirmedPrefix: ids.length,
    finalCounts: { current: ids.length, pdfVerified: ids.length },
    evidenceReadbackRecords: ids.length,
    blocker: null,
  });
  await writeJson(evidenceReceiptPath, {
    schema: "tam-local-evidence-sync-receipt",
    version: 1,
    ...sharedEvidence,
    mode: "apply",
    stopReason: "worklist_exhausted",
    exactEntriesValidated: ids.length,
    totalPdfPages: evidenceEntries.reduce((total, entry) => total + entry.pageCount, 0),
    totalPdfBytes: evidenceEntries.reduce((total, entry) => total + entry.bytes, 0),
    error: null,
    result: {
      statePath: evidenceStatePath,
      confirmedTotal: ids.length,
      evidenceReadbackRecords: ids.length,
      evidenceReadbackSha256,
    },
  });

  return {
    ids,
    paths: {
      membership: membershipPath,
      removedMembership: removedMembershipPath,
      evidenceMembership: evidenceMembershipPath,
      pdfInventory: pdfInventoryPath,
      pdfReconciliation: pdfReconciliationPath,
      finalAssessments: finalAssessmentsPath,
      publishQueue: publishQueuePath,
      gradingManifest: gradingManifestPath,
      liveReconciliation: liveReconciliationPath,
      provenanceDirectory: directories.provenance,
      publishedReceiptsDirectory: directories.receipts,
      holdsDirectory: directories.holds,
      evidenceState: evidenceStatePath,
      evidenceReceipt: evidenceReceiptPath,
    },
    expectedCounts: {
      currentTotal: 5,
      removedTotal: 1,
      pdfVerified: 5,
      publishedComplete: 1,
      legacySchemaRecovery: 1,
      lostStagingRecovery: 1,
      activeHold: 1,
      unrepresented: 1,
    },
    lostReceiptSha256,
  };
}

describe("TAM checkpoint seed builder", () => {
  it("reproduces Python ensure_ascii canonical JSON without a trailing newline", () => {
    const canonical = pythonAsciiCanonicalJson({ z: "—", emoji: "😀", a: "é" });
    expect(canonical).toBe('{"a":"\\u00e9","emoji":"\\ud83d\\ude00","z":"\\u2014"}');
    expect(canonical.endsWith("\n")).toBe(false);
  });

  it("derives a full disjoint five-cohort manifest and drops legacy codexScore", async () => {
    const fixture = await makeCheckpointFixture();
    const bundle = await buildCheckpointSeedBundle({
      paths: fixture.paths,
      releaseCommit: "c".repeat(40),
      strictProduction: false,
      expectedCounts: fixture.expectedCounts!,
      lostReceiptHashes: { "303": fixture.lostReceiptSha256! },
    });
    expect(bundle.rows.map((row: any) => row.recoveryCohort)).toEqual([
      "published_complete",
      "legacy_schema_recovery",
      "lost_staging_recovery",
      "active_hold",
      "unrepresented",
    ]);
    expect(bundle.rows.map((row: any) => row.membershipOrdinal)).toEqual([1, 2, 3, 4, 5]);
    expect(bundle.rows[0]).not.toHaveProperty("codexScore");
    expect((bundle.rows[0] as any).provenance.canonicalJson).toContain("\\u2014");
    expect(bundle.cohortHashes.current).toBe(orderedIdHash(fixture.ids));
    expect(bundle.cohortHashes.removed).toBe(orderedIdHash(["606"]));
    expect(bundle.sourceHashes.localEvidenceState).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.sourceHashes.evidence_readback_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.sourceHashes.coordination_removed_ids_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.rows.every((row: any) => /^[0-9a-f]{64}$/.test(row.tableRowsSha256))).toBe(true);
    expect(bundle.manifest.removedMembership).toMatchObject({ count: 1, orderedIdSha256: orderedIdHash(["606"]) });
    expect(bundle.manifest.verification).toMatchObject({
      publishedCompleteProvenanceHashesVerified: 1,
      pdfBindingsVerified: 5,
      supersededHoldArtifactsIgnored: 1,
    });
  });

  it("rejects a dry-run/failure evidence receipt even if a full prefix is claimed", () => {
    const ids = ["101"];
    const entry = {
      netsuiteInternalId: "101",
      locator: "leads/101/print.pdf",
      sha256: "1".repeat(64),
      pageCount: 1,
      verifiedAt: "2026-08-10T20:00:00.000Z",
      bytes: 100,
      captureSha256: "2".repeat(64),
      captureSnapshotSha256: "3".repeat(64),
    };
    expect(() => validateCompletedEvidenceGate({
      stateArtifact: { path: "state.json", sha256: "4".repeat(64), value: { confirmedPrefix: 1 } },
      receiptArtifact: {
        path: "receipt.json",
        sha256: "5".repeat(64),
        value: {
          schema: "tam-local-evidence-sync-receipt",
          version: 1,
          mode: "dry-run",
          stopReason: "validation_failed",
          result: null,
        },
      },
      evidenceMembershipArtifact: { sha256: "6".repeat(64) },
      pdfInventoryArtifact: { sha256: "7".repeat(64) },
      evidenceById: new Map([["101", entry]]),
      expectedIds: ids,
    } as any)).toThrow("successful completed APPLY local-evidence receipt");
  });

  it("calls begin, bounded batches, finalize, and full exact readback in order", async () => {
    const rows = [
      {
        recoveryCohort: "published_complete",
        netsuiteInternalId: "101",
        membershipOrdinal: 1,
        tableRowsSha256: "7".repeat(64),
        pdfObjectPath: "leads/101/print.pdf",
        pdfSha256: "1".repeat(64),
        pdfPageCount: 1,
        pdfVerifiedAt: "2026-08-10T20:00:00.000Z",
        pdfCaptureSnapshotSha256: "a".repeat(64),
        finalAssessmentLineSha256: "7".repeat(64),
        publishQueueLineSha256: "8".repeat(64),
        historicalReceiptSha256: "9".repeat(64),
        historicalPublishedAt: "2026-08-10T20:01:00.000Z",
        finalScore: 20,
        provenance: { sha256: "2".repeat(64) },
      },
      {
        recoveryCohort: "active_hold",
        netsuiteInternalId: "202",
        membershipOrdinal: 2,
        tableRowsSha256: "8".repeat(64),
        pdfObjectPath: "leads/202/print.pdf",
        pdfSha256: "3".repeat(64),
        pdfPageCount: 2,
        pdfVerifiedAt: "2026-08-10T20:00:00.000Z",
        pdfCaptureSnapshotSha256: "b".repeat(64),
        holdFileSha256: "e".repeat(64),
        holdReason: "Exact identity needs adjudication.",
      },
    ];
    const cohortHashes = {
      current: orderedIdHash(["101", "202"]),
      removed: orderedIdHash([]),
      publishedComplete: orderedIdHash(["101"]),
      legacySchemaRecovery: orderedIdHash([]),
      lostStagingRecovery: orderedIdHash([]),
      activeHold: orderedIdHash(["202"]),
      unrepresented: orderedIdHash([]),
    };
    const expectedCounts = {
      currentTotal: 2,
      removedTotal: 0,
      pdfVerified: 2,
      publishedComplete: 1,
      legacySchemaRecovery: 0,
      lostStagingRecovery: 0,
      activeHold: 1,
      unrepresented: 0,
    };
    const sourceHashes = { source: "4".repeat(64) };
    const bundle: any = {
      runSlug: "ars-bs-tam-current",
      releaseCommit: "c".repeat(40),
      manifestObjectPath: "ars-bs-tam-current/seed.json",
      manifestSha256: "5".repeat(64),
      rowsSha256: "6".repeat(64),
      rows,
      expectedCounts,
      cohortHashes,
      captureSnapshotHashes: { current: "a".repeat(64), allowedPrior: ["b".repeat(64)] },
      sourceHashes,
      removedIds: [],
    };
    const posts: string[] = [];
    const seedId = "seed-id";
    const api = {
      post: vi.fn(async (body: any) => {
        posts.push(body.action);
        if (body.action === "checkpoint_seed_begin") {
          return { seed: { seedId, seedToken: "11111111-1111-4111-8111-111111111111", status: "building" } };
        }
        if (body.action === "checkpoint_seed_batch") return { seed: { seedId, seeded: body.rows.length } };
        return { seed: { seedId, status: "complete" } };
      }),
      get: vi.fn(async (relativePath: string) => {
        const url = new URL(relativePath, "https://stanley.example");
        if (url.searchParams.get("view") === "records") {
          if (url.searchParams.get("current") === "false") return { total: 0, records: [] };
          return {
            total: 2,
            records: rows.map((row: any) => ({
              netsuite_internal_id: row.netsuiteInternalId,
              membership_ordinal: row.membershipOrdinal,
              recovery_cohort: row.recoveryCohort,
              checkpoint_seed_id: seedId,
              table_rows_sha256: row.tableRowsSha256,
              checkpoint_artifact_sha256: row.finalAssessmentLineSha256 ?? row.holdFileSha256 ?? null,
              checkpoint_payload_sha256: "f".repeat(64),
              checkpoint_source_hashes: {
                table_rows_sha256: row.tableRowsSha256,
                pdf_sha256: row.pdfSha256,
                pdf_binding_sha256: pdfBindingSha256(row),
                pdf_capture_snapshot_sha256: row.pdfCaptureSnapshotSha256,
                ...(row.finalAssessmentLineSha256 ? {
                  final_assessment_line_sha256: row.finalAssessmentLineSha256,
                  publish_queue_line_sha256: row.publishQueueLineSha256,
                  historical_receipt_sha256: row.historicalReceiptSha256,
                } : {}),
                ...(row.holdFileSha256 ? { hold_file_sha256: row.holdFileSha256 } : {}),
              },
              checkpoint_seeded_at: "2026-08-10T20:03:00.000Z",
              pdf_status: "verified",
              pdf_object_path: row.pdfObjectPath,
              pdf_sha256: row.pdfSha256,
              pdf_page_count: row.pdfPageCount,
              pdf_verified_at: row.pdfVerifiedAt,
              grade_status: row.recoveryCohort === "published_complete" ? "published" : "hold",
              final_score: row.finalScore ?? null,
              codex_score: row.finalScore ?? null,
              grade_provenance_sha256: row.provenance?.sha256 ?? null,
              publication_origin: row.recoveryCohort === "published_complete" ? "historical_live_import" : null,
              historical_published_at: row.historicalPublishedAt ?? null,
              hold_reason: row.holdReason ?? null,
            })),
          };
        }
        return {
          run: { status: "grading", completed_checkpoint_seed_id: seedId },
          checkpointSeed: {
            id: seedId,
            status: "complete",
            manifest_sha256: bundle.manifestSha256,
            release_commit: bundle.releaseCommit,
            expected_counts: expectedCounts,
            cohort_hashes: cohortHashes,
            source_hashes: sourceHashes,
          },
          counts: {
            current: 2,
            removed: 0,
            pdf_verified: 2,
            grade_published: 1,
            grade_pending: 0,
            grade_hold: 1,
            grade_reading: 0,
            grade_final: 0,
            lease_expired: 0,
          },
        };
      }),
    };
    const result = await applyCheckpointSeed({ api, bundle, batchSize: 1, statePath: undefined });
    expect(posts).toEqual([
      "checkpoint_seed_begin",
      "checkpoint_seed_batch",
      "checkpoint_seed_batch",
      "checkpoint_seed_finalize",
    ]);
    expect(result).toMatchObject({ seedId, alreadyComplete: false });
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("keeps apply behind an explicit irreversible confirmation phrase", () => {
    expect(CHECKPOINT_SEED_APPLY_CONFIRMATION).toBe("APPLY_EXACT_TAM_CHECKPOINT_SEED_6949");
    expect(parseCheckpointArgs(["--apply", "--confirm", CHECKPOINT_SEED_APPLY_CONFIRMATION])).toEqual({
      apply: true,
      confirm: CHECKPOINT_SEED_APPLY_CONFIRMATION,
    });
  });
});
