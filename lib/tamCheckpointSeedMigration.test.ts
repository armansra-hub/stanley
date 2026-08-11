import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0049_tam_checkpoint_seed.sql"),
  "utf8",
);

describe("0049 TAM checkpoint seed", () => {
  it("persists the exact ordered five-cohort checkpoint", () => {
    for (const field of [
      "membership_ordinal",
      "recovery_cohort",
      "checkpoint_seed_id",
      "checkpoint_artifact_sha256",
      "checkpoint_payload_sha256",
      "checkpoint_source_hashes",
      "publication_origin",
      "historical_published_at",
    ]) expect(sql).toContain(field);
    for (const cohort of [
      "published_complete",
      "legacy_schema_recovery",
      "lost_staging_recovery",
      "active_hold",
      "unrepresented",
    ]) expect(sql).toContain(cohort);
    expect(sql).toContain("tam_regrade_records_current_ordinal_uidx");
    expect(sql).toContain("v_expected_current <> 6949");
    expect(sql).toContain("(p_expected_counts->>'publishedComplete')::int <> 2696");
    expect(sql).toContain("2294caa9c38d2302437a8fda18c54316c3416695d21871fd4b3ea9c6e58c7de9");
    expect(sql).toContain("a9893713cabdcc6f053004a3fb0530aa84e6d9419fa6293496ded73f1ed19881");
    expect(sql).toContain("6e30f7747f5e3201954bb9fc82160484f97d19ad8a5af2590401be1c40a64d1d");
    expect(sql).toContain("e44d06e4d4b0a8146dbeb58eb99c0baf7ba1c93df402cb786429145b85246ca2");
    expect(sql).toContain("5e3072347fd25ed56f2916b2f4485d0183a4ccf96e5b09bcdc02e1182d63e6ce");
  });

  it("uses a fenced begin/batch/finalize seed and is service-role-only", () => {
    for (const fn of [
      "begin_tam_regrade_checkpoint_seed",
      "seed_tam_regrade_checkpoint_batch",
      "finalize_tam_regrade_checkpoint_seed",
    ]) {
      expect(sql).toContain(`function ${fn}`);
    }
    expect(sql).toContain("seed_token");
    expect(sql).toContain("for update");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).not.toContain("create policy");
  });

  it("requires and unconditionally reconciles the exact removed membership", () => {
    expect(sql).toMatch(/\?& array\[\s*'currentTotal', 'removedTotal', 'pdfVerified'/);
    expect(sql).toContain("(select count(*) from jsonb_object_keys(p_expected_counts)) <> 8");
    expect(sql).toContain("(p_expected_counts->>'removedTotal')::int <> 34");
    expect(sql).toContain("v_removed <> (v_seed.expected_counts->>'removedTotal')::int");
    expect(sql).toContain("(v_counts->>'removed')::int <> (v_seed.expected_counts->>'removedTotal')::int");
    expect(sql).toContain("v_removed_hash is distinct from v_seed.cohort_hashes->>'removed'");
    expect(sql).toContain("order by length(r.netsuite_internal_id), r.netsuite_internal_id");
    expect(sql).not.toContain("v_seed.expected_counts ? 'removedTotal'");
    expect(sql).not.toContain("p_expected_counts ? 'removedTotal'");
  });

  it("requires the exhaustive production source binding without omitted or extra keys", () => {
    for (const key of [
      "pdf_reconciliation_manifest_sha256",
      "coordination_membership_sha256",
      "coordination_removed_ids_sha256",
      "current_membership_sha256",
      "current_pdf_inventory_sha256",
      "final_assessments_sha256",
      "publish_queue_sha256",
      "grading_manifest_sha256",
      "live_final_reconciliation_sha256",
      "localEvidenceState",
      "localEvidenceReceipt",
      "evidence_corpus_sha256",
      "evidence_readback_sha256",
      "checkpoint_rows_sha256",
    ]) expect(sql).toContain(`'${key}'`);
    expect(sql).toContain("count(*) from jsonb_object_keys(coalesce(p_source_hashes, '{}'::jsonb))) <> 14");
    expect(sql).toContain("p_source_hashes->>'current_membership_sha256' is distinct from '61708344");
    expect(sql).toContain("p_source_hashes->>'current_pdf_inventory_sha256' is distinct from '25acada4");
    expect(sql).toContain("p_source_hashes->>'final_assessments_sha256' is distinct from '50586b40");
    expect(sql).toContain("p_source_hashes->>'publish_queue_sha256' is distinct from 'd0134db0");
    expect(sql).toContain("p_source_hashes->>'coordination_membership_sha256' is distinct from 'c907b130");
    expect(sql).toContain("p_source_hashes->>'coordination_removed_ids_sha256' is distinct from 'a95259f8");
    expect(sql).toContain("p_source_hashes->>'grading_manifest_sha256' is distinct from 'c0f3e809");
    expect(sql).toContain("p_source_hashes->>'live_final_reconciliation_sha256' is distinct from 'df22e133");
  });

  it("makes the seed control row and seeded membership immutable", () => {
    expect(sql).toContain("tam_regrade_checkpoint_seed_is_immutable");
    expect(sql).toContain("before update or delete on tam_regrade_checkpoint_seeds");
    expect(sql).toContain("completed TAM checkpoint seed control rows are immutable");
    expect(sql).toContain("the only checkpoint seed mutation is building to complete once");
    expect(sql).toContain("checkpoint seed completion is allowed only inside the fenced finalize RPC");
    expect(sql).toContain("capturing to grading is allowed only inside the fenced checkpoint finalize RPC");
    expect(sql).toContain("set_config('stanley.tam_checkpoint_finalize_token'");
    expect(sql).toContain("tam_regrade_freeze_seeded_record");
    expect(sql).toContain("before insert or update or delete on tam_regrade_records");
    expect(sql).toContain("create a new run for a new snapshot");
    expect(sql).toContain("membership upsert/removal is forbidden for a seeded TAM run");
    expect(sql).toContain("completed TAM checkpoint membership, order and source metadata are immutable");
    expect(sql).toContain("set_config('stanley.tam_checkpoint_batch_token'");
    expect(sql).toContain("revoke all on tam_regrade_checkpoint_seeds from public, anon, authenticated, service_role");
    expect(sql).toContain("grant select on tam_regrade_checkpoint_seeds to service_role");
  });

  it("imports historical finals by readback without rewriting companies", () => {
    const batchSql = sql
      .split("create or replace function seed_tam_regrade_checkpoint_batch", 2)[1]
      .split("create or replace function finalize_tam_regrade_checkpoint_seed", 1)[0];
    expect(batchSql).toContain("v_final_score := (v_item->>'finalScore')::numeric");
    expect(batchSql).not.toContain("v_item->>'codexScore'");
    expect(batchSql).toContain("set membership_ordinal = v_ordinal");
    expect(batchSql).not.toMatch(/update\s+companies/i);
    expect(batchSql).toContain("checkpoint company exact normalized readback drifted");
    expect(batchSql).toContain("v_canonical_json::jsonb is distinct from v_provenance");
    expect(batchSql).toContain("published provenance identity/full-read contract mismatch");
    expect(batchSql).toContain("checkpoint PDF binding differs from exact verified evidence");
    expect(batchSql).toContain("pdf_binding_sha256");
    expect(batchSql).toContain("pdf_capture_snapshot_sha256");
    expect(batchSql).toContain("v_record.table_rows_sha256 is distinct from v_table_rows_sha");
    expect(batchSql).toContain("'table_rows_sha256', v_table_rows_sha");
  });

  it("blocks grading and later cohorts until atomic seed finalization", () => {
    expect(sql).toContain("TAM run cannot enter grading before checkpoint seed finalization");
    expect(sql).toContain("checkpoint seed cannot run while any TAM record has a lease");
    expect(sql).toContain("checkpoint seed requires an initializing or capturing TAM run");
    expect(sql).toContain("completed checkpoint seed is not fenced into its TAM run");
    expect(sql).toContain("'alreadyComplete', true");
    expect(sql).toContain("TAM recovery cohort % is blocked by unfinished cohort rank %");
    expect(sql).toContain("set completed_checkpoint_seed_id = v_seed.id");
    expect(sql).toContain("status = 'grading'");
    expect(sql).toContain("checkpoint exact ordered-ID hashes do not match the manifest");
    expect(sql).toContain("checkpoint finalization found PDF evidence binding drift");
    expect(sql).toContain("TAM run identity, slug and creation time are immutable");
    expect(sql).toContain("v_run.source_total is distinct from 7618");
    expect(sql).toContain("v_run.source_snapshot_sha256 is distinct from '1a539c7e");
    expect(sql).toContain("TAM run cannot complete until every exact current checkpoint record is published and unleased");
    expect(sql).toContain("TAM run completion checkpoint hashes drifted");
    expect(sql).toContain("invalid seeded TAM run status transition");
    expect(sql).toContain("c.oldgold_score is distinct from (\n          case");
  });

  it("exposes board/cohort readback without the seed token", () => {
    expect(sql).toContain("'checkpointSeed', v_seed");
    expect(sql).toContain("to_jsonb(s) - 'seed_token'");
    expect(sql).toContain("'cohort_legacy_schema_recovery'");
    expect(sql).toContain("'grade_published'");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
