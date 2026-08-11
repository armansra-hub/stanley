import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]> }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      state.calls.push(["rpc", name, args]);
      return Promise.resolve({ data: [{ id: "reserved" }], error: null });
    },
    from: (table: string) => {
      state.calls.push(["from", table]);
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "contains", "neq", "not", "eq", "or", "order"]) {
        chain[method] = (...args: unknown[]) => {
          state.calls.push([method, ...args]);
          return chain;
        };
      }
      chain.range = (...args: unknown[]) => {
        state.calls.push(["range", ...args]);
        return Promise.resolve({ data: [{ id: "selected" }], error: null });
      };
      return chain;
    },
  }),
}));

import {
  pickAtsForRotation,
  pickCarriersForRotation,
  pickForRotation,
  pickSignalsForRotation,
  pickSitesForRotation,
  pickSosCompaniesForRotation,
  reservePriorityRecompute,
  utcDailyRotationEpoch,
} from "./triggers";

describe("durable source rotation pickers", () => {
  beforeEach(() => {
    state.calls.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T01:02:03.000Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("atomically reserves default waves instead of paging a mutable ordering", async () => {
    await pickForRotation(10);
    expect(state.calls).toContainEqual(["rpc", "reserve_company_rotation", {
      p_source: "trigger", p_limit: 10, p_scope: null, p_epoch: "2026-08-10T00:00:00.000Z",
    }]);
    state.calls.length = 0;
    await pickSitesForRotation(30, 0, "tail");
    expect(state.calls).toContainEqual(["rpc", "reserve_company_rotation", {
      p_source: "site", p_limit: 30, p_scope: "tail", p_epoch: "2026-08-10T00:00:00.000Z",
    }]);
  });

  it("shares one UTC-day cutoff across waves and safe same-day retries", async () => {
    expect(utcDailyRotationEpoch()).toBe("2026-08-10T00:00:00.000Z");
    await pickForRotation(10);
    vi.setSystemTime(new Date("2026-08-10T23:59:59.999Z"));
    await pickCarriersForRotation(10);
    const epochs = state.calls
      .filter((call) => call[0] === "rpc")
      .map((call) => (call[2] as { p_epoch: string }).p_epoch);
    expect(epochs).toEqual([
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ]);
  });

  it("keeps explicit positive-offset recovery queries oldest-first", async () => {
    await pickForRotation(10, 10);
    expect(state.calls).toContainEqual(["order", "last_checked_at", { ascending: true, nullsFirst: true }]);
    state.calls.length = 0;
    await pickAtsForRotation(10, 10);
    expect(state.calls).toContainEqual(["order", "ats_checked_at", { ascending: true, nullsFirst: true }]);
    state.calls.length = 0;
    await pickSignalsForRotation(10, 10);
    expect(state.calls).toContainEqual(["order", "signals_checked_at", { ascending: true, nullsFirst: true }]);
  });

  it("executes a real tail query instead of returning an empty slot", async () => {
    const rows = await pickSitesForRotation(30, 30, "tail");
    expect(rows).toHaveLength(1);
    expect(state.calls).toContainEqual(["eq", "is_base", true]);
    expect(state.calls).toContainEqual(["not", "claimable", "is", true]);
    expect(state.calls).toContainEqual(["order", "site_checked_at", { ascending: true, nullsFirst: true }]);
  });

  it("uses independent durable cursors for FMCSA and state-registry sweeps", async () => {
    await pickCarriersForRotation(10, 10);
    expect(state.calls).toContainEqual(["order", "fmcsa_checked_at", { ascending: true, nullsFirst: true }]);
    state.calls.length = 0;
    await pickSosCompaniesForRotation("CO", 10, 10);
    expect(state.calls).toContainEqual(["order", "sos_checked_at", { ascending: true, nullsFirst: true }]);
  });

  it("migration reserves parallel waves with row locks", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0042_source_rotation_cursors.sql"), "utf8");
    expect(sql).toContain("function reserve_company_rotation");
    expect(sql.match(/for update of c skip locked/g)?.length).toBe(6);
    expect(sql.match(/checked_at is null or c\.[a-z_]+checked_at < p_epoch/g)?.length).toBe(6);
    expect(sql).toContain("reserve_company_rotation(text, integer, timestamptz, text)");
    // Remove the pre-deploy three-argument draft so it cannot remain as a public overload.
    expect(sql).toContain("drop function if exists reserve_company_rotation(text, integer, text)");
    expect(sql).toContain("grant execute on function reserve_company_rotation");
  });

  it("uses the durable priority RPC with an explicit daily epoch and zombie quota", async () => {
    await reservePriorityRecompute(10, 2, "2026-08-10T00:00:00.000Z");
    expect(state.calls).toContainEqual(["rpc", "reserve_priority_recompute", {
      p_epoch: "2026-08-10T00:00:00.000Z",
      p_limit: 10,
      p_zombie_slots: 2,
    }]);

    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/0048_priority_recompute_rotation.sql"), "utf8");
    expect(sql).toContain("priority_recompute_reserved_at");
    expect(sql).toContain("p_zombie_slots");
    expect(sql).toContain("for update of c skip locked");
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/order by\s+c\.priority\b/i);
    expect(sql).toContain("grant execute on function reserve_priority_recompute");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
