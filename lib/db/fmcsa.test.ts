import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFmcsaSnapshot, upsertFmcsaSnapshot } from "./fmcsa";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: mocks.read }) }), upsert: mocks.write,
}) }) }));
beforeEach(() => {
  mocks.read.mockReset(); mocks.write.mockReset();
  mocks.read.mockResolvedValue({ data: null, error: { code: "42P01" } });
  mocks.write.mockResolvedValue({ error: { code: "42501" } });
});
describe("strict FMCSA snapshot persistence", () => {
  it("does not confuse a failed prior read with the first baseline in strict mode", async () => {
    expect(await getFmcsaSnapshot("123")).toBeNull();
    await expect(getFmcsaSnapshot("123", { strict: true })).rejects.toThrow("state read failed: 42P01");
    mocks.read.mockResolvedValue({ data: null, error: null });
    expect(await getFmcsaSnapshot("123", { strict: true })).toBeNull();
  });
  it("reports a rejected snapshot write to strict collectors", async () => {
    await expect(upsertFmcsaSnapshot("123", "Acme Logistics", 10, 20)).resolves.toBeUndefined();
    await expect(upsertFmcsaSnapshot("123", "Acme Logistics", 10, 20, { strict: true })).rejects.toThrow("state write failed: 42501");
  });
});
