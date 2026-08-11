import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0046_complete_score_snapshots.sql"),
  "utf8",
);
const route = readFileSync(
  resolve(process.cwd(), "app/api/agent/scores/route.ts"),
  "utf8",
);
const atomicMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0050_atomic_agent_score_writes.sql"),
  "utf8",
);

describe("complete score before-images", () => {
  it("adds a durable JSON before-image and refreshes the API schema", () => {
    expect(migration).toContain("prior_values jsonb not null");
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });

  it("captures every mutable field inside one row-locked transaction", () => {
    for (const field of [
      "tam_score", "codex_score", "oldgold_score", "score_adjust_note",
      "tam_provisional", "status", "record_dead", "record_dead_reason",
      "record_digest", "oldgold_class", "oldgold_reasons", "revisit_on",
    ]) expect(atomicMigration).toContain(`'${field}', v_company.${field}`);
    expect(atomicMigration).toContain("from companies where id = v_company_id for update");
    expect(atomicMigration).toContain("insert into score_snapshots");
    expect(atomicMigration).toContain("update companies");
    expect(route).toContain('db.rpc("apply_agent_score_batch"');
    expect(route).not.toContain('from("companies").upsert');
    expect(route).toContain("atomic score batch rolled back");
  });

  it("reports per-row preflight rejections without promising a write", () => {
    expect(route).toContain('from("tam_regrade_checkpoint_seeds")');
    expect(route).toContain("coordinatorOnlyCount");
    expect(route).toContain("preflightEligible: writes.length");
    expect(route).not.toContain("wouldWrite:");
    expect(route).toContain("deadReasonFailures.push");
    expect(route).toContain("continue;");
  });
});
