import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0043_tam_regrade_coordination.sql"),
  "utf8",
);
const publishSql = sql
  .split("create or replace function publish_tam_regrade_final", 2)[1]
  .split("create or replace function get_tam_regrade_status", 1)[0];
const membershipSql = sql
  .split("create or replace function upsert_tam_regrade_membership", 2)[1]
  .split("create or replace function remove_tam_regrade_membership", 1)[0];

describe("0043 TAM coordination migration", () => {
  it("does not impose global NetSuite-ID uniqueness on companies", () => {
    expect(sql).not.toMatch(/create\s+unique\s+index[\s\S]*companies[\s\S]*netsuite_internal_id/i);
    expect(sql).toContain("tam_canonical_company_id");
    expect(sql).toContain("'tam_duplicate' = any");
    expect(sql).toContain("expected 1");
  });

  it("uses row locks, expiring leases and fencing tokens for every transition", () => {
    for (const name of [
      "claim_tam_regrade_record",
      "heartbeat_tam_regrade_actor",
      "set_tam_regrade_work_status",
      "publish_tam_regrade_final",
    ]) expect(sql).toContain(`function ${name}`);
    expect(sql).toContain("for update");
    expect(sql).toContain("claim_token");
    expect(sql).toContain("claim_generation");
    expect(sql).toContain("claim_expires_at <= v_now");
    expect(sql).toContain("another exact TAM record already has the run active lease");
    expect(sql).toContain("p_lease_seconds is null");
    expect(sql).toContain("not grading");
    expect(sql).toContain("active claim token is required");
    expect(sql).toContain("stale or unowned");
  });

  it("stores the raw grade and has no public-signal score input", () => {
    expect(sql).toContain("set codex_score = p_final_score");
    expect(sql).toContain("v_tam_score := case when v_hard_zero_reason is null then p_final_score else 0 end");
    expect(sql).not.toMatch(/p_(?:signal|trigger|growth|funding|headcount)/i);
    const companyUpdate = publishSql
      .split("update companies", 2)[1]
      .split("where id = v_company.id", 1)[0];
    expect(companyUpdate).not.toMatch(/\bstatus\s*=/i);
  });

  it("preserves all current assessment evidence and exact provenance", () => {
    for (const field of [
      "assessment_old_gold_score",
      "old_gold_class",
      "old_gold_reasons",
      "intro_call_exists",
      "opportunity_exists",
      "grade_provenance_object_path",
      "grade_provenance_canonical_json",
      "grade_provenance_sha256",
    ]) expect(sql).toContain(field);
    expect(sql).toContain("digest(convert_to(p_provenance_canonical_json, 'UTF8'), 'sha256')");
    expect(sql).toContain("p_provenance_canonical_json::jsonb is distinct from p_provenance");
    expect(sql).toContain("published provenance does not match the verified exact-ID PDF");
    expect(sql).toContain("already_published', true");
    expect(sql).toContain("already has a different published final");
    expect(sql).toContain("exact company readback drifted");
    expect(publishSql).toContain("v_company.oldgold_score is distinct from v_live_old_gold_score");
    expect(publishSql).toContain("v_company.record_dead_reason is distinct from (\n           case");
    expect(publishSql).toContain("v_company.record_digest is distinct from p_record_digest");
  });

  it("invalidates stale membership evidence and preserves a complete history event", () => {
    expect(membershipSql).toContain("from tam_regrade_records");
    expect(membershipSql).toContain("for update");
    expect(membershipSql).toContain("v_existing.table_rows_sha256 is distinct from");
    expect(membershipSql).toContain("v_revived := v_had_existing and not v_existing.is_current");
    expect(membershipSql).toContain("pdf_status = 'stale'");
    expect(membershipSql).toContain("grade_status = 'pending'");
    for (const field of [
      "claim_actor = null",
      "claim_token = null",
      "claim_started_at = null",
      "claim_heartbeat_at = null",
      "claim_expires_at = null",
      "final_score = null",
      "grade_provenance_sha256 = null",
      "validation_status = 'pending'",
      "published_at = null",
    ]) expect(membershipSql).toContain(field);
    expect(membershipSql).toContain("'membership.evidence_changed'");
    for (const historicalField of [
      "'table_rows_sha256', v_existing.table_rows_sha256",
      "'pdf_object_path', v_existing.pdf_object_path",
      "'pdf_sha256', v_existing.pdf_sha256",
      "'pdf_page_count', v_existing.pdf_page_count",
      "'pdf_verified_at', v_existing.pdf_verified_at",
      "'pdf_error', v_existing.pdf_error",
      "'grade_status', v_existing.grade_status",
      "'hold_reason', v_existing.hold_reason",
      "'claim_actor', v_existing.claim_actor",
      "'claim_started_at', v_existing.claim_started_at",
      "'claim_heartbeat_at', v_existing.claim_heartbeat_at",
      "'claim_expires_at', v_existing.claim_expires_at",
      "'final_score', v_existing.final_score",
      "'codex_score', v_existing.codex_score",
      "'tam_score', v_existing.tam_score",
      "'score_adjust_note', v_existing.score_adjust_note",
      "'assessment_score_note', v_existing.assessment_score_note",
      "'record_digest', v_existing.record_digest",
      "'record_dead', v_existing.record_dead",
      "'record_dead_reason', v_existing.record_dead_reason",
      "'assessment_old_gold_score', v_existing.assessment_old_gold_score",
      "'old_gold_class', v_existing.old_gold_class",
      "'old_gold_reasons', v_existing.old_gold_reasons",
      "'intro_call_exists', v_existing.intro_call_exists",
      "'opportunity_exists', v_existing.opportunity_exists",
      "'revisit_on', v_existing.revisit_on",
      "'grade_provenance', v_existing.grade_provenance",
      "'grade_provenance_object_path', v_existing.grade_provenance_object_path",
      "'grade_provenance_canonical_json', v_existing.grade_provenance_canonical_json",
      "'grade_provenance_sha256', v_existing.grade_provenance_sha256",
      "'validation_status', v_existing.validation_status",
      "'validated_by', v_existing.validated_by",
      "'validated_at', v_existing.validated_at",
      "'graded_at', v_existing.graded_at",
      "'published_at', v_existing.published_at",
    ]) expect(membershipSql).toContain(historicalField);
    expect(membershipSql).not.toContain("'claim_token', v_existing.claim_token");
  });

  it("stores only verified local PDF locators and creates no remote bucket", () => {
    expect(sql).not.toContain("insert into storage.buckets");
    expect(sql).not.toContain("tam-lead-records");
    expect(sql).toContain("canonical local evidence corpus");
  });

  it("captures the complete company before-image before canonical publication", () => {
    for (const field of [
      "'codex_score', v_company.codex_score",
      "'tam_score', v_company.tam_score",
      "'oldgold_score', v_company.oldgold_score",
      "'oldgold_class', v_company.oldgold_class",
      "'oldgold_reasons', v_company.oldgold_reasons",
      "'revisit_on', v_company.revisit_on",
      "'record_dead', v_company.record_dead",
      "'record_dead_reason', v_company.record_dead_reason",
      "'record_digest', v_company.record_digest",
      "'score_adjust_note', v_company.score_adjust_note",
      "'tam_provisional', v_company.tam_provisional",
      "'last_updated_at', v_company.last_updated_at",
    ]) expect(publishSql).toContain(field);
    expect(publishSql).toContain("'previous', v_previous");
  });

  it("enforces exact final-score dead-band, class, and reason parity inside the RPC", () => {
    expect(publishSql).toContain("p_record_dead is distinct from (p_final_score <= 10)");
    expect(publishSql).toContain("p_assessment_old_gold_score <> 0 or p_old_gold_class <> 'dead'");
    expect(publishSql).toContain("not p_record_dead and p_old_gold_class = 'dead'");
    expect(publishSql).toContain("record-dead final needs a specific reason");
  });

  it("normalizes the historical empty no-revisit marker inside provenance parity", () => {
    expect(publishSql).toContain("nullif(p_provenance->'assessment'->>'revisit_on', '')::date is distinct from p_revisit_on");
    expect(publishSql).not.toContain("(p_provenance->'assessment'->>'revisit_on')::date is distinct from p_revisit_on");
  });

  it("keeps events append-only and coordination service-role-only", () => {
    expect(sql).toContain("tam_regrade_events is append-only");
    expect(sql).toContain("alter table tam_regrade_events enable row level security");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("grant select, insert on tam_regrade_events to service_role");
    expect(sql).not.toContain("create policy");
  });
});
