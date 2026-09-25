import { beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc }) }));
import { authorizeJevDispatch, withJevDispatchPermit, JevBudgetDeferredError, jevCost,
  JEV_RESERVATION_USD, reserveJev, readJevBudgetPolicy } from "./budget";
import { durableJevRequest } from "./jevRequests";
const fp = "a".repeat(64);
const permit = () => ({ fingerprint: fp, rawFingerprint: fp, reservationId: "reservation", leaseToken: "lease", rpc });
const authorized = () => ({ data: { status: "authorized", model: "jev-1.13.0", expiresAt: new Date(Date.now() + 30_000).toISOString() }, error: null });
beforeEach(() => { vi.clearAllMocks(); rpc.mockResolvedValue(authorized()); });
describe("global Jev dispatch gate", () => {
  it("uses the complete priced ceiling and closes the legacy unscoped reservation", async () => {
    expect(jevCost(65536)).toBe(JEV_RESERVATION_USD);
    expect(() => jevCost(1.2)).toThrow();
    expect(await reserveJev()).toBeNull();
    expect(await reserveJev({ purpose: "private_tam" })).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("cannot dispatch directly, with another payload, or with an unpriced model", async () => {
    await expect(authorizeJevDispatch("jev-1.13.0", fp)).rejects.toThrow("dispatch_ticket_required");
    await expect(withJevDispatchPermit(permit(), () => authorizeJevDispatch("jev-1.14.0", fp))).rejects.toThrow("unpriced_model");
    await expect(withJevDispatchPermit(permit(), () => authorizeJevDispatch("jev-1.13.0", "b".repeat(64)))).rejects.toThrow("dispatch_ticket_required");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("consumes one ticket once, binding its exact model and payload", async () => {
    await withJevDispatchPermit(permit(), async () => {
      await authorizeJevDispatch("jev-1.13.0", fp);
      await expect(authorizeJevDispatch("jev-1.13.0", fp)).rejects.toThrow("dispatch_ticket_required");
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("intelligence_jev_dispatch", {
      p_fingerprint: fp, p_reservation: "reservation", p_lease: "lease", p_model: "jev-1.13.0",
    });
  });
  it("does not recycle a ticket after a lost authorization response", async () => {
    rpc.mockRejectedValueOnce(new Error("lost"));
    await withJevDispatchPermit(permit(), async () => {
      await expect(authorizeJevDispatch("jev-1.13.0", fp)).rejects.toThrow("dispatch_authorization_unavailable");
      await expect(authorizeJevDispatch("jev-1.13.0", fp)).rejects.toThrow("dispatch_ticket_required");
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("propagates daily retryAt and terminal holds without invoking paid work", async () => {
    for (const retryAt of ["2026-09-26T07:00:00Z", null]) {
      const decision = { status: "budget_deferred" as const, reason: retryAt ? "daily_allowance_exhausted" : "maintenance_allowance_exhausted", retryAt };
      rpc.mockResolvedValue({ data: decision, error: null });
      const execute = vi.fn();
      expect(await durableJevRequest({ fingerprint: fp, context: { purpose: "operating_catalog", sourceKind: "catalog" }, execute }, { rpc })).toEqual(decision);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("pausing between reservation and dispatch returns a deferral and proves zero provider usage", async () => {
    const decision = { status: "budget_deferred" as const, reason: "policy_disabled", retryAt: null };
    rpc.mockImplementation(async name => ({ error: null, data: name === "intelligence_jev_claim"
      ? { status: "execute", reservationId: "reservation", leaseToken: "lease" }
      : name === "intelligence_jev_dispatch" ? decision : true }));
    const paid = vi.fn();
    const result = await durableJevRequest({ fingerprint: fp, context: { purpose: "operating_catalog", sourceKind: "catalog" },
      execute: async () => { await authorizeJevDispatch("jev-1.13.0", fp); paid(); return { ok: true, usage: null }; } }, { rpc });
    expect(result).toEqual(decision); expect(paid).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith("intelligence_settle", { p_id: "reservation", p_actual: 0, p_tokens: 0 });
  });
  it("leaves an accepted/uncertain provider attempt reserved, without refund or automatic retry", async () => {
    rpc.mockImplementation(async name => name === "intelligence_jev_claim"
      ? { data: { status: "execute", reservationId: "reservation", leaseToken: "lease" }, error: null } : authorized());
    const paid = vi.fn(() => { throw new Error("acceptance unknown"); });
    await expect(durableJevRequest({ fingerprint: fp, context: { purpose: "operating_catalog", sourceKind: "catalog" },
      execute: async () => { await authorizeJevDispatch("jev-1.13.0", fp); paid(); return { ok: true, usage: null }; } }, { rpc })).rejects.toThrow("acceptance unknown");
    expect(paid).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(["intelligence_jev_claim", "intelligence_jev_dispatch"]);
  });
  it("requeues a valid ticket received after expiry without sending paid work", async () => {
    const before = Date.now();
    rpc.mockImplementation(async name => ({ error: null, data: name === "intelligence_jev_claim"
      ? { status: "execute", reservationId: "reservation", leaseToken: "lease" }
      : name === "intelligence_jev_dispatch" ? { ...authorized().data, expiresAt: "2020-01-01T00:00:00Z" } : true }));
    const paid = vi.fn();
    const result = await durableJevRequest({ fingerprint: fp, context: { purpose: "operating_catalog", sourceKind: "catalog" },
      execute: async () => { await authorizeJevDispatch("jev-1.13.0", fp); paid(); return { ok: true, usage: null }; } }, { rpc });
    expect(result).toMatchObject({ status: "budget_deferred", reason: "dispatch_ticket_expired" });
    if (result.status !== "budget_deferred") throw new Error("Expected deferral");
    expect(Date.parse(result.retryAt!)).toBeGreaterThanOrEqual(before + 60_000);
    expect(Date.parse(result.retryAt!)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(paid).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith("intelligence_settle", { p_id: "reservation", p_actual: 0, p_tokens: 0 });
  });
  it("keeps malformed tickets on hold rather than retrying them", async () => {
    for (const data of [{ ...authorized().data, expiresAt: "invalid" }, { status: "authorized", model: "jev-1.13.0" },
      { ...authorized().data, model: "unexpected" }]) {
      rpc.mockResolvedValue({ data, error: null });
      await expect(withJevDispatchPermit(permit(), () => authorizeJevDispatch("jev-1.13.0", fp)))
        .rejects.toMatchObject({ decision: { reason: "dispatch_ticket_expired", retryAt: null } });
    }
  });
  it("reports unavailable diagnostics honestly", async () => {
    rpc.mockResolvedValue({ data: { ...authorized().data, expiresAt: "2020-01-01T00:00:00Z" }, error: null });
    await expect(withJevDispatchPermit(permit(), () => authorizeJevDispatch("jev-1.13.0", fp))).rejects.toBeInstanceOf(JevBudgetDeferredError);
    expect(await readJevBudgetPolicy()).toEqual({ available: false });
    rpc.mockRejectedValue(new Error("offline"));
    expect(await readJevBudgetPolicy()).toEqual({ available: false });
  });
});
