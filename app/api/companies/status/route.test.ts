import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), deadline: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }),
  withServiceDeadline: (deadline: number, fn: () => unknown) => { mocks.deadline(deadline); return fn(); } }));
import { POST } from "./route";
const a = "a1000000-0000-4000-8000-000000000001", b = "b1000000-0000-4000-8000-000000000002";
const post = (body: unknown) => POST(new NextRequest("https://stanley.test/api/companies/status", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
beforeEach(() => {
  mocks.rpc.mockReset().mockImplementation(async (_name, args) => ({ data: {
    ok: true, ids: args.p_ids, count: args.p_ids.length, status: args.p_status,
  }, error: null }));
  mocks.deadline.mockReset();
});
describe("exact bulk review status", () => {
  it.each(["new", "reviewed", "dismissed"])("saves %s and returns the exact stored set in one transaction", async status => {
    const response = await post({ ids: [a, b], status });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ids: [a, b], count: 2, status });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("companies_set_review_status", { p_ids: [a, b], p_status: status });
    expect(mocks.deadline).toHaveBeenCalledWith(expect.any(Number));
  });
  it("deduplicates equivalent UUIDs without inflating the acknowledgement", async () => {
    const response = await post({ ids: [a, a.toUpperCase(), b], status: "dismissed" });
    expect(await response.json()).toMatchObject({ ids: [a, b], count: 2 });
  });
  it.each([null, [], { ids: [] }, { ids: [a, 4], status: "dismissed" }, { ids: ["bad"], status: "new" },
    { ids: [a], status: "removed_from_tam" }, { ids: new Array(10001).fill(a), status: "new" }])("rejects invalid input before storage", async body => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("never acknowledges a missing or different stored company", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, ids: [b], count: 1, status: "dismissed" }, error: null });
    const response = await post({ ids: [a], status: "dismissed" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "status_confirmation_unavailable" });
  });
  it("reports an unknown company without a successful receipt or automatic retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "private db data" } });
      expect((await post({ ids: [a], status: "dismissed" })).status).toBe(409);
      expect(log).toHaveBeenCalledWith("companies.status_write_failed", { code: "P0002" });
      expect(mocks.rpc).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it("leaves a lost write response uncertain and does not replay the write", async () => {
    mocks.rpc.mockRejectedValue(new Error("Response lost after commit"));
    const response = await post({ ids: [a], status: "dismissed" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "status_confirmation_unavailable" });
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
});
