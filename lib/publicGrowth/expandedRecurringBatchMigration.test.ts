import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("0053 expanded recurring public-growth batch", () => {
  it("allows exactly 125 rows plus the keyset lookahead and keeps service-role-only access", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0053_expand_public_growth_recurring_batch.sql"), "utf8").toLowerCase();
    expect(sql).toContain("p_limit > 126");
    expect(sql).toContain("limit p_limit");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("notify pgrst");
  });
});
