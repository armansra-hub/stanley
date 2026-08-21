import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0054_tam_terminal_hold_cohort_progress.sql",
  ),
  "utf8",
);

describe("0054 terminal-hold cohort progression", () => {
  it("keeps terminal holds unpublished while excluding them from unfinished cohort ranks", () => {
    expect(sql).toContain("tam_regrade_enforce_checkpoint_claim_order");
    expect(sql).toContain("and r.grade_status not in ('published', 'hold');");
    expect(sql).toContain("TAM recovery cohort % is blocked by unfinished cohort rank %");
    expect(sql).not.toMatch(/and r\.grade_status <> 'published';/);
  });
});
