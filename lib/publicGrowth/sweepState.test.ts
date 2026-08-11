import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import {
  beginPublicGrowthSweep,
  completePublicGrowthSweep,
  failPublicGrowthSweep,
  PUBLIC_GROWTH_LEASE_SECONDS,
  PublicGrowthSweepBusyError,
  PublicGrowthSweepLeaseLostError,
} from "./sweepState";

const token = "11111111-1111-4111-8111-111111111111";

describe("public-growth sweep lease", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("atomically acquires the cursor and opaque fencing token", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        acquired: true,
        lease_token: token,
        lease_until: "2026-08-11T00:06:00.000Z",
        cursor: { offset: 250, version: 1 },
      },
      error: null,
    });
    const lease = await beginPublicGrowthSweep("revenue", 250, null);
    expect(mocks.rpc).toHaveBeenCalledWith("acquire_public_growth_sweep_lease", {
      p_source: "revenue",
      p_lease_seconds: PUBLIC_GROWTH_LEASE_SECONDS,
    });
    expect(lease).toEqual(expect.objectContaining({
      source: "revenue",
      offset: 250,
      managed: true,
      token,
      cursor: { offset: 250, version: 1 },
    }));
  });

  it("reports an overlapping source as busy without starting work", async () => {
    mocks.rpc.mockResolvedValue({
      data: { acquired: false, lease_until: "2026-08-11T00:06:00.000Z" },
      error: null,
    });
    await expect(beginPublicGrowthSweep("sam-entity", 10, null)).rejects.toEqual(
      expect.objectContaining({
        name: "PublicGrowthSweepBusyError",
        source: "sam-entity",
        retryAt: "2026-08-11T00:06:00.000Z",
      }),
    );
  });

  it("persists completion only through the matching fencing token", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    const next = await completePublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250, version: 1 },
      token,
      leaseUntil: "2026-08-11T00:06:00.000Z",
    }, { checked: 250, nextOffset: 500, done: false, observed: 200, triggers: 3 });
    expect(next).toBe(500);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_public_growth_sweep_lease", expect.objectContaining({
      p_source: "revenue",
      p_lease_token: token,
      p_cursor: { offset: 500, version: 1 },
      p_receipt: expect.objectContaining({ checked: 250, nextOffset: 500, matched: 200, triggers: 3 }),
    }));
  });

  it("rejects a stale completion instead of rewinding a newer cursor", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(completePublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250 },
      token,
      leaseUntil: null,
    }, { checked: 250, nextOffset: 500 })).rejects.toBeInstanceOf(PublicGrowthSweepLeaseLostError);
  });

  it("records failures only for the matching token", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const recorded = await failPublicGrowthSweep({
      source: "revenue",
      offset: 250,
      batchSize: 250,
      managed: true,
      cursor: { offset: 250 },
      token,
      leaseUntil: null,
    }, new Error("upstream timed out"));
    expect(recorded).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith("fail_public_growth_sweep_lease", {
      p_source: "revenue",
      p_lease_token: token,
      p_error: "upstream timed out",
    });
  });

  it("keeps explicit manual offsets outside managed state", async () => {
    const lease = await beginPublicGrowthSweep("revenue", 250, 750);
    const next = await completePublicGrowthSweep(lease, { checked: 250, nextOffset: 1000 });
    expect(next).toBe(750);
    expect(lease).toEqual(expect.objectContaining({ managed: false, token: null, offset: 750 }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("exports distinct typed lease errors", () => {
    expect(new PublicGrowthSweepBusyError("revenue", null).name).toBe("PublicGrowthSweepBusyError");
    expect(new PublicGrowthSweepLeaseLostError("revenue").name).toBe("PublicGrowthSweepLeaseLostError");
  });
});
