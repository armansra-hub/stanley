import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ single: vi.fn(), update: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: h.single, update: h.update };
  h.update.mockReturnValue(chain); return { from: () => chain };
} }));
vi.mock("@/lib/db/events", () => ({ logEvent: h.event }));
import { reheatCompanyForFreshSignal } from "./reheat";
const call = (strict = true) => reheatCompanyForFreshSignal("company", "sam_award_notice", "https://sam.gov/opp/example/view", "2026-09-15", { strict });
beforeEach(() => { h.single.mockReset(); h.update.mockReset(); h.event.mockReset(); h.event.mockResolvedValue(undefined); });
describe("strict SAM reheat acknowledgement", () => {
  it("throws on a source-budget/read failure while preserving default callers", async () => {
    h.single.mockResolvedValue({ data: null, error: { message: "aborted" } });
    await expect(call()).rejects.toThrow(/read failed/); expect(h.update).not.toHaveBeenCalled();
    await expect(call(false)).resolves.toBe(false);
  });
  it("throws on an uncertain conditional update and does not manufacture a reheat event", async () => {
    h.single.mockResolvedValueOnce({ data: { status: "reviewed", lists: ["netsuite_tam"] }, error: null }).mockResolvedValueOnce({ data: null, error: { message: "aborted" } });
    await expect(call()).rejects.toThrow(/update failed/); expect(h.event).not.toHaveBeenCalled();
  });
  it("retains the existing human-review date and conditional-update gates", async () => {
    h.single.mockResolvedValueOnce({ data: { status: "reviewed", lists: ["netsuite_tam"], trigger_reviewed_through: "2026-09-16" }, error: null });
    await expect(call()).resolves.toBe(false); expect(h.update).not.toHaveBeenCalled();
    h.single.mockResolvedValueOnce({ data: { status: "reviewed", lists: ["netsuite_tam"] }, error: null }).mockResolvedValueOnce({ data: null, error: null });
    await expect(call()).resolves.toBe(false); expect(h.event).not.toHaveBeenCalled();
  });
});
