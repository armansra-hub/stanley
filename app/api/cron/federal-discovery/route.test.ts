import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), checkpoint: vi.fn(), complete: vi.fn(), fail: vi.fn(), rpc: vi.fn(), worker: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc,
  from: (table: string) => { if (table !== "app_events") throw new Error("Unexpected table");
    return { insert: (record: unknown) => ({ select: () => ({ single: () => mocks.event(record) }) }) }; },
}) }));
vi.mock("@/lib/publicGrowth/federalDiscovery", () => ({ discoverFederalCompany: mocks.worker }));
vi.mock("@/lib/publicGrowth/sweepState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/publicGrowth/sweepState")>();
  return { ...actual, beginPublicGrowthSweep: mocks.begin, checkpointPublicGrowthSweep: mocks.checkpoint,
    completePublicGrowthSweep: mocks.complete, failPublicGrowthSweep: mocks.fail };
});
import { GET } from "./route";
import { PublicGrowthSweepBusyError } from "@/lib/publicGrowth/sweepState";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, status = "no_candidate", httpStatus: number | null = null) => ({
  companyId: id(n), status, reason: status === "error" ? "provider_error" : "bounded_search", stage: "initial_award_search",
  elapsedMs: 10, sourceRequests: 1, verified: status === "matched", historyComplete: false, exhaustive: false, httpStatus, mayHaveWritten: false,
});
const request = (query = "", headers: Record<string, string> = { "x-cron-secret": "test-secret" }) =>
  new NextRequest(`https://example.test/api/cron/federal-discovery${query}`, { headers });
const retry = (n: number) => ({ companyId: id(n), failureAttempts: 1, queuedAt: "2026-09-15T00:00:00Z",
  lastAttemptedAt: "2026-09-15T00:00:00Z", firstFailedAt: "2026-09-15T00:00:00Z", lastError: "provider_error", awardContinuation: null });

describe("federal discovery managed admission", () => {
  let lease: { source: string; offset: number; batchSize: number; managed: boolean; token: string; leaseUntil: string; cursor: Record<string, unknown> };
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-secret"); vi.stubEnv("TAM_GROWTH_SWEEP_SECRET", "growth-secret");
    vi.useFakeTimers(); vi.setSystemTime("2026-09-15T00:00:00Z");
    vi.clearAllMocks();
    lease = { source: "federal-discovery", offset: 0, batchSize: 20, managed: true, token: id(999),
      leaseUntil: "2026-09-15T00:06:00Z", cursor: {} };
    mocks.begin.mockResolvedValue(lease);
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch }; });
    mocks.complete.mockResolvedValue(0); mocks.fail.mockResolvedValue(true);
    mocks.event.mockImplementation(async (record) => ({ data: { id: record.id, meta: record.meta }, error: null }));
    mocks.rpc.mockResolvedValue({ data: Array.from({ length: 21 }, (_, n) => ({ id: id(n + 1) })), error: null });
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12))));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("rejects absent/query credentials and accepts only configured header or bearer secrets", async () => {
    expect((await GET(request("", {}))).status).toBe(401);
    expect((await GET(request("?secret=test-secret", {}))).status).toBe(401);
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect((await GET(request("", { authorization: "Bearer growth-secret" }))).status).toBe(200);
    expect(mocks.begin).toHaveBeenCalledWith("federal-discovery", 20, null);
  });

  it("refuses cursor resets, explicit IDs, invalid limits and oversized selection", async () => {
    for (const q of ["?offset=0", "?companyId="+id(1), "?limit=0", "?limit=21", "?limit=1.5", "?limit=no"]) {
      expect((await GET(request(q))).status).toBe(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: Array.from({ length: 22 }, (_, n) => ({ id: id(n + 1) })), error: null });
    expect((await GET(request())).status).toBe(500); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("uses one lookahead without attempting or checkpointing it", async () => {
    const body = await (await GET(request())).json();
    expect(mocks.rpc).toHaveBeenCalledWith("list_federal_discovery_tam_batch", { p_limit: 21, p_after_company_id: null });
    expect(body.checked).toBe(20); expect(body.afterCompanyId).toBe(id(20)); expect(body.attemptCycleComplete).toBe(false);
    expect(body.noCandidate).toBe(20); expect(body.coverageVerified).toBe(false); expect(body.historyComplete).toBe(false);
    expect(mocks.worker.mock.calls.some(([n]) => n === id(21))).toBe(false);
    expect(mocks.complete.mock.calls[0][1].advanceCursor).toBe(false);
  });

  it("wraps only an exhausted attempted page and labels it attempt completion", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const body = await (await GET(request())).json();
    expect(body.attemptCycleComplete).toBe(true); expect(body.afterCompanyId).toBeNull(); expect(body.coverageVerified).toBe(false);
  });

  it("persists exact error and ambiguous debt with keyset in the same fenced checkpoint", async () => {
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12)), companyId === id(2) ? "ambiguous" : companyId === id(1) ? "error" : "matched"));
    const body = await (await GET(request())).json();
    expect(body.errors).toBe(1); expect(body.ambiguous).toBe(1); expect(body.matched).toBe(18);
    expect(body.retryRemaining).toBe(2);
    const checkpoint = mocks.checkpoint.mock.calls.find(([, p]) => p.afterCompanyId === id(4))?.[1];
    expect(checkpoint.retryQueue.map((r: { companyId: string }) => r.companyId)).toEqual([id(1), id(2)]);
    expect(checkpoint.discoveryInFlight).toEqual([]);
  });

  it("serves exact retry debt first and does not duplicate an ID on its main page", async () => {
    lease.cursor = { retryQueue: [retry(1)], deadLetters: [] };
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }, { id: id(2) }], error: null });
    const body = await (await GET(request())).json();
    expect(mocks.worker.mock.calls.map(([n]) => n)).toEqual([id(1), id(2)]);
    expect(body.retryChecked).toBe(1); expect(body.mainChecked).toBe(1); expect(body.retryRemaining).toBe(0);
  });

  it("429 stops new waves and persists source backoff with exact debt", async () => {
    mocks.worker.mockImplementation(async (companyId) => row(Number(companyId.slice(-12)), companyId === id(1) ? "error" : "no_candidate", companyId === id(1) ? 429 : null));
    const response = await GET(request()); const body = await response.json();
    expect(response.status).toBe(429); expect(body.checked).toBe(4); expect(body.afterCompanyId).toBe(id(4));
    expect(body.notAttemptedCompanyIds).toHaveLength(16); expect(body.errors).toBe(1);
    expect(lease.cursor.discoveryBackoffUntil).toBe("2026-09-15T00:15:00.000Z");
    expect(lease.cursor.retryQueue).toHaveLength(1);
  });

  it("an active backoff does not select companies or make source requests", async () => {
    lease.cursor.discoveryBackoffUntil = "2026-09-15T00:15:00Z";
    const response = await GET(request()); expect(response.status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("never exceeds four live company operations", async () => {
    let active = 0, peak = 0;
    mocks.worker.mockImplementation(async (companyId) => { active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10)); active--; return row(Number(companyId.slice(-12))); });
    const pending = GET(request()); await vi.runAllTimersAsync(); await pending;
    expect(peak).toBe(4);
  });

  it("clamps company deadlines and leaves runtime-expired suffix unadvanced", async () => {
    mocks.worker.mockImplementation(async (companyId, options) => {
      expect(options.deadlineMs - Date.now()).toBeLessThanOrEqual(60_000);
      await new Promise((resolve) => setTimeout(resolve, 60_000)); return row(Number(companyId.slice(-12)));
    });
    const pending = GET(request()); await vi.runAllTimersAsync(); const body = await (await pending).json();
    expect(body.checked).toBe(16); expect(body.afterCompanyId).toBe(id(16)); expect(body.notAttemptedCompanyIds).toHaveLength(4);
  });

  it("does not launch any source call when checkpointing consumes the deadline", async () => {
    mocks.checkpoint.mockImplementation(async (_lease, patch) => { lease.cursor = { ...lease.cursor, ...patch };
      if (patch.discoveryInFlight?.length) vi.setSystemTime(Date.now() + 240_000); });
    const body = await (await GET(request())).json();
    expect(body.checked).toBe(0); expect(body.afterCompanyId).toBeNull(); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("busy lease and interrupted in-flight work make no new request", async () => {
    mocks.begin.mockRejectedValueOnce(new PublicGrowthSweepBusyError("federal-discovery", null));
    expect((await GET(request())).status).toBe(409);
    lease.cursor.discoveryInFlight = [id(1)]; expect((await GET(request())).status).toBe(409);
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("checkpoint failure retains in-flight evidence and cannot report cursor success", async () => {
    mocks.checkpoint.mockImplementation(async (_lease, patch) => {
      if (patch.afterCompanyId) throw new Error("database outage"); lease.cursor = { ...lease.cursor, ...patch };
    });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryInFlight).toEqual([id(1), id(2), id(3), id(4)]);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("rejects duplicate/non-monotonic source rows before provider work", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: id(2) }, { id: id(1) }], error: null });
    expect((await GET(request())).status).toBe(500); expect(mocks.worker).not.toHaveBeenCalled();
  });

  it("unknown thrown work is held for readback with unknown request count", async () => {
    mocks.worker.mockRejectedValue(new Error("not exposed"));
    mocks.rpc.mockResolvedValue({ data: [{ id: id(1) }], error: null });
    const response = await GET(request()); const body = await response.json(); expect(response.status).toBe(409);
    expect(body.outcomes[0].status).toBe("error"); expect(body.outcomes[0].sourceRequests).toBeNull();
    expect(body.uncertainCompanyIds).toEqual([id(1)]); expect(JSON.stringify(body)).not.toContain("not exposed");
    expect(lease.cursor.discoveryInFlight).toEqual([id(1)]); expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("journals every exact attempt and confirms it before cursor/debt advancement", async () => {
    await GET(request());
    expect(mocks.event).toHaveBeenCalledTimes(5);
    expect(mocks.event.mock.calls.flatMap(([event]) => event.meta.attemptedCompanies.map((r: { companyId: string }) => r.companyId)))
      .toEqual(Array.from({ length: 20 }, (_, n) => id(n + 1)));
    expect(mocks.event.mock.calls.every(([event]) => event.kind === "federal.discovery.attempts" && event.meta.coverageVerified === false)).toBe(true);
    expect(mocks.event.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkpoint.mock.invocationCallOrder[1]);
  });

  it("a failed or mismatched attempt journal keeps in-flight evidence and never advances", async () => {
    mocks.event.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect((await GET(request())).status).toBe(500);
    expect(lease.cursor.discoveryInFlight).toHaveLength(4); expect(mocks.complete).not.toHaveBeenCalled();
    expect(lease.cursor.afterCompanyId).toBeUndefined();
  });

  it.each(["error", "ambiguous"])("possible partial enrollment %s never enters automatic retry debt or advances its wave", async (status) => {
    mocks.worker.mockImplementation(async (companyId) => ({ ...row(Number(companyId.slice(-12)), status), mayHaveWritten: true }));
    const response = await GET(request()); const body = await response.json(); expect(response.status).toBe(409);
    expect(body.checked).toBe(4); expect(body.afterCompanyId).toBeNull(); expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(lease.cursor.discoveryUncertainOutcomes).toHaveLength(4); expect(lease.cursor.discoveryInFlight).toHaveLength(4);
    expect(lease.cursor.retryQueue).toBeUndefined(); expect(mocks.complete).not.toHaveBeenCalled();
    mocks.worker.mockClear();
    expect((await GET(request())).status).toBe(409); expect(mocks.worker).not.toHaveBeenCalled();
  });
});

describe("discovery selector migration boundary", () => {
  it("uses exact current membership and the inverse existing verified recipient/award eligibility", () => {
    const sql = readFileSync(new URL("../../../../supabase/migrations/0057_federal_discovery_selector.sql", import.meta.url), "utf8");
    expect(sql).toContain("c.status is distinct from 'removed_from_tam'");
    expect(sql).toContain("coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]");
    expect(sql).toContain("and not exists ("); expect(sql).toContain("m.match_status = 'verified'");
    expect(sql).toContain("e.usaspending_recipient_id is not null"); expect(sql).toContain("a.government_entity_id = e.id");
    expect(sql).toContain("c.id > p_after_company_id"); expect(sql).toContain("order by c.id");
    expect(sql).toContain("from public, anon, authenticated"); expect(sql).toContain("to service_role");
    expect(sql).not.toContain("reconcile_company_signal_flags"); expect(sql).not.toContain("list_public_growth_recurring_tam_batch_v2(");
  });
});
