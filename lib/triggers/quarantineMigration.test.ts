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
    expect(sql).toContain("set search_path = public");
    expect(sql).toContain("is distinct from 'true'::jsonb");
    expect(sql).toContain("grant execute on function quarantine_trigger");
    expect(sql).toContain("to service_role");
  });
});
