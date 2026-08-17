import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  companyRows: [] as Array<{ id: string; name: string; revenue_band: string | null }>,
  range: vi.fn(),
  observationUpsert: vi.fn(),
  priorTriggers: [] as Array<{ company_id: string; dedupe_key: string }>,
  recordBulk: vi.fn(),
  recomputePriority: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "company_revenue_observations") {
        return { upsert: mocks.observationUpsert };
      }
      if (table === "triggers") {
        const query: Record<string, unknown> = {};
        query.select = vi.fn(() => query);
        query.in = vi.fn(() => query);
        query.eq = vi.fn(async () => ({ data: mocks.priorTriggers, error: null }));
        return query;
      }
      if (table !== "companies") throw new Error(`unexpected table ${table}`);
      const query: Record<string, unknown> = {};
      for (const method of ["select", "contains", "neq", "order"]) {
        query[method] = vi.fn(() => query);
      }
      query.range = mocks.range;
      return query;
    },
  }),
}));

vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.recomputePriority }));
vi.mock("./storage", () => ({
  recordPublicGrowthTriggersBulk: mocks.recordBulk,
  stableHash: () => "a".repeat(64),
}));

import { parseRevenueEstimate, sweepRevenueTamBatch } from "./revenueSweep";

describe("revenue TAM sweep", () => {
  beforeEach(() => {
    mocks.companyRows = [
      { id: "company-1", name: "One", revenue_band: "$50M-$100M" },
      { id: "company-2", name: "Two", revenue_band: "$20M-$30M" },
      { id: "company-3", name: "No estimate", revenue_band: null },
    ];
    mocks.range.mockReset().mockImplementation(async () => ({ data: mocks.companyRows, error: null }));
    mocks.observationUpsert.mockReset().mockResolvedValue({ error: null });
    mocks.priorTriggers = [];
    mocks.recordBulk.mockReset().mockResolvedValue(7);
    mocks.recomputePriority.mockReset().mockResolvedValue(42);
  });

  it("parses the defensible lower bound of a revenue band", () => {
    expect(parseRevenueEstimate("$50M - $100M")).toBe(50_000_000);
    expect(parseRevenueEstimate(null)).toBeNull();
  });

  it("recomputes every unique affected company after the bulk insert", async () => {
    const result = await sweepRevenueTamBatch(250, 500);
    expect(mocks.recordBulk).toHaveBeenCalledOnce();
    expect(mocks.recomputePriority.mock.calls).toEqual([
      ["company-1"],
      ["company-2"],
    ]);
    expect(mocks.recordBulk.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.recomputePriority.mock.invocationCallOrder[0]);
    expect(result).toEqual(expect.objectContaining({
      offset: 500,
      checked: 3,
      triggers: 7,
      prioritiesRecomputed: 2,
    }));
    expect(result).not.toHaveProperty("priorityPending");
  });

  it("recomputes duplicate candidates on retry even when all trigger inserts dedupe", async () => {
    mocks.recordBulk.mockResolvedValue(0);
    const result = await sweepRevenueTamBatch(250, 0);
    expect(mocks.recomputePriority).toHaveBeenCalledTimes(2);
    expect(result.prioritiesRecomputed).toBe(2);
  });

  it("does not report completion when any affected priority remains stale", async () => {
    mocks.recomputePriority.mockImplementation(async (companyId: string) => {
      if (companyId === "company-2") throw new Error("priority write failed");
      return 42;
    });
    await expect(sweepRevenueTamBatch(250, 0)).rejects.toThrow("priority write failed");
  });

  it("loads a 3,500-company daily allocation in bounded database pages", async () => {
    const rows = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
      id: `company-${start + index}`,
      name: `Company ${start + index}`,
      revenue_band: null,
    }));
    mocks.range.mockReset()
      .mockResolvedValueOnce({ data: rows(0, 1000), error: null })
      .mockResolvedValueOnce({ data: rows(1000, 1000), error: null })
      .mockResolvedValueOnce({ data: rows(2000, 1000), error: null })
      .mockResolvedValueOnce({ data: rows(3000, 500), error: null });
    const result = await sweepRevenueTamBatch(3500, 0);
    expect(mocks.range).toHaveBeenCalledTimes(4);
    expect(result).toEqual(expect.objectContaining({ checked: 3500, nextOffset: 3500, done: false }));
  });
});
