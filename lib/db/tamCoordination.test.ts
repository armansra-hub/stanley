import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

function pythonAsciiCanonicalJson(value: unknown): string {
  function sort(valueToSort: unknown): unknown {
    if (Array.isArray(valueToSort)) return valueToSort.map(sort);
    if (!valueToSort || typeof valueToSort !== "object") return valueToSort;
    return Object.fromEntries(
      Object.entries(valueToSort as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sort(child)]),
    );
  }
  return JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  beginTamCheckpointSeed,
  claimTamGradeWork,
  finalizeTamCheckpointSeed,
  heartbeatTamActor,
  publishValidatedTamGrade,
  seedTamCheckpointBatch,
  setTamGradeWorkStatus,
} from "./tamCoordination";

const token = "11111111-1111-4111-8111-111111111111";
const digest = "Complete full-record chronology and independently validated rationale.";
const validation = {
  status: "passed" as const,
  validated_by: "independent-validator",
  validated_at: "2026-08-10T20:00:00Z",
};
const assessment = {
  exact_id: "123456",
  final_score: 38,
  record_digest: digest,
  old_gold_score: 52,
  old_gold_class: "timing_arrived",
  old_gold_reasons: ["Opportunity confirmed: 2024-01-03 — #123 ERP evaluation."],
  intro_call_exists: true,
  opportunity_exists: true,
  revisit_on: null,
  dq_reason: "",
  score_adjust_note: "Independent validator confirmed the raw grade.",
  validation,
};
const provenanceData = {
  schema: "tam-grade-provenance" as const,
  version: 1 as const,
  runSlug: "ars-bs-tam-current",
  netsuiteInternalId: "123456",
  snapshotSha256: "d".repeat(64),
  method: "full-record-reader-plus-independent-full-record-validator" as const,
  pdfSha256: "b".repeat(64),
  pdfPageCount: 12,
  recordTextSha256: "c".repeat(64),
  candidateFileSha256: "e".repeat(64),
  validatorOutputSha256: "f".repeat(64),
  validatorHashScope: "canonical-record" as const,
  assessment,
};
const provenanceCanonicalJson = JSON.stringify(provenanceData);
const publishInput = {
  runSlug: "ars-bs-tam-current",
  netsuiteInternalId: "123456",
  actorKey: "codex",
  claimToken: token,
  finalScore: 38,
  codexScore: 38,
  recordDigest: digest,
  provenance: {
    sha256: createHash("sha256").update(provenanceCanonicalJson).digest("hex"),
    objectPath: "ars-bs-tam-current/123456/grade-provenance.json",
    canonicalJson: provenanceCanonicalJson,
    data: provenanceData,
  },
  validation: {
    status: "passed" as const,
    validatedBy: validation.validated_by,
    validatedAt: validation.validated_at,
  },
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
});

describe("TAM coordination RPC transport", () => {
  it("passes resume token and bounded lease to the atomic claim RPC", async () => {
    await claimTamGradeWork({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      netsuiteInternalId: "123456",
      includeHold: false,
      claimToken: token,
      leaseSeconds: 1_800,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_tam_regrade_record", expect.objectContaining({
      p_netsuite_internal_id: "123456",
      p_actor_key: "codex",
      p_claim_token: token,
      p_lease_seconds: 1_800,
    }));
  });

  it("renews and releases only the exact fenced claim", async () => {
    await heartbeatTamActor({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      status: "working",
      metadata: {},
      netsuiteInternalId: "123456",
      claimToken: token,
      leaseSeconds: 1_800,
    });
    await setTamGradeWorkStatus({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      netsuiteInternalId: "123456",
      claimToken: token,
      status: "pending",
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "heartbeat_tam_regrade_actor", expect.objectContaining({
      p_netsuite_internal_id: "123456",
      p_claim_token: token,
    }));
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "set_tam_regrade_work_status", expect.objectContaining({
      p_netsuite_internal_id: "123456",
      p_claim_token: token,
      p_status: "pending",
    }));
  });

  it("publishes the raw validated grade and current evidence without signal inputs", async () => {
    await publishValidatedTamGrade(publishInput);

    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toMatchObject({
      p_claim_token: token,
      p_final_score: 38,
      p_assessment_old_gold_score: 52,
      p_old_gold_class: "timing_arrived",
      p_intro_call_exists: true,
      p_opportunity_exists: true,
      p_record_dead: false,
      p_provenance_canonical_json: provenanceCanonicalJson,
      p_provenance_object_path: publishInput.provenance.objectPath,
    });
    expect(args).not.toHaveProperty("p_codex_score");
    expect(Object.keys(args).some((key) => /signal|trigger|growth/i.test(key))).toBe(false);
  });

  it("normalizes the historical empty no-revisit marker to an RPC null", async () => {
    const emptyRevisitData = {
      ...provenanceData,
      assessment: { ...assessment, revisit_on: "" as const },
    };
    const canonicalJson = JSON.stringify(emptyRevisitData);
    await publishValidatedTamGrade({
      ...publishInput,
      provenance: {
        ...publishInput.provenance,
        data: emptyRevisitData,
        canonicalJson,
        sha256: createHash("sha256").update(canonicalJson).digest("hex"),
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("publish_tam_regrade_final", expect.objectContaining({
      p_revisit_on: null,
    }));
  });

  it("rejects a provenance mutation that retains the prior receipt hash", async () => {
    await expect(publishValidatedTamGrade({
      ...publishInput,
      provenance: {
        ...publishInput.provenance,
        data: {
          ...provenanceData,
          assessment: { ...assessment, old_gold_score: 51 },
        },
      },
    })).rejects.toThrow("canonical JSON differs from structured data");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses fenced checkpoint RPCs and drops an untrusted historical codexScore", async () => {
    await beginTamCheckpointSeed({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      manifestSha256: "1".repeat(64),
      manifestObjectPath: "ars-bs-tam-current/checkpoint-seed.json",
      releaseCommit: "2".repeat(40),
      expectedCounts: {
        currentTotal: 6_949,
        removedTotal: 34,
        pdfVerified: 6_949,
        publishedComplete: 2_696,
        legacySchemaRecovery: 2_240,
        lostStagingRecovery: 3,
        activeHold: 49,
        unrepresented: 1_961,
      },
      cohortHashes: {
        current: "3".repeat(64),
        removed: "c".repeat(64),
        publishedComplete: "4".repeat(64),
        legacySchemaRecovery: "5".repeat(64),
        lostStagingRecovery: "6".repeat(64),
        activeHold: "7".repeat(64),
        unrepresented: "8".repeat(64),
      },
      captureSnapshotHashes: {
        current: "9".repeat(64),
        allowedPrior: ["a".repeat(64)],
      },
      sourceHashes: { pdf_reconciliation_manifest_sha256: "b".repeat(64) },
    });
    await seedTamCheckpointBatch({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      seedToken: token,
      rows: [{
        recoveryCohort: "published_complete",
        netsuiteInternalId: "123456",
        membershipOrdinal: 1,
        tableRowsSha256: "c".repeat(64),
        pdfObjectPath: "leads/123456/print.pdf",
        pdfSha256: "b".repeat(64),
        pdfPageCount: 12,
        pdfVerifiedAt: "2026-08-10T19:00:00Z",
        pdfCaptureSnapshotSha256: "d".repeat(64),
        finalAssessmentLineSha256: "1".repeat(64),
        publishQueueLineSha256: "2".repeat(64),
        historicalPublishedAt: "2026-08-10T20:01:00Z",
        finalScore: 38,
        codexScore: 12,
        recordDigest: digest,
        provenance: publishInput.provenance,
        validation: publishInput.validation,
      }],
    });
    await finalizeTamCheckpointSeed({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      seedToken: token,
    });

    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "begin_tam_regrade_checkpoint_seed", expect.objectContaining({
      p_manifest_sha256: "1".repeat(64),
      p_expected_counts: expect.objectContaining({ publishedComplete: 2_696 }),
      p_capture_snapshot_hashes: expect.objectContaining({ current: "9".repeat(64) }),
    }));
    const [, batchArgs] = mocks.rpc.mock.calls[1] as [string, { p_rows: Array<Record<string, unknown>> }];
    expect(mocks.rpc.mock.calls[1][0]).toBe("seed_tam_regrade_checkpoint_batch");
    expect(batchArgs.p_rows[0]).not.toHaveProperty("codexScore");
    expect(batchArgs.p_rows[0]).toHaveProperty("finalScore", 38);
    expect(mocks.rpc).toHaveBeenNthCalledWith(3, "finalize_tam_regrade_checkpoint_seed", expect.objectContaining({
      p_seed_token: token,
    }));
  });

  it("preserves exact Python ASCII canonical provenance bytes without appending a newline", async () => {
    const unicodeDigest = "Complete chronology — independently validated.";
    const unicodeAssessment = { ...assessment, record_digest: unicodeDigest };
    const unicodeData = { ...provenanceData, assessment: unicodeAssessment };
    const canonicalJson = pythonAsciiCanonicalJson(unicodeData);
    expect(canonicalJson).toContain("\\u2014");
    expect(canonicalJson.endsWith("\n")).toBe(false);

    await seedTamCheckpointBatch({
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      seedToken: token,
      rows: [{
        recoveryCohort: "published_complete",
        netsuiteInternalId: "123456",
        membershipOrdinal: 1,
        tableRowsSha256: "c".repeat(64),
        pdfObjectPath: "leads/123456/print.pdf",
        pdfSha256: "b".repeat(64),
        pdfPageCount: 12,
        pdfVerifiedAt: "2026-08-10T19:00:00Z",
        pdfCaptureSnapshotSha256: "d".repeat(64),
        finalAssessmentLineSha256: "1".repeat(64),
        publishQueueLineSha256: "2".repeat(64),
        historicalPublishedAt: "2026-08-10T20:01:00Z",
        finalScore: 38,
        recordDigest: unicodeDigest,
        provenance: {
          sha256: createHash("sha256").update(canonicalJson).digest("hex"),
          objectPath: publishInput.provenance.objectPath,
          canonicalJson,
          data: unicodeData,
        },
        validation: publishInput.validation,
      }],
    });
    const [, args] = mocks.rpc.mock.calls[0] as [string, { p_rows: Array<{ provenance: { canonicalJson: string } }> }];
    expect(args.p_rows[0].provenance.canonicalJson).toBe(canonicalJson);
  });
});
