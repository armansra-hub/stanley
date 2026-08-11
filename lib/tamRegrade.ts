import { z } from "zod";

export const DEFAULT_TAM_RUN_SLUG = "ars-bs-tam-current";
export const TAM_PDF_BUCKET = "tam-lead-records";
export const DEFAULT_TAM_LEASE_SECONDS = 1_800;
export const MAX_TAM_LEASE_SECONDS = 3_600;

const nonBlank = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256");
const netsuiteInternalId = z
  .string()
  .regex(/^[0-9]+$/, "NetSuite Internal ID must be an exact numeric string");
const claimToken = z.string().uuid();
const metadata = z.record(z.string(), z.unknown());
const sourceCoordinate = z.object({
  page: z.number().int().positive(),
  row: z.number().int().positive(),
});
const leaseSeconds = z
  .number()
  .int()
  .min(60)
  .max(MAX_TAM_LEASE_SECONDS);

export const tamRunStatusSchema = z.enum([
  "initializing",
  "capturing",
  "grading",
  "paused",
  "complete",
  "failed",
]);

export const tamActorStatusSchema = z.enum([
  "idle",
  "working",
  "blocked",
  "offline",
  "complete",
]);

export const tamMembershipStatusSchema = z.enum(["new", "overlap", "removed"]);
export const tamPdfStatusSchema = z.enum([
  "missing",
  "queued",
  "downloading",
  "verified",
  "error",
  "stale",
]);
export const tamGradeStatusSchema = z.enum([
  "pending",
  "reading",
  "hold",
  "final",
  "published",
]);

export const bootstrapTamRunSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  searchId: netsuiteInternalId,
  mission: metadata,
  status: tamRunStatusSchema.default("initializing"),
  sourceTotal: z.number().int().nonnegative().optional(),
  sourceSnapshotSha256: sha256.optional(),
});

export const tamActorHeartbeatSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    actorKey: nonBlank,
    status: tamActorStatusSchema.default("working"),
    currentWork: z.string().trim().nullable().optional(),
    metadata: metadata.default({}),
    netsuiteInternalId: netsuiteInternalId.optional(),
    claimToken: claimToken.optional(),
    leaseSeconds: leaseSeconds.optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.netsuiteInternalId) !== Boolean(value.claimToken)) {
      context.addIssue({
        code: "custom",
        path: value.netsuiteInternalId ? ["claimToken"] : ["netsuiteInternalId"],
        message: "an exact Internal ID and claim token must be supplied together",
      });
    }
    if (value.leaseSeconds !== undefined && !value.claimToken) {
      context.addIssue({
        code: "custom",
        path: ["leaseSeconds"],
        message: "leaseSeconds is valid only for an exact claimed record",
      });
    }
  });

export const tamEventSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  actorKey: nonBlank,
  kind: nonBlank,
  netsuiteInternalId: netsuiteInternalId.nullable().optional(),
  summary: nonBlank,
  metadata: metadata.default({}),
});

export const tamMembershipRowSchema = z
  .object({
    netsuiteInternalId,
    companyName: z.string().trim().nullable().optional(),
    membershipStatus: z.enum(["new", "overlap"]),
    tableRows: z.array(metadata).min(1),
    sourceCoordinates: z.array(sourceCoordinate).min(1),
    savedSearchRowCount: z.number().int().positive(),
    tableRowsSha256: sha256,
  })
  .superRefine((value, context) => {
    if (value.tableRows.length !== value.savedSearchRowCount) {
      context.addIssue({
        code: "custom",
        path: ["savedSearchRowCount"],
        message: "saved-search row count must match tableRows length",
      });
    }
    if (value.sourceCoordinates.length !== value.savedSearchRowCount) {
      context.addIssue({
        code: "custom",
        path: ["sourceCoordinates"],
        message: "every saved-search row needs a source coordinate",
      });
    }
  });

export const tamMembershipBatchSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    actorKey: nonBlank,
    rows: z.array(tamMembershipRowSchema).min(1).max(1_000),
    sourceTotal: z.number().int().nonnegative().optional(),
    sourceSnapshotSha256: sha256.optional(),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, row] of value.rows.entries()) {
      if (seen.has(row.netsuiteInternalId)) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "netsuiteInternalId"],
          message: "each exact Internal ID may appear only once per membership batch",
        });
      }
      seen.add(row.netsuiteInternalId);
    }
  });

export const tamRemovedBatchSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  actorKey: nonBlank,
  netsuiteInternalIds: z.array(netsuiteInternalId).min(1).max(1_000),
  reason: nonBlank.default("Absent from current ARS BS TAM snapshot"),
});

export const tamPdfUpdateSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    actorKey: nonBlank,
    netsuiteInternalId,
    status: tamPdfStatusSchema,
    objectPath: z.string().trim().min(1).optional(),
    sha256: sha256.optional(),
    pageCount: z.number().int().positive().optional(),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
    error: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.status !== "verified") return;
    if (!value.objectPath) {
      context.addIssue({ code: "custom", path: ["objectPath"], message: "verified PDF needs an object path" });
    }
    if (!value.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "verified PDF needs a SHA-256" });
    }
    if (!value.pageCount) {
      context.addIssue({ code: "custom", path: ["pageCount"], message: "verified PDF needs a positive page count" });
    }
    if (!value.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "verified PDF needs a verification time" });
    }
  });

export const tamGradeWorkSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    actorKey: nonBlank,
    netsuiteInternalId,
    claimToken,
    status: z.enum(["pending", "hold"]),
    holdReason: z.string().trim().min(1).max(2_000).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "hold" && !value.holdReason) {
      context.addIssue({ code: "custom", path: ["holdReason"], message: "held grade needs a reason" });
    }
  });

export const tamGradeClaimSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  actorKey: nonBlank,
  netsuiteInternalId,
  includeHold: z.boolean().default(false),
  claimToken: claimToken.optional(),
  leaseSeconds: leaseSeconds.default(DEFAULT_TAM_LEASE_SECONDS),
});

export const tamAssessmentEvidenceSchema = z.object({
  exact_id: netsuiteInternalId,
  final_score: z.number().min(0).max(100),
  record_digest: nonBlank,
  old_gold_score: z.number().min(0).max(100),
  old_gold_class: nonBlank,
  old_gold_reasons: z.array(z.string()),
  intro_call_exists: z.boolean(),
  opportunity_exists: z.boolean(),
  // Historical validated finals used an empty string for "no revisit" in 32
  // otherwise-current records. Preserve those canonical provenance bytes and
  // normalize the RPC argument to SQL null at publication time.
  revisit_on: z.union([z.string().date(), z.literal("")]).nullable(),
  dq_reason: z.string().default(""),
  score_adjust_note: z.string().default(""),
  validation: z.object({
    status: z.literal("passed"),
    validated_by: nonBlank,
    validated_at: z.string().datetime({ offset: true }),
  }).passthrough(),
}).passthrough();

export const tamGradeProvenanceDataSchema = z.object({
  schema: z.literal("tam-grade-provenance"),
  version: z.literal(1),
  runSlug: nonBlank,
  netsuiteInternalId,
  snapshotSha256: sha256,
  method: z.literal("full-record-reader-plus-independent-full-record-validator"),
  pdfSha256: sha256,
  pdfPageCount: z.number().int().positive(),
  recordTextSha256: sha256,
  candidateFileSha256: sha256,
  validatorOutputSha256: sha256,
  validatorHashScope: z.literal("canonical-record"),
  assessment: tamAssessmentEvidenceSchema,
}).passthrough();

export const tamRecoveryCohortSchema = z.enum([
  "published_complete",
  "legacy_schema_recovery",
  "lost_staging_recovery",
  "active_hold",
  "unrepresented",
]);

export const tamCheckpointExpectedCountsSchema = z
  .object({
    currentTotal: z.number().int().positive(),
    removedTotal: z.number().int().nonnegative(),
    pdfVerified: z.number().int().nonnegative(),
    publishedComplete: z.number().int().nonnegative(),
    legacySchemaRecovery: z.number().int().nonnegative(),
    lostStagingRecovery: z.number().int().nonnegative(),
    activeHold: z.number().int().nonnegative(),
    unrepresented: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    const cohortTotal = value.publishedComplete
      + value.legacySchemaRecovery
      + value.lostStagingRecovery
      + value.activeHold
      + value.unrepresented;
    if (cohortTotal !== value.currentTotal) {
      context.addIssue({
        code: "custom",
        path: ["currentTotal"],
        message: "checkpoint cohorts must exactly cover the current membership",
      });
    }
    if (value.pdfVerified !== value.currentTotal) {
      context.addIssue({
        code: "custom",
        path: ["pdfVerified"],
        message: "every current checkpoint record must have a verified PDF",
      });
    }
  });

export const tamCheckpointCohortHashesSchema = z.object({
  current: sha256,
  removed: sha256,
  publishedComplete: sha256,
  legacySchemaRecovery: sha256,
  lostStagingRecovery: sha256,
  activeHold: sha256,
  unrepresented: sha256,
});

export const tamCheckpointSeedBeginSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  actorKey: nonBlank,
  manifestSha256: sha256,
  manifestObjectPath: nonBlank,
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/, "expected a full lowercase Git commit"),
  expectedCounts: tamCheckpointExpectedCountsSchema,
  cohortHashes: tamCheckpointCohortHashesSchema,
  captureSnapshotHashes: z.object({
    current: sha256,
    allowedPrior: z.array(sha256).max(10),
  }),
  sourceHashes: z.record(z.string(), sha256).default({}),
});

const tamCheckpointRowBase = z.object({
  netsuiteInternalId,
  membershipOrdinal: z.number().int().positive(),
  tableRowsSha256: sha256,
  pdfObjectPath: nonBlank,
  pdfSha256: sha256,
  pdfPageCount: z.number().int().positive(),
  pdfVerifiedAt: z.string().datetime({ offset: true }),
  pdfCaptureSnapshotSha256: sha256,
});

const tamCheckpointPublishedRowSchema = tamCheckpointRowBase.extend({
  recoveryCohort: z.literal("published_complete"),
  finalAssessmentLineSha256: sha256,
  publishQueueLineSha256: sha256,
  historicalReceiptSha256: sha256.optional(),
  historicalPublishedAt: z.string().datetime({ offset: true }),
  finalScore: z.number().min(0).max(100),
  // Historical queues can contain a reader-era value here. The seed transport
  // deliberately drops it and derives coordination codex_score from finalScore.
  codexScore: z.number().min(0).max(100).optional(),
  scoreAdjustNote: z.string().trim().nullable().optional(),
  recordDigest: nonBlank,
  provenance: z.object({
    sha256,
    objectPath: nonBlank,
    canonicalJson: z.string().min(2),
    data: tamGradeProvenanceDataSchema,
  }),
  validation: z.object({
    status: z.literal("passed"),
    validatedBy: nonBlank,
    validatedAt: z.string().datetime({ offset: true }),
  }),
}).superRefine((value, context) => {
  const assessment = value.provenance.data.assessment;
  const checks: Array<[boolean, (string | number)[], string]> = [
    [value.provenance.data.netsuiteInternalId === value.netsuiteInternalId, ["provenance", "data", "netsuiteInternalId"], "provenance Internal ID must match"],
    [assessment.exact_id === value.netsuiteInternalId, ["provenance", "data", "assessment", "exact_id"], "assessment Internal ID must match"],
    [assessment.final_score === value.finalScore, ["provenance", "data", "assessment", "final_score"], "assessment final score must match"],
    [assessment.record_digest === value.recordDigest, ["provenance", "data", "assessment", "record_digest"], "assessment digest must match"],
    [assessment.validation.validated_by === value.validation.validatedBy, ["provenance", "data", "assessment", "validation", "validated_by"], "assessment validator must match"],
    [assessment.validation.validated_at === value.validation.validatedAt, ["provenance", "data", "assessment", "validation", "validated_at"], "assessment validation time must match"],
    [value.scoreAdjustNote == null || value.scoreAdjustNote === assessment.score_adjust_note, ["scoreAdjustNote"], "scoreAdjustNote must match the provenance assessment"],
    [value.finalScore > 10 || assessment.old_gold_score === 0, ["provenance", "data", "assessment", "old_gold_score"], "dead-band assessments require old_gold_score 0"],
    [value.finalScore > 10 || assessment.old_gold_class === "dead", ["provenance", "data", "assessment", "old_gold_class"], "dead-band assessments require old_gold_class dead"],
    [value.finalScore <= 10 || assessment.old_gold_class !== "dead", ["provenance", "data", "assessment", "old_gold_class"], "live assessments cannot use old_gold_class dead"],
    [value.finalScore > 10 || assessment.dq_reason.trim().length > 0, ["provenance", "data", "assessment", "dq_reason"], "dead-band assessments require a specific reason"],
  ];
  for (const [valid, path, message] of checks) {
    if (!valid) context.addIssue({ code: "custom", path, message });
  }
});

const tamCheckpointLegacyRowSchema = tamCheckpointRowBase.extend({
  recoveryCohort: z.literal("legacy_schema_recovery"),
  finalAssessmentLineSha256: sha256,
  publishQueueLineSha256: sha256,
  historicalReceiptSha256: sha256.optional(),
});

const tamCheckpointLostRowSchema = tamCheckpointRowBase.extend({
  recoveryCohort: z.literal("lost_staging_recovery"),
  historicalReceiptSha256: sha256,
});

const tamCheckpointHoldRowSchema = tamCheckpointRowBase.extend({
  recoveryCohort: z.literal("active_hold"),
  holdFileSha256: sha256,
  holdReason: nonBlank.max(2_000),
});

const tamCheckpointUnrepresentedRowSchema = tamCheckpointRowBase.extend({
  recoveryCohort: z.literal("unrepresented"),
});

export const tamCheckpointSeedRowSchema = z.discriminatedUnion("recoveryCohort", [
  tamCheckpointPublishedRowSchema,
  tamCheckpointLegacyRowSchema,
  tamCheckpointLostRowSchema,
  tamCheckpointHoldRowSchema,
  tamCheckpointUnrepresentedRowSchema,
]);

export const tamCheckpointSeedBatchSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    actorKey: nonBlank,
    seedToken: claimToken,
    rows: z.array(tamCheckpointSeedRowSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const ordinals = new Set<number>();
    for (const [index, row] of value.rows.entries()) {
      if (ids.has(row.netsuiteInternalId)) {
        context.addIssue({ code: "custom", path: ["rows", index, "netsuiteInternalId"], message: "checkpoint batch repeats an exact Internal ID" });
      }
      if (ordinals.has(row.membershipOrdinal)) {
        context.addIssue({ code: "custom", path: ["rows", index, "membershipOrdinal"], message: "checkpoint batch repeats a membership ordinal" });
      }
      ids.add(row.netsuiteInternalId);
      ordinals.add(row.membershipOrdinal);
      if (row.recoveryCohort === "published_complete" && row.provenance.data.runSlug !== value.runSlug) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "provenance", "data", "runSlug"],
          message: "provenance run slug must match the checkpoint run",
        });
      }
    }
  });

export const tamCheckpointSeedFinalizeSchema = z.object({
  runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
  actorKey: nonBlank,
  seedToken: claimToken,
});

export const finalGradePublishSchema = z
  .object({
    runSlug: nonBlank.default(DEFAULT_TAM_RUN_SLUG),
    netsuiteInternalId,
    actorKey: nonBlank,
    claimToken,
    finalScore: z.number().min(0).max(100),
    // Kept as a compatibility field for existing staged payloads. It is the raw
    // validated grade now and may never carry a reader score or signal delta.
    codexScore: z.number().min(0).max(100).optional(),
    scoreAdjustNote: z.string().trim().nullable().optional(),
    recordDigest: nonBlank,
    provenance: z.object({
      sha256,
      objectPath: z.string().trim().min(1),
      // Exact UTF-8 bytes hashed by sha256. Keeping the bytes alongside the
      // parsed object lets both the trusted route and PostgreSQL prove that the
      // audit object was not changed after the receipt hash was created.
      canonicalJson: z.string().min(2),
      data: tamGradeProvenanceDataSchema,
    }),
    validation: z.object({
      status: z.literal("passed"),
      validatedBy: nonBlank,
      validatedAt: z.string().datetime({ offset: true }),
    }),
  })
  .superRefine((value, context) => {
    const assessment = value.provenance.data.assessment;
    const checks: Array<[boolean, (string | number)[], string]> = [
      [value.codexScore === undefined || value.codexScore === value.finalScore, ["codexScore"], "codexScore must equal the raw validated finalScore"],
      [value.provenance.data.runSlug === value.runSlug, ["provenance", "data", "runSlug"], "provenance run slug must match"],
      [value.provenance.data.netsuiteInternalId === value.netsuiteInternalId, ["provenance", "data", "netsuiteInternalId"], "provenance Internal ID must match"],
      [assessment.exact_id === value.netsuiteInternalId, ["provenance", "data", "assessment", "exact_id"], "assessment Internal ID must match"],
      [assessment.final_score === value.finalScore, ["provenance", "data", "assessment", "final_score"], "assessment final score must match"],
      [assessment.record_digest === value.recordDigest, ["provenance", "data", "assessment", "record_digest"], "assessment digest must match"],
      [assessment.validation.validated_by === value.validation.validatedBy, ["provenance", "data", "assessment", "validation", "validated_by"], "assessment validator must match"],
      [assessment.validation.validated_at === value.validation.validatedAt, ["provenance", "data", "assessment", "validation", "validated_at"], "assessment validation time must match"],
      [value.scoreAdjustNote == null || value.scoreAdjustNote === assessment.score_adjust_note, ["scoreAdjustNote"], "scoreAdjustNote must match the provenance assessment"],
      [value.finalScore > 10 || assessment.old_gold_score === 0, ["provenance", "data", "assessment", "old_gold_score"], "dead-band assessments require old_gold_score 0"],
      [value.finalScore > 10 || assessment.old_gold_class === "dead", ["provenance", "data", "assessment", "old_gold_class"], "dead-band assessments require old_gold_class dead"],
      [value.finalScore <= 10 || assessment.old_gold_class !== "dead", ["provenance", "data", "assessment", "old_gold_class"], "live assessments cannot use old_gold_class dead"],
      [value.finalScore > 10 || assessment.dq_reason.trim().length > 0, ["provenance", "data", "assessment", "dq_reason"], "dead-band assessments require a specific reason"],
    ];
    for (const [valid, path, message] of checks) {
      if (!valid) context.addIssue({ code: "custom", path, message });
    }
  });

export const finalGradePublishBatchSchema = z.object({
  // The operating standard is one claim, one final, one exact readback.
  grades: z.array(finalGradePublishSchema).length(1),
});

export const tamCoordinationActionSchema = z.discriminatedUnion("action", [
  bootstrapTamRunSchema.extend({ action: z.literal("bootstrap") }),
  tamCheckpointSeedBeginSchema.extend({ action: z.literal("checkpoint_seed_begin") }),
  tamCheckpointSeedBatchSchema.safeExtend({ action: z.literal("checkpoint_seed_batch") }),
  tamCheckpointSeedFinalizeSchema.extend({ action: z.literal("checkpoint_seed_finalize") }),
  tamActorHeartbeatSchema.safeExtend({ action: z.literal("heartbeat") }),
  tamEventSchema.extend({ action: z.literal("event") }),
  tamMembershipBatchSchema.safeExtend({ action: z.literal("membership") }),
  tamRemovedBatchSchema.extend({ action: z.literal("removed") }),
  tamPdfUpdateSchema.safeExtend({ action: z.literal("pdf") }),
  tamGradeClaimSchema.extend({ action: z.literal("claim") }),
  tamGradeWorkSchema.safeExtend({ action: z.literal("grade_status") }),
]);

export type BootstrapTamRunInput = z.infer<typeof bootstrapTamRunSchema>;
export type TamCheckpointSeedBeginInput = z.infer<typeof tamCheckpointSeedBeginSchema>;
export type TamCheckpointSeedBatchInput = z.infer<typeof tamCheckpointSeedBatchSchema>;
export type TamCheckpointSeedFinalizeInput = z.infer<typeof tamCheckpointSeedFinalizeSchema>;
export type TamActorHeartbeatInput = z.infer<typeof tamActorHeartbeatSchema>;
export type TamEventInput = z.infer<typeof tamEventSchema>;
export type TamMembershipBatchInput = z.infer<typeof tamMembershipBatchSchema>;
export type TamRemovedBatchInput = z.infer<typeof tamRemovedBatchSchema>;
export type TamPdfUpdateInput = z.infer<typeof tamPdfUpdateSchema>;
export type TamGradeClaimInput = z.infer<typeof tamGradeClaimSchema>;
export type TamGradeWorkInput = z.infer<typeof tamGradeWorkSchema>;
export type FinalGradePublishInput = z.infer<typeof finalGradePublishSchema>;

export interface TamRegradeStatus {
  run: Record<string, unknown>;
  counts: {
    records_total: number;
    current: number;
    new: number;
    overlap: number;
    removed: number;
    pdf_verified: number;
    grade_pending: number;
    grade_reading: number;
    grade_hold: number;
    grade_final: number;
    grade_published: number;
    lease_expired: number;
  };
  actors: Record<string, unknown>[];
  events: Record<string, unknown>[];
}
