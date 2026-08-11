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
    expect(publishSql).toContain("v_company.record_digest is distinct from p_record_digest");
  });

  it("keeps events append-only and coordination service-role-only", () => {
    expect(sql).toContain("tam_regrade_events is append-only");
    expect(sql).toContain("alter table tam_regrade_events enable row level security");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("grant select, insert on tam_regrade_events to service_role");
    expect(sql).not.toContain("create policy");
  });
});
