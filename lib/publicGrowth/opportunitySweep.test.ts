import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ from: vi.fn(), fetchRange: vi.fn(), compact: vi.fn(), save: vi.fn(), match: vi.fn(), trigger: vi.fn(), reheat: vi.fn(), priority: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: h.from }), withServiceDeadline: (_deadline: number, operation: () => Promise<unknown>) => operation() }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: h.priority }));
vi.mock("@/lib/db/reheat", () => ({ reheatCompanyForFreshSignal: h.reheat }));
vi.mock("./samOpportunityDelivery", () => ({ verifySamDeliveryRelationship: h.verify }));
vi.mock("./samOpportunitySource", async (original) => ({ ...await original<typeof import("./samOpportunitySource")>(), fetchSamOpportunityRange: h.fetchRange, compactSamBulkRow: h.compact }));
vi.mock("./storage", async (original) => ({ ...await original<typeof import("./storage")>(), saveSamOpportunity: h.save, saveOpportunityMatch: h.match, recordPublicGrowthTrigger: h.trigger }));
import { sweepSamOpportunities } from "./opportunitySweep";
import { SAM_BULK_URL, type SamOpportunityCursor } from "./samOpportunitySource";
import { compactSamOpportunity } from "./sam";
const sourceRow = () => ({ ...compactSamOpportunity({ noticeId: "notice1", title: "A verified opportunity", type: "solicitation", naicsCode: "123456", department: "Agency", office: "Office", classificationCode: "AA", postedDate: "2026-09-15", uiLink: "https://sam.gov/opp/notice1/view" }),
  evidence: { source: "SAM public Contract Opportunities bulk CSV", noticeId: "notice1", etag: '\"source\"', lastModified: null } });
const changeNotice = (row: ReturnType<typeof sourceRow>, id: string) => ({ ...row, noticeId: id, sourceUrl: `https://sam.gov/opp/${id}/view`, evidence: { ...row.evidence, noticeId: id } });

const one = "11111111-1111-4111-8111-111111111111", two = "22222222-2222-4222-8222-222222222222";
const entityId = "33333333-3333-4333-8333-333333333333";
let currentIds: string[], removedAtWrite: boolean, awardOffice: string, verifiedName: string;
let queryCalls: Array<{ table: string; method: string; args: unknown[] }>;
let latest: SamOpportunityCursor | null;
const checkpoint = vi.fn(async (cursor: SamOpportunityCursor) => { latest = structuredClone(cursor); });
const run = (cursor?: SamOpportunityCursor | null, limit = 1000) => sweepSamOpportunities(31, 777, limit, { cursor, deadlineMs: Date.now() + 5000, checkpoint });
beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset(); checkpoint.mockReset();
  checkpoint.mockImplementation(async (cursor) => { latest = structuredClone(cursor); });
  latest = null; currentIds = [one, two]; removedAtWrite = false; awardOffice = "Office"; verifiedName = "Example"; queryCalls = [];
  h.from.mockImplementation((table: string) => {
    let single = false, exactId: string | null = null;
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "contains", "neq", "or", "eq", "order", "limit", "gt", "in", "not", "abortSignal", "maybeSingle"]) {
      chain[method] = (...args: unknown[]) => { queryCalls.push({ table, method, args }); if (method === "maybeSingle") single = true;
        if (method === "eq" && args[0] === "id") exactId = String(args[1]); return chain; };
    }
    chain.then = (resolve: (result: unknown) => unknown) => resolve({ error: null, data: table === "companies"
      ? single ? removedAtWrite ? null : { id: exactId } : currentIds.map((id) => ({ id }))
      : table === "company_government_matches" ? currentIds.map((id) => ({ id, company_id: id, government_entity_id: entityId, government_entities: { uei: "UEI", legal_name: verifiedName, dba_name: null, city: null, state: null } }))
      : [{ id: "44444444-4444-4444-8444-444444444444", government_entity_id: entityId, awarding_agency: "Agency", awarding_office: awardOffice, naics_code: "123456", psc_code: "AA", end_date: "2026-12-31" }] });
    return chain;
  });
  h.fetchRange.mockImplementation(async ({ cursor, identityScopeHash }) => ({ cursor: structuredClone(cursor ?? { version: 2, notices: [], deliveryIndex: 0, sourceUrl: SAM_BULK_URL, etag: '"source"', lastModified: null, totalBytes: 200, nextByte: 100,
    headers: ["NoticeId", "PostedDate"], cutoffDate: "2026-08-15", untilDate: "2026-09-15", scanned: 0, identityScopeHash }), rows: [{ values: ["notice1", "2026-09-15"], endByte: 200 }], bytesRead: 100 }));
  h.compact.mockReturnValue(sourceRow());
  h.save.mockResolvedValue("opportunity1"); h.match.mockResolvedValue(undefined); h.trigger.mockResolvedValue(true); h.reheat.mockResolvedValue(false); h.priority.mockResolvedValue(20); h.verify.mockResolvedValue(undefined);
});

describe("bounded SAM current-TAM notice work", () => {
  it("freezes the source before writes, checks membership at writes and acknowledges complete company actions", async () => {
    h.save.mockImplementation(async () => { expect(latest?.pendingNotice?.noticeId).toBe("notice1"); return "opportunity1"; });
    h.match.mockImplementation(async (id) => { expect(latest?.pendingNotice?.lastCompanyId).toBe(id === one ? null : one); });
    const result = await run();
    expect(result).toMatchObject({ done: true, checked: 1, scanned: 1, errors: 0, nextOffset: 777, advanceCursor: false });
    expect(result.opportunityProgress).toMatchObject({ nextByte: 200, sourceSnapshotComplete: true, pendingNotice: false });
    expect(queryCalls).toEqual(expect.arrayContaining([{ table: "companies", method: "contains", args: ["lists", ["netsuite_tam"]] },
      { table: "company_government_matches", method: "contains", args: ["companies.lists", ["netsuite_tam"]] }]));
    expect(h.match.mock.calls.map((args) => args[0])).toEqual([one, two]); expect(h.priority).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ nextByte: 200, scanned: 1 }); expect(latest?.pendingNotice).toBeUndefined();
  });
  it("does not write company evidence when a candidate leaves the current TAM", async () => {
    removedAtWrite = true; const result = await run();
    expect(result).toMatchObject({ done: false, checked: 0, errors: 1 });
    expect(result.opportunityProgress.issue).toMatch(/no longer/); expect(h.match).not.toHaveBeenCalled(); expect(h.trigger).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ nextByte: 200, pendingNotice: { lastCompanyId: null } });
  });
  it("resumes a partially committed notice at its first unacknowledged exact company", async () => {
    h.priority.mockImplementation(async (id) => { if (id === two) throw new Error("priority interrupted"); return 20; });
    const first = await run(); expect(first.done).toBe(false); expect(first.errors).toBe(1);
    expect(latest?.pendingNotice?.lastCompanyId).toBe(one); const saved = structuredClone(latest);
    h.match.mockClear(); h.trigger.mockClear(); h.trigger.mockResolvedValue(false); h.priority.mockResolvedValue(20);
    const second = await run(saved); expect(second.done).toBe(true);
    expect(h.match.mock.calls.map((args) => args[0])).toEqual([two]); expect(h.reheat).toHaveBeenLastCalledWith(two, "sam_incumbent_recompete", expect.stringContaining("stanley-signal="), "2026-09-15", { strict: true });
  });
  it("refuses matching-scope changes while a source scan is incomplete", async () => {
    const initialFetch = h.fetchRange.getMockImplementation()!;
    h.fetchRange.mockImplementationOnce(async (options) => { const result = await initialFetch(options); result.cursor.totalBytes = 300; return result; }).mockRejectedValueOnce(new Error("source interrupted"));
    await run(); const saved = structuredClone(latest); h.save.mockClear();
    for (const change of [() => { currentIds = [one]; }, () => { currentIds = [one, two]; verifiedName = "Changed"; }, () => { verifiedName = "Example"; awardOffice = "Changed"; }]) {
      change(); await expect(run(saved)).rejects.toThrow(/scope changed/);
    }
    expect(h.save).not.toHaveBeenCalled();
  });
  it("allows unrelated index changes after EOF while checking every exact frozen relationship", async () => {
    h.priority.mockRejectedValueOnce(new Error("interrupted")); await run(); const saved = structuredClone(latest);
    h.priority.mockResolvedValue(20); h.fetchRange.mockClear(); h.verify.mockClear(); queryCalls = [];
    currentIds = [one, two, "55555555-5555-4555-8555-555555555555"]; awardOffice = "Unrelated new index fact"; verifiedName = "Unrelated source refresh";
    const result = await run(saved); expect(result.done).toBe(true); expect(h.fetchRange).not.toHaveBeenCalled();
    expect(h.verify.mock.calls.map((args) => args[0])).toEqual([one, two]);
    expect(queryCalls.every((call) => call.table === "companies")).toBe(true);
  });
  it("refuses altered frozen notice content without re-reading the current daily source", async () => {
    removedAtWrite = true; await run(); const saved = structuredClone(latest)!; h.save.mockClear(); h.fetchRange.mockClear();
    saved.notices[0].row.title = "Changed after source capture";
    await expect(run(saved)).rejects.toThrow(); expect(h.save).not.toHaveBeenCalled(); expect(h.fetchRange).not.toHaveBeenCalled();
  });
  it("stops at the matched-notice limit and does not call a partial snapshot complete", async () => {
    h.fetchRange.mockImplementationOnce(async ({ identityScopeHash }) => ({ cursor: { version: 2, notices: [], deliveryIndex: 0, sourceUrl: SAM_BULK_URL, etag: '"source"', lastModified: null, totalBytes: 300, nextByte: 100,
      headers: ["NoticeId", "PostedDate"], cutoffDate: "2026-08-15", untilDate: "2026-09-15", scanned: 0, identityScopeHash }, rows: [{ values: ["one"], endByte: 200 }, { values: ["two"], endByte: 300 }], bytesRead: 200 }));
    const baseRow = h.compact();
    h.compact.mockImplementation((values) => changeNotice(baseRow, values[0]));
    const result = await run(null, 1); expect(result).toMatchObject({ checked: 1, done: false });
    expect(result.opportunityProgress).toMatchObject({ nextByte: 300, sourceSnapshotComplete: true, publicationComplete: false, deliveredNotices: 1, remainingNotices: 1 });
    expect(h.save).toHaveBeenCalledTimes(1);
    const frozen = structuredClone(latest); h.fetchRange.mockClear(); const next = await run(frozen, 1);
    expect(next.done).toBe(true); expect(h.fetchRange).not.toHaveBeenCalled();
  });
  it("performs no source writes if the initial durable checkpoint fails", async () => {
    checkpoint.mockRejectedValue(new Error("checkpoint unavailable")); const result = await run();
    expect(result.errors).toBe(1); expect(h.save).not.toHaveBeenCalled();
  });
  it("does not silently accept a fractional or unbounded matched-notice limit", async () => {
    for (const invalid of [0, 1001, 1.5]) await expect(run(null, invalid)).rejects.toThrow(/limit/);
    expect(h.from).not.toHaveBeenCalled(); expect(h.fetchRange).not.toHaveBeenCalled();
  });
  it("preserves the unacknowledged company prefix when strict reheat fails", async () => {
    h.reheat.mockRejectedValueOnce(new Error("signal reheat company update failed"));
    const result = await run(); expect(result.errors).toBe(1); expect(result.done).toBe(false);
    expect(latest?.pendingNotice?.lastCompanyId).toBeNull(); expect(h.priority).not.toHaveBeenCalled();
  });
  it("finishes an already persisted EOF boundary without re-reading or repeating source writes", async () => {
    await run(); const saved = structuredClone(latest); h.fetchRange.mockClear(); h.save.mockClear();
    const result = await run(saved); expect(result.done).toBe(true); expect(result.checked).toBe(0);
    expect(h.fetchRange).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it("admits the measured 244 MB object and keeps a larger unfinished source explicitly partial", async () => {
    h.compact.mockReturnValue(null); let total = 244_379_188;
    h.fetchRange.mockImplementation(async ({ cursor, identityScopeHash }) => {
      const active = structuredClone(cursor ?? { version: 2, notices: [], deliveryIndex: 0, sourceUrl: SAM_BULK_URL, etag: '\"source\"', lastModified: null, totalBytes: total, nextByte: 100,
        headers: ["NoticeId", "PostedDate"], cutoffDate: "2026-08-15", untilDate: "2026-09-15", scanned: 0, identityScopeHash });
      const endByte = Math.min(total, active.nextByte + 4 * 1024 * 1024);
      return { cursor: active, rows: [{ values: ["unmatched"], endByte }], bytesRead: endByte - active.nextByte };
    });
    const measured = await run(); expect(measured.done).toBe(true); expect(measured.opportunityProgress.nextByte).toBe(total);
    expect(measured.opportunityProgress.rangesRead).toBe(59); expect(h.save).not.toHaveBeenCalled();
    total = 1_000_000_000; h.fetchRange.mockClear();
    const larger = await run(); expect(larger.done).toBe(false); expect(larger.opportunityProgress.rangesRead).toBe(64);
    expect(larger.opportunityProgress.nextByte).toBeLessThan(total); expect(h.fetchRange).toHaveBeenCalledTimes(64);
  });
  it("cannot publish before source EOF and resumes a retained matched queue after source interruption", async () => {
    const defaultFetch = h.fetchRange.getMockImplementation()!; const baseRow = h.compact();
    h.compact.mockImplementation((values) => changeNotice(baseRow, values[0]));
    h.fetchRange.mockImplementationOnce(async (options) => {
      const initial = await defaultFetch(options); initial.cursor.totalBytes = 300;
      initial.rows = [{ values: ["first"], endByte: 200 }]; return initial;
    }).mockRejectedValueOnce(new Error("source range interrupted"));
    const partial = await run(); expect(partial.errors).toBe(1); expect(partial.opportunityProgress.sourceSnapshotComplete).toBe(false);
    expect(latest?.notices).toHaveLength(1); expect(h.save).not.toHaveBeenCalled();
    const saved = structuredClone(latest);
    h.fetchRange.mockImplementationOnce(async ({ cursor }) => ({ cursor, rows: [{ values: ["second"], endByte: 300 }], bytesRead: 100 }));
    const finished = await run(saved); expect(finished.done).toBe(true); expect(finished.checked).toBe(2); expect(h.save).toHaveBeenCalledTimes(2);
  });
  it("parks queue byte overflow before advancing the offending source row or publishing anything", async () => {
    h.compact.mockReturnValue({ ...h.compact(), title: "X".repeat(600_000) });
    const result = await run(); expect(result.errors).toBe(1); expect(result.opportunityProgress.issue).toMatch(/bounded entries or bytes/);
    expect(result.opportunityProgress.nextByte).toBe(100); expect(result.opportunityProgress.queueEntries).toBe(0);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("fully validates fresh final-range source evidence before any notice or company publication", async () => {
    h.compact.mockReturnValue({ ...sourceRow(), sourceUrl: "https://foreign.invalid/notice1" });
    const result = await run(); expect(result.errors).toBe(1); expect(result.opportunityProgress.nextByte).toBe(100);
    expect(result.opportunityProgress.queueEntries).toBe(0); expect(h.save).not.toHaveBeenCalled(); expect(h.match).not.toHaveBeenCalled();
  });
  it("does not acknowledge a company whose exact frozen relationship fails revalidation", async () => {
    h.verify.mockRejectedValueOnce(new Error("exact relationship changed")); const result = await run();
    expect(result.errors).toBe(1); expect(latest?.pendingNotice?.lastCompanyId).toBeNull(); expect(h.match).not.toHaveBeenCalled();
  });
});
