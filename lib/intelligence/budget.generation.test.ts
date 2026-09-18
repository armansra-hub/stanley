import { beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
import { generationCost, reserveGeneration, settleGeneration, GENERATION_RESERVATION_USD } from "./budget";

beforeEach(() => rpc.mockReset().mockResolvedValue({ data: true, error: null }));
describe("generation spend accounting", () => {
  it("reserves known Haiku pricing before dispatch and rejects an unpriced model", async () => {
    expect(await reserveGeneration("claude-sonnet-unknown")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(await reserveGeneration("claude-haiku-4-5")).toEqual(expect.any(String));
    expect(rpc).toHaveBeenCalledWith("intelligence_reserve", expect.objectContaining({ p_category: "generation", p_amount: GENERATION_RESERVATION_USD }));
  });
  it("charges actual input/output/cache usage and retains unknown consumption", async () => {
    expect(generationCost({ inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 100, cacheReadInputTokens: 50 })).toBe(0.00213);
    await settleGeneration("receipt", null);
    expect(rpc).toHaveBeenLastCalledWith("intelligence_settle", { p_id: "receipt", p_actual: null, p_tokens: null });
    await settleGeneration("receipt", { inputTokens: 1000, outputTokens: 200 });
    expect(rpc).toHaveBeenLastCalledWith("intelligence_settle", { p_id: "receipt", p_actual: 0.002, p_tokens: 1000 });
    expect(() => generationCost({ inputTokens: -1, outputTokens: 1 })).toThrow();
  });
});
