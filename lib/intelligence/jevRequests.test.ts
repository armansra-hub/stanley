import { describe, expect, it, vi } from "vitest";
import { durableJevRequest, scopedJevFingerprint } from "./jevRequests";

const fingerprint = "a".repeat(64);
const context = { purpose: "public_interpretation" as const, companyId: "account", sourceKind: "website", workload: "monitoring" as const };
const evaluation = { ok: true, usage: { inputTokens: 1234, outputTokens: 12 },
  metadata: { rawAnswers: { role: { type: "choice", choice: "publisher" } } } };
const claim = { status: "execute", reservationId: "spend", leaseToken: "lease" };

describe("durable Jev responses", () => {
  it("commits the unchanged answer before accounting and returns it if accounting fails", async () => {
    const order: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      order.push(name);
      if (name === "intelligence_jev_claim") return { data: claim, error: null };
      if (name === "intelligence_jev_record") return { data: true, error: null };
      throw new Error("accounting unavailable");
    });
    const execute = vi.fn(async () => { order.push("paid_call"); return evaluation; });
    const result = await durableJevRequest({ fingerprint, context, execute }, { rpc });
    expect(result).toEqual({ status: "complete", evaluation, reused: false });
    expect(order).toEqual(["intelligence_jev_claim", "paid_call", "intelligence_jev_record", "intelligence_jev_settle"]);
    expect(rpc.mock.calls[2]).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reuses a saved answer and repairs accounting without another inference", async () => {
    const execute = vi.fn();
    const rpc = vi.fn(async (name: string) => ({ data: name === "intelligence_jev_claim"
      ? { status: "complete", evaluation, reservationId: "spend" } : true, error: null }));
    expect(await durableJevRequest({ fingerprint, context, execute }, { rpc }))
      .toEqual({ status: "complete", evaluation, reused: true });
    expect(execute).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["intelligence_jev_claim", "intelligence_jev_settle"]);
  });

  it.each(["busy", "budget_deferred"] as const)("never dispatches a %s request", async status => {
    const execute = vi.fn();
    const rpc = vi.fn(async () => ({ data: { status }, error: null }));
    expect(await durableJevRequest({ fingerprint, context, execute }, { rpc })).toEqual({ status });
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries only a failed receipt write once and retains the same paid response", async () => {
    let writes = 0;
    const execute = vi.fn(async () => evaluation);
    const rpc = vi.fn(async (name: string) => {
      if (name === "intelligence_jev_claim") return { data: claim, error: null };
      if (name === "intelligence_jev_record" && ++writes === 1) return { data: null, error: { code: "db" } };
      return { data: true, error: null };
    });
    expect((await durableJevRequest({ fingerprint, context, execute }, { rpc })).status).toBe("complete");
    expect(execute).toHaveBeenCalledTimes(1); expect(writes).toBe(2);
  });

  it("does not claim or dispatch without durable storage, and rejects private caching", async () => {
    const execute = vi.fn();
    const rpc = vi.fn(async () => ({ data: null, error: { code: "db" } }));
    await expect(durableJevRequest({ fingerprint, context, execute }, { rpc })).rejects.toThrow("claim unavailable");
    await expect(durableJevRequest({ fingerprint, context: { purpose: "private_tam" }, execute }, { rpc })).rejects.toThrow("Private evidence");
    expect(execute).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps request content, account and task identities separate without including timestamps of bookkeeping", () => {
    const a = scopedJevFingerprint(fingerprint, context);
    expect(scopedJevFingerprint(fingerprint, { ...context, observationId: "another-provenance-link" })).toBe(a);
    expect(scopedJevFingerprint(fingerprint, { ...context, companyId: "other" })).not.toBe(a);
    expect(scopedJevFingerprint(fingerprint, { ...context, purpose: "saved_view" })).not.toBe(a);
    expect(scopedJevFingerprint("b".repeat(64), context)).not.toBe(a);
  });
});
