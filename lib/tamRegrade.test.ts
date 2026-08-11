import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  finalGradePublishSchema,
  tamCoordinationActionSchema,
  tamPdfUpdateSchema,
} from "./tamRegrade";

const assessment = {
  exact_id: "123456",
  final_score: 64,
  record_digest: "A complete chronological digest based on the full lead record.",
  old_gold_score: 58,
  old_gold_class: "stalled_warm",
  old_gold_reasons: ["Prior evaluation was independently verified."],
  intro_call_exists: true,
  opportunity_exists: false,
  revisit_on: null,
  dq_reason: "",
  score_adjust_note: "Validator confirmed the raw record grade.",
  validation: {
    status: "passed" as const,
    validated_by: "codex-review",
    validated_at: "2026-07-27T20:00:00Z",
  },
};

const provenanceData = {
  schema: "tam-grade-provenance" as const,
  version: 1 as const,
  runSlug: "ars-bs-tam-current",
  netsuiteInternalId: "123456",
  snapshotSha256: "d".repeat(64),
  method: "full-record-reader-plus-independent-full-record-validator" as const,
  pdfSha256: "b".repeat(64),
  pdfPageCount: 30,
  recordTextSha256: "c".repeat(64),
  candidateFileSha256: "e".repeat(64),
  validatorOutputSha256: "f".repeat(64),
  validatorHashScope: "canonical-record" as const,
  assessment,
};
const provenanceCanonicalJson = JSON.stringify(provenanceData);

const validGrade = {
  runSlug: "ars-bs-tam-current",
  netsuiteInternalId: "123456",
  actorKey: "codex",
  claimToken: "11111111-1111-4111-8111-111111111111",
  finalScore: 64,
  codexScore: 64,
  recordDigest: assessment.record_digest,
  provenance: {
    sha256: createHash("sha256").update(provenanceCanonicalJson).digest("hex"),
    objectPath: "ars-bs-tam-current/123456/provenance.json",
    canonicalJson: provenanceCanonicalJson,
    data: provenanceData,
  },
  validation: {
    status: "passed" as const,
    validatedBy: "codex-review",
    validatedAt: "2026-07-27T20:00:00Z",
  },
};
const checkpointPdf = {
  pdfObjectPath: "leads/123456/print.pdf",
  pdfSha256: "b".repeat(64),
  pdfPageCount: 30,
  pdfVerifiedAt: "2026-07-27T19:00:00Z",
  pdfCaptureSnapshotSha256: "d".repeat(64),
};

describe("validated final publish", () => {
  it("accepts one provenance-bound raw validated grade", () => {
    const parsed = finalGradePublishSchema.parse(validGrade);
    expect(parsed.codexScore).toBe(parsed.finalScore);
    expect(parsed.provenance.data.assessment.old_gold_score).toBe(58);
  });

  it("preserves the historical empty no-revisit marker for null normalization at publish", () => {
    expect(finalGradePublishSchema.safeParse({
      ...validGrade,
      provenance: {
        ...validGrade.provenance,
        data: {
          ...validGrade.provenance.data,
          assessment: { ...assessment, revisit_on: "" },
        },
      },
    }).success).toBe(true);
  });

  it("rejects a reader score or signal delta in codexScore", () => {
    const parsed = finalGradePublishSchema.safeParse({
      ...validGrade,
      codexScore: 61,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects cross-record or incomplete current-schema provenance", () => {
    expect(finalGradePublishSchema.safeParse({
      ...validGrade,
      provenance: {
        ...validGrade.provenance,
        data: { ...validGrade.provenance.data, netsuiteInternalId: "999" },
      },
    }).success).toBe(false);
    const { opportunity_exists: _missing, ...legacyAssessment } = assessment;
    expect(finalGradePublishSchema.safeParse({
      ...validGrade,
      provenance: {
        ...validGrade.provenance,
        data: { ...validGrade.provenance.data, assessment: legacyAssessment },
      },
    }).success).toBe(false);
  });

  it("requires dead-band Old Gold zero evidence", () => {
    const deadDigest = "A specific dated buyer-grounded dead reason.";
    expect(finalGradePublishSchema.safeParse({
      ...validGrade,
      finalScore: 8,
      codexScore: 8,
      recordDigest: deadDigest,
      provenance: {
        ...validGrade.provenance,
        data: {
          ...validGrade.provenance.data,
          assessment: {
            ...assessment,
            final_score: 8,
            record_digest: deadDigest,
            old_gold_score: 20,
          },
        },
      },
    }).success).toBe(false);
  });

  it("enforces exact dead-band class and specific-reason parity", () => {
    const deadAssessment = {
      ...assessment,
      final_score: 8,
      record_digest: "A specific dated buyer-grounded dead reason.",
      old_gold_score: 0,
      old_gold_class: "dead",
      dq_reason: "A specific dated buyer-grounded dead reason.",
    };
    const deadGrade = {
      ...validGrade,
      finalScore: 8,
      codexScore: 8,
      recordDigest: deadAssessment.record_digest,
      provenance: {
        ...validGrade.provenance,
        data: { ...validGrade.provenance.data, assessment: deadAssessment },
      },
    };
    expect(finalGradePublishSchema.safeParse(deadGrade).success).toBe(true);
    expect(finalGradePublishSchema.safeParse({
      ...deadGrade,
      provenance: {
        ...deadGrade.provenance,
        data: { ...deadGrade.provenance.data, assessment: { ...deadAssessment, old_gold_class: "insufficient" } },
      },
    }).success).toBe(false);
    expect(finalGradePublishSchema.safeParse({
      ...deadGrade,
      provenance: {
        ...deadGrade.provenance,
        data: { ...deadGrade.provenance.data, assessment: { ...deadAssessment, dq_reason: "" } },
      },
    }).success).toBe(false);
    expect(finalGradePublishSchema.safeParse({
      ...validGrade,
      provenance: {
        ...validGrade.provenance,
        data: { ...validGrade.provenance.data, assessment: { ...assessment, old_gold_class: "dead" } },
      },
    }).success).toBe(false);
  });
});

describe("leased coordination validation", () => {
  it("requires an exact claim token for renew, hold and release", () => {
    const heartbeat = tamCoordinationActionSchema.safeParse({
      action: "heartbeat",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      status: "working",
      netsuiteInternalId: "123456",
    });
    expect(heartbeat.success).toBe(false);

    const hold = tamCoordinationActionSchema.safeParse({
      action: "grade_status",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      netsuiteInternalId: "123456",
      status: "hold",
      holdReason: "Identity evidence is ambiguous.",
    });
    expect(hold.success).toBe(false);
  });

  it("accepts a bounded exact-claim heartbeat", () => {
    const parsed = tamCoordinationActionSchema.parse({
      action: "heartbeat",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      status: "working",
      netsuiteInternalId: "123456",
      claimToken: validGrade.claimToken,
      leaseSeconds: 1_800,
    });
    expect(parsed.action).toBe("heartbeat");
  });

  it("rejects unbounded lease requests", () => {
    expect(tamCoordinationActionSchema.safeParse({
      action: "claim",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      netsuiteInternalId: "123456",
      leaseSeconds: 86_400,
    }).success).toBe(false);
  });
});

describe("PDF and membership evidence", () => {
  it("requires complete verification evidence for a verified PDF", () => {
    expect(tamPdfUpdateSchema.safeParse({
      runSlug: "ars-bs-tam-current",
      actorKey: "claude-code",
      netsuiteInternalId: "123456",
      status: "verified",
    }).success).toBe(false);
    expect(tamPdfUpdateSchema.safeParse({
      runSlug: "ars-bs-tam-current",
      actorKey: "claude-code",
      netsuiteInternalId: "123456",
      status: "verified",
      objectPath: "ars-bs-tam-current/123456/hash.pdf",
      sha256: "b".repeat(64),
      pageCount: 30,
      verifiedAt: "2026-07-27T20:00:00Z",
    }).success).toBe(true);
  });

  it("preserves every duplicate saved-search row and rejects count loss", () => {
    const row = {
      netsuiteInternalId: "123456",
      membershipStatus: "overlap" as const,
      tableRows: [{ "INTERNAL ID": "123456" }],
      sourceCoordinates: [{ page: 3, row: 17 }],
      savedSearchRowCount: 1,
      tableRowsSha256: "c".repeat(64),
    };
    expect(tamCoordinationActionSchema.safeParse({
      action: "membership",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      rows: [row],
    }).success).toBe(true);
    expect(tamCoordinationActionSchema.safeParse({
      action: "membership",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      rows: [{ ...row, savedSearchRowCount: 2 }],
    }).success).toBe(false);
  });
});

describe("checkpoint seed validation", () => {
  it("requires a disjoint full-membership cohort manifest", () => {
    const begin = tamCoordinationActionSchema.safeParse({
      action: "checkpoint_seed_begin",
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
        removed: "b".repeat(64),
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
    });
    expect(begin.success).toBe(true);
    expect(tamCoordinationActionSchema.safeParse({
      ...(begin.success ? begin.data : {}),
      action: "checkpoint_seed_begin",
      cohortHashes: {
        current: "3".repeat(64),
        publishedComplete: "4".repeat(64),
        legacySchemaRecovery: "5".repeat(64),
        lostStagingRecovery: "6".repeat(64),
        activeHold: "7".repeat(64),
        unrepresented: "8".repeat(64),
      },
    }).success).toBe(false);

    const countsWithoutRemoved = {
      currentTotal: 6_949,
      pdfVerified: 6_949,
      publishedComplete: 2_696,
      legacySchemaRecovery: 2_240,
      lostStagingRecovery: 3,
      activeHold: 49,
      unrepresented: 1_961,
    };
    expect(tamCoordinationActionSchema.safeParse({
      ...(begin.success ? begin.data : {}),
      action: "checkpoint_seed_begin",
      expectedCounts: countsWithoutRemoved,
    }).success).toBe(false);

    const incomplete = tamCoordinationActionSchema.safeParse({
      ...(begin.success ? begin.data : {}),
      action: "checkpoint_seed_begin",
      expectedCounts: {
        currentTotal: 6_949,
        pdfVerified: 6_949,
        publishedComplete: 2_696,
        legacySchemaRecovery: 2_239,
        lostStagingRecovery: 3,
        activeHold: 49,
        unrepresented: 1_961,
      },
    });
    expect(incomplete.success).toBe(false);
  });

  it("accepts a complete historical final even when its legacy codexScore differs", () => {
    const parsed = tamCoordinationActionSchema.safeParse({
      action: "checkpoint_seed_batch",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      seedToken: validGrade.claimToken,
      rows: [{
        recoveryCohort: "published_complete",
        netsuiteInternalId: "123456",
        membershipOrdinal: 17,
        tableRowsSha256: "c".repeat(64),
        ...checkpointPdf,
        finalAssessmentLineSha256: "1".repeat(64),
        publishQueueLineSha256: "2".repeat(64),
        historicalReceiptSha256: "3".repeat(64),
        historicalPublishedAt: "2026-08-10T20:01:00Z",
        finalScore: 64,
        codexScore: 51,
        recordDigest: assessment.record_digest,
        provenance: validGrade.provenance,
        validation: validGrade.validation,
      }],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires exact source hashes for holds and staged recoveries", () => {
    const base = {
      action: "checkpoint_seed_batch",
      runSlug: "ars-bs-tam-current",
      actorKey: "codex",
      seedToken: validGrade.claimToken,
    };
    expect(tamCoordinationActionSchema.safeParse({
      ...base,
      rows: [{
        recoveryCohort: "active_hold",
        netsuiteInternalId: "123456",
        membershipOrdinal: 18,
        tableRowsSha256: "c".repeat(64),
        ...checkpointPdf,
        holdFileSha256: "4".repeat(64),
        holdReason: "Exact entity attribution remains ambiguous.",
      }],
    }).success).toBe(true);
    expect(tamCoordinationActionSchema.safeParse({
      ...base,
      rows: [{
        recoveryCohort: "active_hold",
        netsuiteInternalId: "123456",
        membershipOrdinal: 18,
        ...checkpointPdf,
        holdFileSha256: "4".repeat(64),
        holdReason: "Exact entity attribution remains ambiguous.",
      }],
    }).success).toBe(false);
    expect(tamCoordinationActionSchema.safeParse({
      ...base,
      rows: [{
        recoveryCohort: "legacy_schema_recovery",
        netsuiteInternalId: "123456",
        membershipOrdinal: 18,
        tableRowsSha256: "c".repeat(64),
        ...checkpointPdf,
        finalAssessmentLineSha256: "4".repeat(64),
      }],
    }).success).toBe(false);
  });
});
