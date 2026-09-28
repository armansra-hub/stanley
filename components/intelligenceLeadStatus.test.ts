import { afterEach, describe, expect, it, vi } from "vitest";
import { saveIntelligenceLeadStatus, visibleIntelligenceRows } from "./intelligenceLeadStatus";

afterEach(() => vi.unstubAllGlobals());
describe("intelligence lead dismissal", () => {
  const rows = [
    { id: "source-1", company_id: "a", company_status: "new" },
    { id: "source-2", company_id: "a", company_status: "new" },
    { id: "source-3", company_id: "b", company_status: "new" },
    { id: "unlinked", company_id: null },
  ];
  it("hides every source for the dismissed company even when an old read arrives", () => {
    expect(visibleIntelligenceRows(rows, { a: "dismissed" }, false).map(row => row.id)).toEqual(["source-3", "unlinked"]);
    expect(rows).toHaveLength(4);
    expect(visibleIntelligenceRows(rows, {}, false)).toHaveLength(4); // failed save rolls back without losing sources
  });
  it("keeps hidden research restorable and applies a restore over stale hidden data", () => {
    expect(visibleIntelligenceRows(rows, { a: "dismissed" }, true).filter(row => row.company_status === "dismissed")).toHaveLength(2);
    expect(visibleIntelligenceRows([{ company_id: "a", company_status: "reviewed" }], { a: "new" }, false)).toEqual([{ company_id: "a", company_status: "new" }]);
    expect(visibleIntelligenceRows([{ company_id: "b", company_status: "exported_csv" }], {}, false)).toEqual([]);
  });
  it("saves bulk selection in one bounded write and requires an exact acknowledgement", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, count: 2, ids: ["b", "a"] })));
    vi.stubGlobal("fetch", fetcher);
    await saveIntelligenceLeadStatus(["a", "b", "a"], "dismissed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ids: ["a", "b"], status: "dismissed" });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{ ok: true, count: 2, ids: ["a", "wrong"] }, { ok: true, count: 2, ids: ["a", "a"] }, { ok: true, count: 1, ids: ["a"] }])("does not accept a partial or mismatched save receipt", async receipt => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt))));
    await expect(saveIntelligenceLeadStatus(["a", "b"], "dismissed")).rejects.toThrow("status_receipt_mismatch");
  });
  it("never automatically replays a failed write", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout")); vi.stubGlobal("fetch", fetcher);
    await expect(saveIntelligenceLeadStatus(["a"], "dismissed")).rejects.toThrow("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
