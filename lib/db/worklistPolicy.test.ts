import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]> }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      state.calls.push(["from", table]);
      const chain: Record<string, (...args: unknown[]) => unknown> & { then?: unknown } = {};
      for (const method of ["select", "eq", "contains", "not", "overlaps", "or", "gte", "lte", "order", "is"]) {
        chain[method] = (...args: unknown[]) => {
          state.calls.push([method, ...args]);
          return chain;
        };
      }
      chain.range = (...args: unknown[]) => {
        state.calls.push(["range", ...args]);
        return Promise.resolve({ data: [], count: 0, error: null });
      };
      chain.then = (resolve: unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve as (value: unknown) => unknown);
      return chain;
    },
  }),
}));

import { listBaseCompanies } from "./companies";
import { listOldGold } from "./triggers";

describe("TAM Base and Old Gold shared worklist policy", () => {
  beforeEach(() => { state.calls.length = 0; });

  it("keeps claimed TAL accounts out of TAM Base and applies the Why-it's-here class", async () => {
    await listBaseCompanies({ whyClass: "timing_arrived" });
    expect(state.calls).toContainEqual(["eq", "tal_claimed", false]);
    expect(state.calls).toContainEqual(["eq", "oldgold_class", "timing_arrived"]);
    expect(state.calls).toContainEqual(["not", "status", "in", "(reviewed,dismissed,exported_csv,exported_sql,removed_from_tam)"]);
  });

  it("keeps claimed TAL accounts out of Old Gold and shares reviewed/dismissed hiding", async () => {
    await listOldGold({ whyClass: "stalled_warm" });
    expect(state.calls).toContainEqual(["eq", "tal_claimed", false]);
    expect(state.calls).toContainEqual(["eq", "oldgold_class", "stalled_warm"]);
    expect(state.calls).toContainEqual(["not", "status", "in", "(reviewed,dismissed,removed_from_tam)"]);
  });

  it("shows hidden decisions only when explicitly requested, without restoring TAL rows", async () => {
    await listOldGold({ includeHidden: true });
    expect(state.calls).toContainEqual(["eq", "tal_claimed", false]);
    expect(state.calls).not.toContainEqual(["not", "status", "in", "(reviewed,dismissed,removed_from_tam)"]);
  });
});
