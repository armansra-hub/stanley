import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0055_trigger_review_boundary.sql"),
  "utf8",
).toLowerCase();

describe("0055 trigger review boundary migration", () => {
  it("adds and backfills the durable review boundary from canonical receipts", () => {
    expect(sql).toContain("add column if not exists trigger_reviewed_through timestamptz");
    expect(sql).toContain("lead.status_changed");
    expect(sql).toContain("in ('reviewed', 'dismissed')");
    expect(sql).toContain("max(events.ts)");
    expect(sql).toContain("set trigger_reviewed_through = last_updated_at");
  });

  it("reloads the PostgREST schema after the column is added", () => {
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
