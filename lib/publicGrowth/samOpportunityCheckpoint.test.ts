import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ update: vi.fn(), eq: vi.fn(), gt: vi.fn(), single: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => {
  const chain = { update: h.update, eq: h.eq, gt: h.gt, select: () => chain, maybeSingle: h.single };
  h.update.mockReturnValue(chain); h.eq.mockReturnValue(chain); h.gt.mockReturnValue(chain);
  return { from: () => chain, rpc: h.rpc };
} }));
import { checkpointPublicGrowthSweep, completePublicGrowthSweep, PublicGrowthSweepLeaseLostError } from "./sweepState";
const lease = () => ({ source: "sam-opportunities", managed: true, token: "token", offset: 777, batchSize: 1000, cursor: { offset: 777, priorHistory: { kept: true } }, leaseUntil: "2099-01-01" });
beforeEach(() => { for (const mock of Object.values(h)) mock.mockReset(); h.single.mockResolvedValue({ data: { source: "sam-opportunities" }, error: null }); h.rpc.mockResolvedValue({ data: true, error: null }); });
describe("SAM in-run lease checkpoints", () => {
  it("fences the exact source, token and unexpired lease and retains historical numeric state", async () => {
    const acquired = lease(); const source = { nextByte: 123, identity: { hash: "frozen" } };
    await checkpointPublicGrowthSweep(acquired, { samOpportunityCursor: source }); source.nextByte = 999;
    expect(h.eq).toHaveBeenCalledWith("source", acquired.source); expect(h.eq).toHaveBeenCalledWith("lease_token", "token"); expect(h.gt).toHaveBeenCalledWith("lease_until", expect.any(String));
    expect(acquired.cursor).toEqual({ offset: 777, priorHistory: { kept: true }, samOpportunityCursor: { nextByte: 123, identity: { hash: "frozen" } } });
    expect(h.update.mock.calls[0][0]).not.toHaveProperty("lease_token");
  });
  it("does not advance local state after a failed or lost checkpoint and rejects unmanaged work", async () => {
    const acquired = lease(); const original = structuredClone(acquired.cursor);
    h.single.mockResolvedValueOnce({ data: null, error: null });
    await expect(checkpointPublicGrowthSweep(acquired, { nextByte: 20 })).rejects.toBeInstanceOf(PublicGrowthSweepLeaseLostError);
    h.single.mockResolvedValueOnce({ data: null, error: { message: "failed" } });
    await expect(checkpointPublicGrowthSweep(acquired, { nextByte: 30 })).rejects.toThrow(/failed/);
    await expect(checkpointPublicGrowthSweep({ ...acquired, managed: false }, {})).rejects.toBeInstanceOf(PublicGrowthSweepLeaseLostError);
    expect(acquired.cursor).toEqual(original);
  });
  it("stores explicit partial-source progress in the durable terminal run receipt", async () => {
    const progress = { sourceSnapshotComplete: false, nextByte: 123, totalBytes: 1000, pendingNotice: true };
    await completePublicGrowthSweep(lease(), { checked: 2, errors: 0, done: false, mode: "public_bulk_bounded", advanceCursor: false, opportunityProgress: progress });
    expect(h.rpc).toHaveBeenCalledWith("complete_public_growth_sweep_lease", expect.objectContaining({ p_receipt: expect.objectContaining({ done: false, nextOffset: 777, opportunityProgress: progress }) }));
  });
});
