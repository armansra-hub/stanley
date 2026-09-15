import { afterEach, describe, expect, it, vi } from "vitest";
import { rotationBatches } from "./rotationBatches";

afterEach(() => vi.restoreAllMocks());

describe("source rotation reservations", () => {
  it("never reserves the unattempted remainder when the work deadline expires", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const load = vi.fn(async (n: number) => Array.from({ length: n }, (_, i) => i));
    const attempted: number[][] = [];
    for await (const rows of rotationBatches(load, { limit: 250, batchSize: 8, budgetMs: 48_000 })) {
      attempted.push(rows);
      now += 25_000;
    }
    expect(attempted.flat()).toHaveLength(16);
    expect(load.mock.calls).toEqual([[8, 0], [8, 0]]);
  });

  it("attempts the batch even when its reservation crosses the deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const load = vi.fn(async () => { now = 100; return ["claimed"]; });
    const attempted = [];
    for await (const batch of rotationBatches(load, { limit: 10, batchSize: 1, budgetMs: 50 })) attempted.push(...batch);
    expect(attempted).toEqual(["claimed"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("takes the exact remainder and ends without retrying an exhausted source", async () => {
    const load = vi.fn(async (n: number) => Array(n).fill("row"));
    for await (const _ of rotationBatches(load, { limit: 10, batchSize: 4 })) { /* attempted */ }
    expect(load.mock.calls).toEqual([[4, 0], [4, 0], [2, 0]]);
    const empty = vi.fn(async () => []);
    for await (const _ of rotationBatches(empty, { limit: 10, batchSize: 4 })) { /* empty */ }
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("keeps manual positive-offset recovery on one snapshot", async () => {
    const load = vi.fn(async () => [1, 2, 3, 4, 5]);
    const attempted = [];
    for await (const batch of rotationBatches(load, { limit: 5, batchSize: 2, offset: 100 })) attempted.push(...batch);
    expect(attempted).toEqual([1, 2, 3, 4, 5]);
    expect(load.mock.calls).toEqual([[5, 100]]);
  });
});
