import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { serviceClient } from "@/lib/supabase/server";
import { loadCustomerCriteriaProcessing } from "./customerCriteriaServer";

function database(config: boolean, paid: boolean | null, fail = false) {
  const lookups: Array<[string, string, unknown]> = [];
  const db = { from: (table: string) => ({ select: () => ({ eq: (column: string, id: unknown) => {
    lookups.push([table, column, id]);
    return { single: async () => table === "intelligence_config"
      ? { data: { enabled: config }, error: null }
      : { data: paid === null ? null : { enabled: paid }, error: fail ? { message: "unavailable" } : null } };
  } }) }) };
  return { db: db as unknown as ReturnType<typeof serviceClient>, lookups };
}

describe("approved criteria processing status", () => {
  it("reads the canonical text policy ID and preserves the paid pause", async () => {
    const { db, lookups } = database(true, false);
    expect(await loadCustomerCriteriaProcessing(db)).toBe("paused");
    expect(lookups).toContainEqual(["intelligence_jev_budget_policy", "id", "jev-rollout-2026-09-24"]);
    expect(await loadCustomerCriteriaProcessing(database(false, true).db)).toBe("paused");
    expect(await loadCustomerCriteriaProcessing(database(true, true).db)).toBe("enabled");
  });
  it("keeps unavailable or missing policy state distinct from a confirmed pause", async () => {
    expect(await loadCustomerCriteriaProcessing(database(true, null).db)).toBe("unavailable");
    expect(await loadCustomerCriteriaProcessing(database(true, false, true).db)).toBe("unavailable");
  });
});
