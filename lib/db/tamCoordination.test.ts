import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  claimTamGradeWork,
  heartbeatTamActor,
  publishValidatedTamGrade,
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
});
