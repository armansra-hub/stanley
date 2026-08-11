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

describe("validated final publish", () => {
  it("accepts one provenance-bound raw validated grade", () => {
    const parsed = finalGradePublishSchema.parse(validGrade);
    expect(parsed.codexScore).toBe(parsed.finalScore);
    expect(parsed.provenance.data.assessment.old_gold_score).toBe(58);
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
