import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0044_signal_quarantine_rpc.sql"),
  "utf8",
);

describe("signal quarantine RPC", () => {
  it("is service-role-only and can repair inactive or malformed markers", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("jsonb_build_object('marker', existing_marker, 'changed', false)");
    expect(sql).toContain("grant execute on function quarantine_trigger");
    expect(sql).toContain("to service_role");
  });

  it("reconciles cached flags under a company lock without hiding new events", () => {
    expect(sql).toContain("function reconcile_company_signal_flags");
    expect(sql).toContain("where c.id = p_company_id\n  for update");
    expect(sql).toContain("unquarantined_triggers");
    expect(sql).toContain("set tal_alert = false");
    expect(sql).not.toContain("has_new_signal = false");
    expect(sql).toContain("grant execute on function reconcile_company_signal_flags(uuid)");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
