import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serviceClient } from "@/lib/supabase/server";
import {
  bootstrapTamRunSchema,
  DEFAULT_TAM_LEASE_SECONDS,
  finalGradePublishSchema,
  tamActorHeartbeatSchema,
  tamEventSchema,
  tamGradeClaimSchema,
  tamGradeWorkSchema,
  tamMembershipBatchSchema,
  tamPdfUpdateSchema,
  tamRemovedBatchSchema,
  type BootstrapTamRunInput,
  type FinalGradePublishInput,
  type TamActorHeartbeatInput,
  type TamEventInput,
  type TamGradeClaimInput,
  type TamGradeWorkInput,
  type TamMembershipBatchInput,
  type TamPdfUpdateInput,
  type TamRegradeStatus,
  type TamRemovedBatchInput,
} from "@/lib/tamRegrade";

// Deliberately omits claim_token. Only the atomic claim RPC may reveal a token;
// list/status reads cannot be used by another actor to take over a live lease.
const SAFE_RECORD_SELECT = [
  "run_id",
  "netsuite_internal_id",
  "company_id",
  "company_name",
  "is_current",
  "membership_status",
  "table_row",
  "source_page",
  "source_row",
  "table_rows",
  "source_coordinates",
  "saved_search_row_count",
  "table_rows_sha256",
  "pdf_status",
  "pdf_object_path",
  "pdf_sha256",
  "pdf_page_count",
  "pdf_verified_at",
  "pdf_error",
  "grade_status",
  "hold_reason",
  "last_actor",
  "claim_actor",
  "claim_generation",
  "claim_started_at",
  "claim_heartbeat_at",
  "claim_expires_at",
  "final_score",
  "codex_score",
  "tam_score",
  "score_adjust_note",
  "assessment_score_note",
  "record_digest",
  "record_dead",
  "record_dead_reason",
  "assessment_old_gold_score",
  "old_gold_class",
  "old_gold_reasons",
  "intro_call_exists",
  "opportunity_exists",
  "revisit_on",
  "grade_provenance",
  "grade_provenance_object_path",
  "grade_provenance_canonical_json",
  "grade_provenance_sha256",
  "validation_status",
  "validated_by",
  "validated_at",
  "graded_at",
  "published_at",
  "created_at",
  "updated_at",
].join(",");

async function runIdFor(runSlug: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("tam_regrade_runs")
    .select("id")
    .eq("slug", runSlug)
    .maybeSingle();
  if (error) throw new Error(`TAM run lookup failed: ${error.message}`);
  if (!data) throw new Error(`TAM regrade run not found: ${runSlug}`);
  return String(data.id);
}

export async function bootstrapTamRegradeRun(raw: BootstrapTamRunInput) {
  const input = bootstrapTamRunSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("bootstrap_tam_regrade_run", {
    p_run_slug: input.runSlug,
    p_search_id: input.searchId,
    p_mission: input.mission,
    p_status: input.status,
    p_source_total: input.sourceTotal ?? null,
    p_source_snapshot_sha256: input.sourceSnapshotSha256 ?? null,
  });
  if (error) throw new Error(`TAM run bootstrap failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function getTamRegradeStatus(
  runSlug: string,
  eventLimit = 50,
): Promise<TamRegradeStatus> {
  const { data, error } = await serviceClient().rpc("get_tam_regrade_status", {
    p_run_slug: runSlug,
    p_event_limit: Math.min(Math.max(Math.trunc(eventLimit), 0), 200),
  });
  if (error) throw new Error(`TAM status read failed: ${error.message}`);
  return data as TamRegradeStatus;
}

export interface ListTamRegradeRecordsInput {
  runSlug: string;
  netsuiteInternalId?: string;
  isCurrent?: boolean;
  membershipStatus?: "new" | "overlap" | "removed";
  pdfStatus?: "missing" | "queued" | "downloading" | "verified" | "error" | "stale";
  gradeStatus?: "pending" | "reading" | "hold" | "final" | "published";
  lastActor?: string;
  limit?: number;
  offset?: number;
}

export async function listTamRegradeRecords(input: ListTamRegradeRecordsInput) {
  const runId = await runIdFor(input.runSlug);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  let query = serviceClient()
    .from("tam_regrade_records")
    .select(SAFE_RECORD_SELECT, { count: "exact" })
    .eq("run_id", runId);
  if (input.netsuiteInternalId) query = query.eq("netsuite_internal_id", input.netsuiteInternalId);
  if (input.isCurrent !== undefined) query = query.eq("is_current", input.isCurrent);
  if (input.membershipStatus) query = query.eq("membership_status", input.membershipStatus);
  if (input.pdfStatus) query = query.eq("pdf_status", input.pdfStatus);
  if (input.gradeStatus) query = query.eq("grade_status", input.gradeStatus);
  if (input.lastActor) query = query.eq("last_actor", input.lastActor);

  const { data, error, count } = await query
    .order("source_page", { ascending: true, nullsFirst: false })
    .order("source_row", { ascending: true, nullsFirst: false })
    .order("netsuite_internal_id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`TAM record list failed: ${error.message}`);
  return {
    records: (data ?? []) as unknown as Record<string, unknown>[],
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function heartbeatTamActor(raw: TamActorHeartbeatInput) {
  const input = tamActorHeartbeatSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("heartbeat_tam_regrade_actor", {
    p_run_slug: input.runSlug,
    p_actor_key: input.actorKey,
    p_status: input.status,
    p_current_work: input.currentWork ?? null,
    p_metadata: input.metadata,
    p_netsuite_internal_id: input.netsuiteInternalId ?? null,
    p_claim_token: input.claimToken ?? null,
    p_lease_seconds: input.leaseSeconds ?? DEFAULT_TAM_LEASE_SECONDS,
  });
  if (error) throw new Error(`TAM actor/claim heartbeat failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function appendTamEvent(raw: TamEventInput): Promise<void> {
  const input = tamEventSchema.parse(raw);
  const runId = await runIdFor(input.runSlug);
  const { error } = await serviceClient().from("tam_regrade_events").insert({
    run_id: runId,
    actor_key: input.actorKey,
    kind: input.kind,
    netsuite_internal_id: input.netsuiteInternalId ?? null,
    summary: input.summary,
    metadata: input.metadata,
  });
  if (error) throw new Error(`TAM event insert failed: ${error.message}`);
}

export async function upsertTamMembership(raw: TamMembershipBatchInput) {
  const input = tamMembershipBatchSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("upsert_tam_regrade_membership", {
    p_run_slug: input.runSlug,
    p_actor_key: input.actorKey,
    p_rows: input.rows,
    p_source_total: input.sourceTotal ?? null,
    p_source_snapshot_sha256: input.sourceSnapshotSha256 ?? null,
  });
  if (error) throw new Error(`TAM membership upsert failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function markTamMembershipRemoved(raw: TamRemovedBatchInput) {
  const input = tamRemovedBatchSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("remove_tam_regrade_membership", {
    p_run_slug: input.runSlug,
    p_actor_key: input.actorKey,
    p_netsuite_internal_ids: input.netsuiteInternalIds,
    p_reason: input.reason,
  });
  if (error) throw new Error(`TAM membership removal failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function updateTamPdfStatus(raw: TamPdfUpdateInput) {
  const input = tamPdfUpdateSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("update_tam_regrade_pdf", {
    p_run_slug: input.runSlug,
    p_actor_key: input.actorKey,
    p_netsuite_internal_id: input.netsuiteInternalId,
    p_status: input.status,
    p_object_path: input.objectPath ?? null,
    p_sha256: input.sha256 ?? null,
    p_page_count: input.pageCount ?? null,
    p_verified_at: input.verifiedAt ?? null,
    p_error: input.error ?? null,
  });
  if (error) throw new Error(`TAM PDF status update failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function claimTamGradeWork(raw: TamGradeClaimInput) {
  const input = tamGradeClaimSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("claim_tam_regrade_record", {
    p_run_slug: input.runSlug,
    p_netsuite_internal_id: input.netsuiteInternalId,
    p_actor_key: input.actorKey,
    p_include_hold: input.includeHold,
    p_claim_token: input.claimToken ?? null,
    p_lease_seconds: input.leaseSeconds,
  });
  if (error) throw new Error(`TAM grade claim failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function setTamGradeWorkStatus(raw: TamGradeWorkInput) {
  const input = tamGradeWorkSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("set_tam_regrade_work_status", {
    p_run_slug: input.runSlug,
    p_netsuite_internal_id: input.netsuiteInternalId,
    p_actor_key: input.actorKey,
    p_claim_token: input.claimToken,
    p_status: input.status,
    p_hold_reason: input.holdReason ?? null,
  });
  if (error) throw new Error(`TAM grade work status failed: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function publishValidatedTamGrade(raw: FinalGradePublishInput) {
  const input = finalGradePublishSchema.parse(raw);
  let canonicalData: unknown;
  try {
    canonicalData = JSON.parse(input.provenance.canonicalJson);
  } catch {
    throw new Error("Grade provenance canonical JSON is invalid");
  }
  if (!isDeepStrictEqual(canonicalData, input.provenance.data)) {
    throw new Error("Grade provenance canonical JSON differs from structured data");
  }
  const computedProvenanceSha256 = createHash("sha256")
    .update(input.provenance.canonicalJson, "utf8")
    .digest("hex");
  if (computedProvenanceSha256 !== input.provenance.sha256) {
    throw new Error("Grade provenance SHA-256 differs from canonical JSON bytes");
  }
  const assessment = input.provenance.data.assessment;
  const recordDead = input.finalScore <= 10;
  const { data, error } = await serviceClient().rpc("publish_tam_regrade_final", {
    p_run_slug: input.runSlug,
    p_netsuite_internal_id: input.netsuiteInternalId,
    p_actor_key: input.actorKey,
    p_claim_token: input.claimToken,
    p_final_score: input.finalScore,
    p_record_digest: input.recordDigest,
    p_provenance_sha256: input.provenance.sha256,
    p_validated_by: input.validation.validatedBy,
    p_validated_at: input.validation.validatedAt,
    p_provenance: input.provenance.data,
    p_assessment_old_gold_score: assessment.old_gold_score,
    p_old_gold_class: assessment.old_gold_class,
    p_old_gold_reasons: assessment.old_gold_reasons,
    p_intro_call_exists: assessment.intro_call_exists,
    p_opportunity_exists: assessment.opportunity_exists,
    p_revisit_on: assessment.revisit_on,
    p_record_dead: recordDead,
    p_record_dead_reason: recordDead ? assessment.dq_reason : null,
    p_assessment_score_note: input.scoreAdjustNote ?? assessment.score_adjust_note,
    p_provenance_canonical_json: input.provenance.canonicalJson,
    p_provenance_object_path: input.provenance.objectPath,
  });
  if (error) throw new Error(`Validated TAM grade publish failed: ${error.message}`);
  return data as Record<string, unknown>;
}
