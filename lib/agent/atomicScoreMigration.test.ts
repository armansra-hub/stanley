import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0050_atomic_agent_score_writes.sql"),
  "utf8",
);

describe("0050 atomic agent score writes", () => {
  it("validates, locks, snapshots, and updates in a single service-role RPC", () => {
    expect(sql).toContain("function apply_agent_score_batch");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("order by 1");
    expect(sql).toContain("for update");
    expect(sql.indexOf("insert into score_snapshots")).toBeLessThan(sql.indexOf("update companies"));
    expect(sql).toContain("repeats a company id");
    expect(sql).toContain("score target not found");
    expect(sql).toContain("current seeded TAM grades must publish through the fenced coordinator");
    expect(sql).toContain("join tam_regrade_checkpoint_seeds");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("enforces and revalidates one canonical row per exact NetSuite ID", () => {
    expect(sql).toContain("unique index if not exists companies_canonical_netsuite_internal_id_idx");
    expect(sql).toContain("not ('tam_duplicate' = any(coalesce(lists, '{}'::text[])))");
    expect(sql).toContain("score batch repeats a NetSuite Internal ID");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('tam-company:' || v_internal_id, 0))");
    expect(sql).toContain("tam_canonical_company_id(v_internal_id) is distinct from v_company_id");
  });

  it("never accepts or writes a stale company name", () => {
    expect(sql).toContain("where item ? 'name'");
    expect(sql).not.toMatch(/set[\s\S]*?\bname\s*=/i);
  });

  it("preserves locked human statuses and resurfaces exported TAM rows only", () => {
    expect(sql).not.toContain("'status', 'record_dead'");
    expect(sql).toContain("'resurface_exported'");
    expect(sql).toContain("companies.status in ('exported_csv','exported_sql')");
    expect(sql).toContain("else companies.status");
    expect(sql).toContain("resurfaced_internal_ids");
  });

  it("derives Old Gold from the effective post-write evidence", () => {
    expect(sql).toContain("v_old_gold_reasons := case");
    expect(sql).toContain("else coalesce(v_company.oldgold_reasons, '[]'::jsonb)");
    expect(sql).toContain("v_opportunity_text := coalesce(v_record_digest, '')");
    expect(sql).toContain("jsonb_array_elements_text(v_old_gold_reasons)");
    expect(sql).not.toContain("v_opportunity_text := coalesce(v_company.record_digest");
    expect(sql).toContain("old_gold_score_input')::numeric not between 0 and 100");
  });
});
