import { afterEach, describe, expect, it, vi } from "vitest";
import { compactSamBulkRow, fetchSamOpportunityRange, parseSamCsvRange, parseSamOpportunityCursor, samQueueHash, samQueuedNoticeHash, SAM_BULK_URL, SAM_RANGE_BYTES, SAM_QUEUE_MAX_BYTES, SAM_QUEUE_MAX_ENTRIES, type SamOpportunityCursor, type SamQueuedNotice } from "./samOpportunitySource";

const bytes = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
const cursor = (changes = {}): SamOpportunityCursor => ({ version: 2, sourceUrl: SAM_BULK_URL, etag: '"source-v1"', lastModified: null,
  totalBytes: 999, nextByte: 10, headers: ["NoticeId", "PostedDate"], cutoffDate: "2026-08-15", untilDate: "2026-09-15", scanned: 0,
  identityScopeHash: "a".repeat(64), notices: [], deliveryIndex: 0, ...changes });
const response = (body: Uint8Array, changes: Record<string, string | undefined> = {}, status = 206) => new Response(body.slice().buffer as ArrayBuffer, { status, headers: {
  etag: '"source-v1"', "content-range": `bytes 0-${body.length - 1}/${body.length}`, ...Object.fromEntries(Object.entries(changes).filter((entry): entry is [string, string] => entry[1] !== undefined)),
} });
afterEach(() => vi.unstubAllGlobals());

describe("SAM exact CSV source boundaries", () => {
  it("retains escaped quotes, CP1252 and embedded newlines while discarding only an incomplete final record", () => {
    const data = bytes('a,"hello\r\n\"\"friend\"\" \x80"\r\nb,"unfinished');
    expect(parseSamCsvRange(data, 50, false)).toEqual([{ values: ["a", 'hello\r\n"friend" €'], endByte: 50 + data.indexOf(98) }]);
  });
  it("finishes an EOF record and never advances at a split CRLF or quoted newline", () => {
    expect(parseSamCsvRange(bytes('a,"b"'), 100, true)).toEqual([{ values: ["a", "b"], endByte: 105 }]);
    expect(parseSamCsvRange(bytes("a,b\r"), 100, false)).toEqual([]);
    expect(parseSamCsvRange(bytes('a,"b\n'), 100, false)).toEqual([]);
  });
  it.each(['a,b\rc\n', 'a,b"c\n', 'a,"b"c\n', 'a,"b']) ("rejects malformed source %j without changing its text", (text) => {
    expect(() => parseSamCsvRange(bytes(text), 0, true)).toThrow();
  });
  it.each([{ cutoffDate: "2026-02-31" }, { untilDate: "x" }, { lastModified: 2 }, { pendingNotice: false }, { pendingNotice: [] },
    { pendingNotice: { noticeId: "N1", sourceRowHash: "a".repeat(64), candidateIdsHash: "b".repeat(64), lastCompanyId: "-".repeat(36) } }])("rejects corrupt persisted checkpoint %j", (changes) => {
    expect(() => parseSamOpportunityCursor(cursor(changes))).toThrow();
  });
  it("rejects wrong widths and invalid dates while keeping the frozen inclusive window", () => {
    expect(() => compactSamBulkRow(["N1"], cursor().headers, cursor())).toThrow(/width/);
    expect(() => compactSamBulkRow(["N1", "2026-02-31"], cursor().headers, cursor())).toThrow(/date/);
    expect(compactSamBulkRow(["N1", "2026-08-14"], cursor().headers, cursor())).toBeNull();
    expect(compactSamBulkRow(["N1", "2026-09-15"], cursor().headers, cursor())?.noticeId).toBe("N1");
  });
  it("reads the observed SetASide header and preserves the previous spelling fallback", () => {
    const fields = ["NoticeId", "PostedDate", "SetASide", "SetAside"];
    expect(compactSamBulkRow(["N1", "2026-09-15", "Actual source value", "Older spelling"], fields, cursor())?.setAside).toBe("Actual source value");
    expect(compactSamBulkRow(["N1", "2026-09-15", "", "Older spelling"], fields, cursor())?.setAside).toBe("Older spelling");
  });
});

const one = "11111111-1111-4111-8111-111111111111", two = "22222222-2222-4222-8222-222222222222";
function queued(id = "N1"): SamQueuedNotice {
  const row = compactSamBulkRow([id, "2026-09-15"], cursor().headers, cursor())!;
  const candidates: SamQueuedNotice["candidates"] = [[one, { relationship: "awardee", confidence: 1, evidence: { method: "exact", nested: { b: 2, a: 1 } } }], [two, { relationship: "incumbent_recompete", confidence: 0.92, evidence: { method: "incumbent" } }]];
  const base = { row, candidates, sourceRowHash: samQueueHash([id, "2026-09-15"]), candidateIdsHash: samQueueHash(candidates) };
  return { ...base, queueEntryHash: samQueuedNoticeHash(base) };
}
function rehash(notice: SamQueuedNotice): SamQueuedNotice {
  notice.candidateIdsHash = samQueueHash(notice.candidates); notice.queueEntryHash = samQueuedNoticeHash(notice); return notice;
}
function pending(notice: SamQueuedNotice, lastCompanyId: string | null = null) {
  return { noticeId: notice.row.noticeId, sourceRowHash: notice.sourceRowHash, candidateIdsHash: notice.candidateIdsHash, queueEntryHash: notice.queueEntryHash, lastCompanyId };
}
describe("durable SAM source queue v2", () => {
  it("accepts a bounded source queue and EOF delivery prefix without changing original evidence", () => {
    const entry = queued(), source = cursor({ notices: [entry] });
    expect(parseSamOpportunityCursor(source)).toEqual(source);
    const delivery = cursor({ notices: [entry], nextByte: 999, pendingNotice: pending(entry, one) });
    const parsed = parseSamOpportunityCursor(delivery)!;
    expect(parsed).toEqual(delivery); parsed.notices[0].row.title = "local changed copy";
    expect(delivery.notices[0].row.title).not.toBe(parsed.notices[0].row.title);
    expect(parseSamOpportunityCursor(cursor({ notices: [entry], nextByte: 999, deliveryIndex: 1 }))).not.toBeNull();
  });
  it("hashes survive JSONB-style recursive object key reordering while array order remains binding", () => {
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    const entry = queued(), source = cursor({ notices: [entry], nextByte: 999, pendingNotice: pending(entry) });
    const roundtripped = JSON.parse(JSON.stringify(reorder(source)));
    expect(parseSamOpportunityCursor(roundtripped)).toEqual(source);
    expect(samQueueHash(entry.candidates.slice().reverse())).not.toBe(entry.candidateIdsHash);
  });
  it.each([{ version: 1 }, { notices: null }, { deliveryIndex: -1 }, { deliveryIndex: 0.5 }, { deliveryIndex: 1 }])("rejects unsupported queue/cursor state %j", (changes) => {
    expect(() => parseSamOpportunityCursor(cursor(changes))).toThrow();
  });
  it("forbids delivery or a pending company before the full source EOF boundary", () => {
    const entry = queued();
    expect(() => parseSamOpportunityCursor(cursor({ notices: [entry], deliveryIndex: 1 }))).toThrow();
    expect(() => parseSamOpportunityCursor(cursor({ notices: [entry], pendingNotice: pending(entry) }))).toThrow();
  });
  it("requires pending delivery to bind the exact indexed notice, source and candidate prefix", () => {
    const entry = queued(), later = queued("N2");
    for (const bad of [{ ...pending(entry), sourceRowHash: "b".repeat(64) }, { ...pending(entry), queueEntryHash: "b".repeat(64) },
      pending(later), pending(entry, "33333333-3333-4333-8333-333333333333")]) {
      expect(() => parseSamOpportunityCursor(cursor({ nextByte: 999, notices: [entry, later], pendingNotice: bad }))).toThrow();
    }
    expect(() => parseSamOpportunityCursor(cursor({ nextByte: 999, notices: [entry], deliveryIndex: 1, pendingNotice: pending(entry) }))).toThrow();
  });
  it("detects row, source hash and candidate evidence tampering independently of key order", () => {
    for (const mutate of [(n: SamQueuedNotice) => { n.row.title = "altered"; }, (n: SamQueuedNotice) => { n.sourceRowHash = "b".repeat(64); }, (n: SamQueuedNotice) => { n.candidates[0][1].evidence.extra = true; }]) {
      const entry = queued(); mutate(entry);
      expect(() => parseSamOpportunityCursor(cursor({ notices: [entry] }))).toThrow(/hash/);
    }
  });
  it("rejects duplicate notices and unordered, duplicate or malformed candidate UUIDs", () => {
    expect(() => parseSamOpportunityCursor(cursor({ notices: [queued(), queued()] }))).toThrow();
    for (const change of [(n: SamQueuedNotice) => { n.candidates.reverse(); }, (n: SamQueuedNotice) => { n.candidates[1][0] = one; }, (n: SamQueuedNotice) => { n.candidates[0][0] = "-".repeat(36); }]) {
      const entry = queued(); change(entry); rehash(entry);
      expect(() => parseSamOpportunityCursor(cursor({ notices: [entry] }))).toThrow(/ordering/);
    }
  });
  it("rejects invalid relation/confidence and unsupported JSON values", () => {
    for (const value of [-1, 1.1, Number.NaN]) {
      const entry = queued(); entry.candidates[0][1].confidence = value;
      expect(() => parseSamOpportunityCursor(cursor({ notices: [entry] }))).toThrow();
    }
    expect(() => samQueueHash({ value: undefined })).toThrow();
    expect(() => samQueueHash({ value: Number.POSITIVE_INFINITY })).toThrow();
  });
  it("rejects malformed/off-window dates, changed source provenance and foreign or wrong-notice URLs", () => {
    for (const mutate of [(n: SamQueuedNotice) => { n.row.postedDate = "2026-02-31"; }, (n: SamQueuedNotice) => { n.row.postedDate = "2026-08-14"; },
      (n: SamQueuedNotice) => { n.row.sourceUrl = "https://example.invalid/opp/N1/view"; },
      (n: SamQueuedNotice) => { n.row.sourceUrl = "https://sam.gov/opp/OTHER/view"; },
      (n: SamQueuedNotice) => { n.row.evidence.etag = '"changed"'; }]) {
      const entry = queued(); mutate(entry); rehash(entry);
      expect(() => parseSamOpportunityCursor(cursor({ notices: [entry] }))).toThrow();
    }
    const actual = queued(); actual.row.sourceUrl = "https://sam.gov/workspace/contract/opp/N1/view"; rehash(actual);
    expect(parseSamOpportunityCursor(cursor({ notices: [actual] }))).not.toBeNull();
  });
  it("enforces both finite entry and actual UTF-8 serialized byte caps", () => {
    const oversized = queued(); oversized.row.title = "€".repeat(Math.floor(SAM_QUEUE_MAX_BYTES / 3)); rehash(oversized);
    expect(() => parseSamOpportunityCursor(cursor({ notices: [oversized] }))).toThrow(/oversized/);
    expect(() => parseSamOpportunityCursor(cursor({ notices: Array(SAM_QUEUE_MAX_ENTRIES + 1).fill(queued()) }))).toThrow(/oversized/);
  });
});

describe("SAM bounded source transport", () => {
  it("freezes headers, source, complete-byte boundary and scope; continuation requires If-Match", async () => {
    const body = bytes("NoticeId,PostedDate\r\nN1,2026-09-15\r\n");
    const fetcher = vi.fn().mockResolvedValueOnce(response(body)); vi.stubGlobal("fetch", fetcher);
    const first = await fetchSamOpportunityRange({ cursor: null, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() + 5000 });
    expect(first.cursor).toMatchObject({ etag: '"source-v1"', nextByte: 21, totalBytes: body.length, identityScopeHash: "a".repeat(64) });
    expect(first.rows).toEqual([{ values: ["N1", "2026-09-15"], endByte: body.length }]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Range: `bytes=0-${SAM_RANGE_BYTES - 1}`, "Accept-Encoding": "identity" } });
    const tail = body.slice(21);
    fetcher.mockResolvedValueOnce(response(tail, { "content-range": `bytes 21-${body.length - 1}/${body.length}` }));
    await fetchSamOpportunityRange({ cursor: first.cursor, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() + 5000 });
    expect(fetcher.mock.calls[1][1].headers["If-Match"]).toBe('"source-v1"');
  });
  it.each([{ status: 200 }, { headers: { etag: 'W/"weak"' } }, { headers: { "content-range": "bytes 1-19/20" } },
    { headers: { "content-encoding": "gzip" } }, { headers: { "content-range": "bytes 0-999/1000" } }])("rejects unsupported, changed or truncated ranges without retries %j", async ({ status, headers }) => {
    const fetcher = vi.fn().mockResolvedValue(response(bytes("NoticeId,PostedDate\n"), headers, status)); vi.stubGlobal("fetch", fetcher);
    await expect(fetchSamOpportunityRange({ cursor: null, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() + 5000 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("rejects changed ETag and changed matching scope without moving the checkpoint", async () => {
    const original = cursor(); const copy = structuredClone(original);
    const fetcher = vi.fn().mockResolvedValue(response(bytes("a,b\n"), { etag: '"v2"', "content-range": "bytes 10-13/999" })); vi.stubGlobal("fetch", fetcher);
    await expect(fetchSamOpportunityRange({ cursor: original, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() + 5000 })).rejects.toThrow(/changed/);
    await expect(fetchSamOpportunityRange({ cursor: original, days: 31, identityScopeHash: "b".repeat(64), deadlineMs: Date.now() + 5000 })).rejects.toThrow(/scope/);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(original).toEqual(copy);
  });
  it("aborts a malformed-body exit and makes zero calls after the shared deadline", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(bytes('NoticeId,PostedDate\nN1,"bad'))); vi.stubGlobal("fetch", fetcher);
    await expect(fetchSamOpportunityRange({ cursor: null, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() + 5000 })).rejects.toThrow(/quoted/);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(fetchSamOpportunityRange({ cursor: null, days: 31, identityScopeHash: "a".repeat(64), deadlineMs: Date.now() - 1 })).rejects.toThrow(/deadline/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
