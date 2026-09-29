import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), update: vi.fn(), eq: vi.fn(), in: vi.fn(), select: vi.fn(), filter: vi.fn(), order: vi.fn(), range: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
import { listTalCompanies, markChecked, setAtsChecked, setSiteChecked, setTalAlert } from "./triggers";
import { newSweepOutcomes, sweepError } from "@/lib/triggers/sweepOutcomes";

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.from.mockReturnValue({ update: mocks.update, select: mocks.select });
  mocks.update.mockReturnValue({ eq: mocks.eq, in: mocks.in });
  mocks.eq.mockResolvedValue({ error: null });
  mocks.in.mockResolvedValue({ error: null });
  mocks.select.mockReturnValue({ eq: mocks.filter });
  mocks.filter.mockReturnValue({ order: mocks.order });
  mocks.order.mockReturnValue({ order: mocks.order, range: mocks.range });
  mocks.range.mockResolvedValue({ data: [], error: null });
});

const writes = [
  ["News", () => markChecked(["company-1"])],
  ["ATS", () => setAtsChecked("company-1", { ats_type: "lever", ats_token: "acme" })],
  ["Website", () => setSiteChecked("company-1", "retained-hash")],
  ["TAL alert", () => setTalAlert(["company-1"])],
] as const;

describe("source rotation checkpoint writes", () => {
  it.each(writes)("%s propagates a returned database error with a safe diagnostic code", async (source, write) => {
    const result = { error: { code: "42501", message: "private query token=secret" } };
    mocks.eq.mockResolvedValue(result); mocks.in.mockResolvedValue(result);
    await expect(write()).rejects.toThrow(`${source} checkpoint write failed: 42501`);
    await expect(write()).rejects.not.toThrow("secret");
  });

  it.each(writes)("%s never swallows an actual rejected write", async (_source, write) => {
    mocks.eq.mockRejectedValue(new Error("network unavailable"));
    mocks.in.mockRejectedValue(new Error("network unavailable"));
    await expect(write()).rejects.toThrow("network unavailable");
  });

  it.each(writes)("%s accepts an acknowledged write without an extra read", async (_source, write) => {
    await expect(write()).resolves.toBeUndefined();
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("does not send an empty news completion write", async () => {
    await markChecked([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not include arbitrary provider error codes in thrown diagnostics", async () => {
    mocks.in.mockResolvedValue({ error: { code: "https://example.com?token=secret" } });
    await expect(markChecked(["company-1"])).rejects.toThrow("News checkpoint write failed: database_error");
  });

  it("does not mistake a failed TAL page for an empty or complete worklist", async () => {
    mocks.range.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })), error: null });
    mocks.range.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "private details" } });
    await expect(listTalCompanies()).rejects.toThrow("TAL companies checkpoint read failed: 42501");
    expect(mocks.range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("loads TAL source context in deterministic oldest-first order", async () => {
    mocks.range.mockResolvedValue({ data: [{ id: "company-1", name: "Acme", domain: "acme.com", last_checked_at: null }], error: null });
    expect(await listTalCompanies()).toEqual([{ id: "company-1", name: "Acme", domain: "acme.com", last_checked_at: null }]);
    expect(mocks.select).toHaveBeenCalledWith(expect.stringContaining("domain, last_checked_at"));
    expect(mocks.order.mock.calls).toEqual([["id", { ascending: true }]]);
  });

  it("pages by stable IDs before applying mutable news timestamps to the full worklist", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `company-${String(index).padStart(4, "0")}`, name: "TAL account", domain: null, last_checked_at: "2026-09-29T00:00:00Z",
    }));
    mocks.range.mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: [{ id: "company-1000", name: "Never checked", domain: null, last_checked_at: null }], error: null });
    const result = await listTalCompanies();
    expect(result).toHaveLength(1001);
    expect(new Set(result.map(company => company.id)).size).toBe(1001);
    expect(result[0].id).toBe("company-1000");
    expect(result[1].id).toBe("company-0000");
    expect(mocks.order.mock.calls).toEqual([["id", { ascending: true }], ["id", { ascending: true }]]);
    expect(mocks.range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("stops a TAL alert batch on failed persistence without retrying or proceeding", async () => {
    mocks.in.mockResolvedValue({ error: { code: "42501" } });
    await expect(setTalAlert(Array.from({ length: 401 }, (_, index) => `company-${index}`))).rejects.toThrow("42501");
    expect(mocks.in).toHaveBeenCalledOnce();
    expect(mocks.in.mock.calls[0][1]).toHaveLength(200);
  });

  it("preserves only recognized SQLSTATE codes in bounded collector diagnostics", () => {
    const stats = newSweepOutcomes();
    sweepError(stats, "news", "observation", new Error("Observation persistence failed: 23514 private details"));
    sweepError(stats, "website", "completion_stamp", new Error("Website checkpoint write failed: 42501 private details"));
    expect(stats.errors).toEqual([
      { source: "news", stage: "observation", code: "storage_failure", databaseCode: "23514" },
      { source: "website", stage: "completion_stamp", code: "storage_failure", databaseCode: "42501" },
    ]);
  });
});
