import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0051_agent_bridge_rls.sql"),
  "utf8",
);
const coordinationSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0043_tam_regrade_coordination.sql"),
  "utf8",
);

describe("0051 private agent bridge", () => {
  const tables = ["agent_messages", "agent_tasks", "lead_documents", "score_snapshots", "upload_tickets"];

  it("enables RLS and removes direct browser-role access from every private table", () => {
    for (const table of tables) {
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`revoke all on table ${table} from public, anon, authenticated`);
      expect(sql).toContain(`grant all on table ${table} to service_role`);
    }
    expect(sql).not.toMatch(/create policy/i);
  });

  it("protects the score-history sequence and refreshes the REST schema", () => {
    expect(sql).toContain("revoke all on sequence score_snapshots_id_seq from public, anon, authenticated");
    expect(sql).toContain("grant usage, select on sequence score_snapshots_id_seq to service_role");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("atomically reserves a scoped upload-ticket use", () => {
    expect(sql).toContain("function reserve_upload_ticket");
    expect(sql).toContain("set uses = t.uses + 1");
    expect(sql).toContain("and t.uses < t.max_uses");
    expect(sql).toContain("returning t.* into v_ticket");
    expect(sql).toContain("revoke all on function reserve_upload_ticket(uuid, text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function reserve_upload_ticket(uuid, text) to service_role");
  });

  it("makes coordination state directly read-only while preserving append-only events", () => {
    for (const table of ["tam_regrade_runs", "tam_regrade_actors", "tam_regrade_records", "tam_regrade_events"]) {
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`revoke all on table ${table} from public, anon, authenticated, service_role`);
    }
    for (const table of ["tam_regrade_runs", "tam_regrade_actors", "tam_regrade_records"]) {
      expect(sql).toContain(`grant select on table ${table} to service_role`);
      expect(sql).not.toContain(`grant select, insert on table ${table} to service_role`);
    }
    expect(sql).toContain("grant select, insert on table tam_regrade_events to service_role");
    expect(sql).not.toMatch(/grant\s+(?:all|insert|update|delete|truncate|references|trigger)[^;]*tam_regrade_(?:runs|actors|records)\s+to\s+service_role/i);
    expect(sql).not.toMatch(/grant\s+(?:all|update|delete|truncate|references|trigger)[^;]*tam_regrade_events\s+to\s+service_role/i);
  });

  it("keeps coordination mutations behind owner-executed SECURITY DEFINER RPCs", () => {
    for (const fn of [
      "bootstrap_tam_regrade_run",
      "upsert_tam_regrade_membership",
      "remove_tam_regrade_membership",
      "update_tam_regrade_pdf",
      "claim_tam_regrade_record",
      "heartbeat_tam_regrade_actor",
      "set_tam_regrade_work_status",
      "publish_tam_regrade_final",
    ]) {
      const definition = new RegExp(`create or replace function\\s+${fn}\\b[\\s\\S]*?security definer`, "i");
      expect(coordinationSql).toMatch(definition);
    }
  });
});
