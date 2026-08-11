import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0047_public_growth_sweep_leases.sql"),
  "utf8",
).toLowerCase();
const completeSql = sql
  .split("create or replace function complete_public_growth_sweep_lease", 2)[1]
  .split("create or replace function fail_public_growth_sweep_lease", 1)[0];
const failSql = sql
  .split("create or replace function fail_public_growth_sweep_lease", 2)[1]
  .split("create or replace function list_public_growth_recurring_tam_batch", 1)[0];

describe("0047 public-growth sweep leases", () => {
  it("serializes acquisition with an expiring opaque token", () => {
    expect(sql).toContain("for update");
    expect(sql).toContain("lease_token");
    expect(sql).toContain("lease_until > v_now");
    expect(sql).toContain("gen_random_uuid()");
  });

  it("fences both terminal transitions with the exact token", () => {
    for (const section of [completeSql, failSql]) {
      expect(section).toContain("and s.lease_token = p_lease_token");
      expect(section).toContain("get diagnostics v_updated = row_count");
      expect(section).toContain("return v_updated = 1");
    }
    expect(completeSql).toContain("set cursor = p_cursor");
    expect(failSql).not.toContain("set cursor =");
  });

  it("keeps every RPC service-role-only with a fixed search path", () => {
    expect(sql.match(/security definer/g)).toHaveLength(5);
    expect(sql.match(/set search_path = public, pg_temp/g)).toHaveLength(5);
    for (const role of ["public", "anon", "authenticated"]) expect(sql).toContain(role);
    for (const name of [
      "acquire_public_growth_sweep_lease",
      "complete_public_growth_sweep_lease",
      "fail_public_growth_sweep_lease",
      "list_public_growth_recurring_tam_batch_v2",
    ]) expect(sql).toContain(`grant execute on function ${name}`);
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("defines exact recurring sets from verified public identifiers", () => {
    expect(sql).toContain("m.match_status = 'verified'");
    expect(sql).toContain("e.usaspending_recipient_id is not null");
    expect(sql).toContain("from federal_awards a");
    expect(sql).toContain("e.uei is not null");
    expect(sql).toContain("p_limit > 11");
    expect(sql).toContain("p_after_company_id is null or c.id > p_after_company_id");
    expect(sql).toContain("order by c.id");
    expect(sql).not.toContain("grant execute on function list_public_growth_recurring_tam_batch(text, integer, integer)");
  });
});
