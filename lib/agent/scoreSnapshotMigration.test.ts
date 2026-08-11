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

describe("complete score before-images", () => {
  it("adds a durable JSON before-image and refreshes the API schema", () => {
    expect(migration).toContain("prior_values jsonb not null");
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });

  it("captures every mutable field and blocks writes on snapshot failure", () => {
    for (const field of [
      "tam_score", "codex_score", "oldgold_score", "score_adjust_note",
      "tam_provisional", "status", "record_dead", "record_dead_reason",
      "record_digest", "oldgold_class", "oldgold_reasons", "revisit_on",
    ]) expect(route).toContain(`${field}: company.${field}`);
    expect(route).toContain("score snapshot failed before any company write");
    expect(route.indexOf('from("score_snapshots").insert')).toBeLessThan(
      route.indexOf('from("companies").upsert'),
    );
  });
});
