import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0045_tal_exact_membership.sql"),
  "utf8",
);

describe("atomic exact-ID TAL migration", () => {
  it("uses one security-definer replacement RPC and exact identity", () => {
    expect(sql).toContain("function sync_tal_exact_membership");
    expect(sql).toContain("security definer");
    expect(sql).toContain("c.netsuite_internal_id is distinct from requested.internal_id");
    expect(sql).not.toMatch(/\bdomain\b\s*=/i);
    expect(sql).not.toMatch(/\bname\b\s*=/i);
  });

  it("fails ambiguous active duplicates while preserving retired duplicate history", () => {
    expect(sql).toContain("tam_duplicate");
    expect(sql).toContain("having count(*) <> 1");
    expect(sql).not.toMatch(/create\s+unique\s+index[\s\S]*netsuite_internal_id/i);
  });

  it("applies and verifies the complete claimed set in the transaction", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("set tal_claimed = true");
    expect(sql).toContain("set tal_claimed = false");
    expect(sql).toContain("TAL replacement exact-set verification failed");
    expect(sql).toContain("grant execute on function sync_tal_exact_membership");
  });
});
