import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: true, scan: [] as Record<string, unknown>[], sources: [] as Record<string, unknown>[],
  companies: [] as Record<string, unknown>[], jobs: [] as Record<string, unknown>[], counts: {} as Record<string, number | null>,
  error: "", calls: [] as { table: string; method: string; args: unknown[] }[] }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: () => m.auth, unauthorized: () => new Response("{}", { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: (table: string) => {
  const chain: Record<string, unknown> = {}; let fields = "";
  for (const method of ["select", "or", "in", "is", "eq", "gt", "lte", "order", "limit"]) chain[method] = (...args: unknown[]) => {
    if (method === "select") fields = args[0] as string;
    m.calls.push({ table, method, args }); return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) => {
    const key = table === "companies" ? "companies" : table === "intelligence_jobs" ? "jobs" : fields === "id,company_id,observed_at" ? "scan" : "sources";
    const data = key === "jobs" && fields === "id" ? m.jobs.filter(j => j.codex_review === null && !j.codex_json_null).map(j => ({ id: j.id })) : m[key];
    return Promise.resolve({ data, count: Object.hasOwn(m.counts, key) ? m.counts[key] : data.length,
      error: m.error === key ? { message: "PRIVATE_DATABASE_ERROR" } : null }).then(resolve);
  }; return chain;
} }) }));
import * as route from "./route";
import { parseReadySourceQuery, readyTimestamp } from "@/lib/intelligence/readySourceCoverage";
import { prepareObservation } from "@/lib/intelligence/observations";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const observed = "2026-10-13T10:00:00.123456+00:00";
const query = "view=ready-sources&observedThrough=2026-10-13T11:00:00Z&eventStart=2026-04-15T00:00:00Z";
const request = (extra = "") => new Request(`https://stanley.test/api/agent/intelligence/coverage?${query}${extra}`);
function seed(n = 1) {
  m.scan = []; m.sources = []; m.jobs = []; m.companies = [];
  for (let i = 1; i <= n; i++) {
    const row = { id: id(i), company_id: id(500 + i), observed_at: observed };
    m.scan.push(row);
    m.sources.push({ ...row, source_kind: "news", source_url: `https://example.com/${i}`, title: "Company announces new facility",
      evidence_text: "PRIVATE_ORIGINAL_TEXT", content_hash: "a".repeat(64), event_date: "2026-10-12T09:00:00Z",
      is_current: true, feedback_excluded: false, attributes: null, interpreted_at: null,
      metadata: { articleBodyAvailable: true, evidenceKind: "article_body", eventDateBasis: "feed_publication", textTruncated: false,
        sourceDates: [{ kind: "published", value: "2026-10-12T09:00:00Z", source: "publisher" }], private: "PRIVATE_METADATA" } });
    m.companies.push({ id: row.company_id, name: `Company ${i}`, domain: "example.com", lists: ["netsuite_tam"], status: "new", tal_claimed: false });
    m.jobs.push({ id: id(1000 + i), observation_id: row.id, kind: "interpret", status: "queued", attempts: 0,
      due_at: "2026-10-13T10:00:00Z", lease_token: null, lease_until: null, codex_news_request_id: null, pending_request: null, codex_review: null });
  }
}
function seedAts(atsType = "ashby", date: string | null = "2026-10-12") {
  const prepared = prepareObservation({ companyId: id(501), companyName: "Company 1", sourceKind: "job",
    sourceUrl: "https://jobs.ashbyhq.com/example/finance", title: "Finance Controller", text: "A😀B",
    eventDate: date, observedAt: observed, metadata: { atsType, atsToken: "PRIVATE_BOARD_TOKEN", atsJobKey: "job-key",
      bodySchemaValidated: true, bodySchemaVersion: "ats-body-schema-v1", descriptionAvailable: true,
      jobDateKind: atsType === "greenhouse" ? "updated" : "published_or_created", listingChange: "first_observed", isClientPlacement: false } });
  Object.assign(m.sources[0], { source_kind: "job", evidence_text: prepared.text, event_date: prepared.eventDate, metadata: prepared.metadata });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  m.auth = true; m.calls = []; m.error = ""; m.counts = {}; seed();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider calls permitted"); }));
});

describe("ready retained source metadata", () => {
  it("authenticates before reads and remains GET-only with no providers or writes", async () => {
    m.auth = false; expect((await route.GET(request())).status).toBe(401); expect(m.calls).toEqual([]);
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"].sort()); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["&limit=13", "&limit=0", "&limit=01", "&scope=other", "&after=" + id(1), "&companyId=" + id(1),
    "&token=SECRET", "&view=ready-sources", "&cursorId=" + id(1), "&cursorObservedAt=" + observed,
    "&cursorObservedAt=2026-10-13T10:00:00Z&cursorId=bad", "&excludeObservationIds=", "&excludeObservationIds=bad",
    `&excludeObservationIds=${id(1)},${id(1)}`, "&cursorObservedAt=2026-10-13T11:00:00.000000001Z&cursorId=" + id(1)])("rejects malformed query %s before data access", async extra => {
    expect((await route.GET(request(extra))).status).toBe(400); expect(m.calls).toEqual([]);
  });
  it.each(["", "2026-02-30T00:00:00Z", "2026-10-13T24:00:00Z", "2026-10-13", "2026-10-13T11:00:00-07:00", "2026-10-14T11:00:00Z", "2026-10-13T11:00:00Z,evil"]) ("validates ceiling %s strictly", async value => {
    const url = new URL(request().url); url.searchParams.set("observedThrough", value);
    expect((await route.GET(new Request(url))).status).toBe(400); expect(m.calls).toEqual([]);
  });
  it("requires both dates and rejects reversed windows and excessive/duplicate exclusions", () => {
    for (const suffix of ["observedThrough=2026-10-13T11:00:00Z", "eventStart=2026-04-15T00:00:00Z", "observedThrough=2026-10-13T11:00:00Z&eventStart=2026-10-13T12:00:00Z"]) {
      expect(() => parseReadySourceQuery(new URLSearchParams(`view=ready-sources&${suffix}`))).toThrow();
    }
    expect(() => parseReadySourceQuery(new URLSearchParams(`${query}&excludeObservationIds=${Array.from({ length: 257 }, (_, i) => id(i)).join(",")}`))).toThrow();
    expect(parseReadySourceQuery(new URLSearchParams(`${query}&excludeObservationIds=${Array.from({ length: 256 }, (_, i) => id(i)).join(",")}`)).excludeObservationIds).toHaveLength(256);
    expect(readyTimestamp("2026-10-13T10:00:00.123456Z") - readyTimestamp("2026-10-13T10:00:00.123455+00:00")).toBe(1000n);
  });
  it("scans scalar IDs first, uses only exact bounded downstream IDs, and returns metadata without admission", async () => {
    const response = await route.GET(request()), body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ view: "ready-sources", admissionVerified: false, coverageVerified: false, bodyReturned: false,
      page: { scanLimit: 256, scannedCount: 1, eligibleInWindow: 1, partial: true, hasOlder: null, repeatWindow: false, nextCursor: { observedAt: observed, id: id(1) } } });
    expect(body.rows[0]).toMatchObject({ observationId: id(1), jobId: id(1001), retainedTextCharacters: 21, admissionVerified: false });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|lease_token|pending_request|codex_review|evidence_text/);
    expect(m.calls[0]).toEqual({ table: "intelligence_observations", method: "select", args: ["id,company_id,observed_at"] });
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "limit", args: [257] });
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "in", args: ["observation_id", [id(1)]] });
    expect(m.calls.filter(c => c.method === "select")).toHaveLength(5); expect(fetch).not.toHaveBeenCalled();
    expect(m.calls).toContainEqual({ table: "intelligence_jobs", method: "is", args: ["result->codexNews", null] });
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "in", args: ["source_kind", ["news", "website"]] });
  });
  it.each(["news", "website", "job"])("applies the explicit %s family before the bounded scalar scan", async sourceKind => {
    m.scan = [];
    const body = await (await route.GET(request(`&sourceKind=${sourceKind}`))).json();
    expect(body.sourceKind).toBe(sourceKind); expect(body.page.cursorSourceKind).toBe(sourceKind);
    const filter = m.calls.findIndex(c => c.method === "in" && c.args[0] === "source_kind");
    expect(m.calls[filter].args[1]).toEqual([sourceKind]);
    expect(filter).toBeLessThan(m.calls.findIndex(c => c.method === "limit"));
  });
  it.each(["&sourceKind=government", "&sourceKind=", "&sourceKind=news,job", "&sourceKind=job&sourceKind=job",
    `&sourceKind=job&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}`,
    `&sourceKind=job&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}&cursorSourceKind=website`,
    `&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}&cursorSourceKind=job`,
    `&sourceKind=news&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}&cursorSourceKind=news+website`,
    "&cursorSourceKind=job"])("rejects invalid family or mismatched/unbound filtered cursor %s", async extra => {
    expect((await route.GET(request(extra))).status).toBe(400); expect(m.calls).toEqual([]);
  });
  it("binds filtered continuations, including repeated overflow, while preserving legacy cursors", async () => {
    seedAts();
    const first = await (await route.GET(request("&sourceKind=job"))).json();
    expect(first.page.nextCursor).toEqual({ observedAt: observed, id: id(1), sourceKind: "job" });
    m.scan[0].id = id(2); m.sources[0].id = id(2); m.jobs[0].observation_id = id(2);
    const cursor = `&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}&cursorSourceKind=job`;
    expect((await route.GET(request(`&sourceKind=job${cursor}`))).status).toBe(200);
    expect((await route.GET(request(`&sourceKind=website${cursor}`))).status).toBe(400);
    expect((await route.GET(request(cursor))).status).toBe(400);
    seed(2); m.sources.forEach(s => Object.assign(s, { source_kind: "website", evidence_text: "A", metadata: {
      textTruncated: false, sourceCharacters: 1, retainedCharacters: 1, meaningfulContentHash: "a".repeat(64),
      eventDateBasis: "page_publication", discovery: { collector: "website" } } }));
    const overflow = await (await route.GET(request("&sourceKind=website&limit=1"))).json();
    expect(overflow.page).toMatchObject({ repeatWindow: true, nextCursor: null, cursorSourceKind: "website" });
    expect(overflow.unreturnedEligible).toHaveLength(1);
    seed(); m.scan[0].id = id(2); m.sources[0].id = id(2); m.jobs[0].observation_id = id(2);
    const legacy = await (await route.GET(request(`&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}`))).json();
    expect(legacy.page.nextCursor).toEqual({ observedAt: observed, id: id(2) });
  });
  it.each(["greenhouse", "lever", "ashby", "smartrecruiters", "recruitee", "workable"])("reuses complete ATS %s bodies and preserves provider date meaning", async atsType => {
    seedAts(atsType);
    // The collector's prepareObservation normalizes a date-only provider value to UTC, not first-seen.
    expect(m.sources[0].event_date).toBe("2026-10-12T00:00:00.000Z");
    m.sources[0].event_date = "2026-10-12T00:00:00+00:00"; // persisted timestamptz representation
    const body = await (await route.GET(request("&sourceKind=job"))).json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ sourceKind: "job", eventDate: "2026-10-12T00:00:00+00:00", retainedTextCharacters: 4,
      provenance: { eventDateBasis: null, jobDateKind: atsType === "greenhouse" ? "updated" : "published_or_created",
        listingChange: "first_observed", isClientPlacement: false } });
    expect(body.rows[0].provenance.jobDateMeaning).toMatch(/provider.*not.*publication.*hire/i);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|atsToken|evidence_text/);
    expect(body.admissionVerified).toBe(false); expect(body.coverageVerified).toBe(false);
  });
  it.each([{ bodySchemaValidated: false }, { bodySchemaVersion: "old" }, { descriptionAvailable: false },
    { atsJobKey: "" }, { atsToken: "" }, { atsType: "unknown" }, { textTruncated: true }, { sourceTruncated: true },
    { retainedCharacters: 3 }, { sourceCharacters: 5 }, { jobDateKind: "first_seen" }, { jobDateKind: null },
    { jobDateKind: "updated" }, { discovery: { collector: "website" } }])("does not admit incomplete or unproven ATS metadata %j", async change => {
    seedAts(); Object.assign(m.sources[0].metadata as object, change);
    const body = await (await route.GET(request("&sourceKind=job"))).json();
    expect(body.rows).toEqual([]); expect(body.scanned[0].failedGates).toContain("completeSource");
    expect(body.coverageVerified).toBe(false);
  });
  it("leaves missing provider dates ineligible despite recent first-seen and never relabels them", async () => {
    seedAts("ashby", null);
    expect(m.sources[0].event_date).toBeNull();
    const body = await (await route.GET(request("&sourceKind=job"))).json();
    expect(body.rows).toEqual([]); expect(body.scanned[0].failedGates).toContain("sourceDateInWindow");
    expect(body.coverageVerified).toBe(false);
  });
  it("does not silently accept a different returned source family and keeps ATS canonical job/membership gates", async () => {
    expect((await (await route.GET(request("&sourceKind=website"))).json()).unresolvedObservationIds).toEqual([id(1)]);
    seedAts();
    Object.assign(m.companies[0], { status: "removed_from_tam", lists: [], tal_claimed: true });
    expect((await (await route.GET(request("&sourceKind=job"))).json()).rows).toHaveLength(1);
    m.jobs[0].status = "complete";
    expect((await (await route.GET(request("&sourceKind=job"))).json()).scanned[0].failedGates).toContain("queued");
    m.jobs[0].status = "queued"; m.jobs[0].pending_request = { requestId: "PRIVATE_PENDING" };
    expect((await (await route.GET(request("&sourceKind=job"))).json()).scanned[0].failedGates).toContain("noPendingRequest");
    m.jobs[0].pending_request = null; m.jobs[0].codex_review = { held: true };
    expect((await (await route.GET(request("&sourceKind=job"))).json()).scanned[0].failedGates).toContain("noCodexReview");
  });
  it("does not echo nested malicious metadata through scalar provenance fields", async () => {
    const meta = m.sources[0].metadata as Record<string, unknown>, secret = { token: "HIDDEN_NESTED_SECRET" };
    Object.assign(meta, { textTruncated: secret, sourceTruncated: secret, sourceCharacters: secret, retainedCharacters: secret,
      sourceDates: [{ kind: secret, value: secret, source: secret }], discovery: { url: secret, title: secret, collector: secret, eventDate: secret } });
    const body = await (await route.GET(request())).json();
    expect(body.rows).toHaveLength(1); expect(JSON.stringify(body)).not.toMatch(/HIDDEN|token/);
    expect(body.rows[0].provenance).toMatchObject({ textTruncated: null, sourceTruncated: null, sourceCharacters: null, retainedCharacters: null,
      sourceDates: [{ kind: null, value: null, source: null }], discovery: { url: null, title: null, collector: null, eventDate: null } });
  });
  it("retains claimed TAL after TAM removal, while missing membership cannot qualify", async () => {
    Object.assign(m.companies[0], { lists: ["tam_removed"], status: "removed_from_tam", tal_claimed: true });
    expect((await (await route.GET(request())).json()).rows).toHaveLength(1);
    m.companies = [];
    const body = await (await route.GET(request())).json(); expect(body.rows).toEqual([]); expect(body.scanned[0].failedGates).toContain("companyInScope");
  });
  it.each([{ lists: ["netsuite_tam", "tam_duplicate"], tal_claimed: true }, { lists: [], tal_claimed: false },
    { lists: ["netsuite_tam"], status: "removed_from_tam", tal_claimed: false }])("fails closed on an out-of-scope company returned despite the query filter", async change => {
    Object.assign(m.companies[0], change); expect((await route.GET(request())).status).toBe(503);
  });
  it.each([
    ["status", "complete", "queued"], ["status", "running", "queued"], ["attempts", 1, "unattempted"],
    ["lease_token", "PRIVATE_LEASE", "unleased"], ["lease_until", "2026-10-13T13:00:00Z", "unleased"],
    ["codex_news_request_id", id(19), "unclaimed"], ["pending_request", { requestId: "PRIVATE_PENDING" }, "noPendingRequest"],
    ["codex_review", { hold: "PRIVATE_HOLD" }, "noCodexReview"], ["due_at", "2026-10-14T00:00:00Z", "due"],
  ])("excludes canonical job blocker %s", async (field, value, gate) => {
    m.jobs[0][field as string] = value;
    const body = await (await route.GET(request())).json(); expect(body.rows).toEqual([]); expect(body.scanned[0].failedGates).toContain(gate);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_/);
  });
  it("excludes known local IDs, terminal interpretations, feedback and ambiguous/missing jobs", async () => {
    expect((await (await route.GET(request(`&excludeObservationIds=${id(1)}`))).json()).scanned[0].failedGates).toContain("notExcluded");
    Object.assign(m.sources[0], { attributes: { foo: 1 }, interpreted_at: observed, feedback_excluded: true });
    m.jobs.push({ ...m.jobs[0], id: id(1002), status: "complete" });
    const body = await (await route.GET(request())).json(); expect(body.rows).toEqual([]);
    expect(body.scanned[0].failedGates).toEqual(expect.arrayContaining(["notInterpreted", "feedbackClear", "oneInterpretJob"]));
    m.jobs = []; expect((await (await route.GET(request())).json()).scanned[0].failedGates).toContain("oneInterpretJob");
  });
  it("does not treat an explicit JSON null codexNews key as SQL NULL/absent", async () => {
    m.jobs[0].codex_json_null = true;
    const body = await (await route.GET(request())).json(); expect(body.rows).toEqual([]);
    expect(body.scanned[0].failedGates).toContain("noCodexReview");
  });
  it.each([{ articleBodyAvailable: false }, { evidenceKind: "headline_only" }, { textTruncated: true }, { sourceTruncated: true }, { eventDateBasis: "observed_at" }])("rejects incomplete or undated news %j", async meta => {
    Object.assign(m.sources[0].metadata as object, meta); expect((await (await route.GET(request())).json()).scanned[0].failedGates).toContain("completeSource");
  });
  it("validates website collector/hash/exact UTF16 length, not just nonempty text or publication time", async () => {
    Object.assign(m.sources[0], { source_kind: "website", evidence_text: "A😀B", metadata: { textTruncated: false, sourceTruncated: false,
      sourceCharacters: 4, retainedCharacters: 4, eventDateBasis: "page_publication", discovery: { collector: "website" }, meaningfulContentHash: "a".repeat(64) } });
    expect((await (await route.GET(request())).json()).rows).toHaveLength(1);
    (m.sources[0].metadata as Record<string, unknown>).retainedCharacters = 3;
    expect((await (await route.GET(request())).json()).scanned[0].failedGates).toContain("completeSource");
    m.sources[0].event_date = "2021-01-01T00:00:00Z";
    expect((await (await route.GET(request())).json()).scanned[0].failedGates).toContain("sourceDateInWindow");
  });
  it("retains every eligible overflow pointer and repeats the exact window before advancing", async () => {
    seed(14); m.sources[0].title = "Routine advice";
    const body = await (await route.GET(request())).json();
    expect(body.rows).toHaveLength(12); expect(body.rows[0].observationId).toBe(id(2));
    expect(body.unreturnedEligible).toEqual([{ observationId: id(14), jobId: id(1014) }, { observationId: id(1), jobId: id(1001) }]);
    expect(body.page).toMatchObject({ partial: true, repeatWindow: true, nextCursor: null, inputCursor: null, eligibleInWindow: 14 });
    const second = await (await route.GET(request(`&excludeObservationIds=${body.rows.map((r: { observationId: string }) => r.observationId).join(",")}`))).json();
    expect(second.rows).toHaveLength(2); expect(second.page.repeatWindow).toBe(false);
  });
  it("bounds details to256 and advances a deterministic microsecond timestamp/id cursor only after the window is drained", async () => {
    seed(257); m.sources.pop(); m.jobs.pop(); m.companies.pop();
    const excluded = m.scan.slice(0, 256).map(r => r.id).join(",");
    const body = await (await route.GET(request(`&excludeObservationIds=${excluded}`))).json();
    expect(body.scanned).toHaveLength(256); expect(body.page.nextCursor).toEqual({ observedAt: observed, id: id(256) });
    expect(body.page.hasOlder).toBe(true); expect(m.calls.find(c => c.table === "intelligence_jobs" && c.method === "in")?.args[1]).toHaveLength(256);
    seed(); m.scan[0].id = id(257); m.sources[0].id = id(257); m.jobs[0].observation_id = id(257);
    const next = await route.GET(request(`&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(256)}`)); expect(next.status).toBe(200);
    expect(m.calls).toContainEqual({ table: "intelligence_observations", method: "or", args: [`observed_at.lt.${observed},and(observed_at.eq.${observed},id.gt.${id(256)})`] });
  });
  it("marks missing or changed exact source rows unresolved and does not advance over them", async () => {
    m.sources = [];
    const body = await (await route.GET(request())).json(); expect(body.unresolvedObservationIds).toEqual([id(1)]);
    expect(body.page).toMatchObject({ partial: true, repeatWindow: true, nextCursor: null }); expect(body.rows).toEqual([]);
    seed(); m.sources[0].observed_at = "2026-10-13T10:00:00.123457Z";
    expect((await (await route.GET(request())).json()).unresolvedObservationIds).toEqual([id(1)]);
    seed(); m.sources[0].is_current = false;
    expect((await (await route.GET(request())).json()).unresolvedObservationIds).toEqual([id(1)]);
  });
  it("continues after a short backend page and closes the frontier only on an empty scalar read", async () => {
    const first = await (await route.GET(request())).json();
    expect(first.page).toMatchObject({ hasOlder: null, partial: true, nextCursor: { observedAt: observed, id: id(1) } });
    m.scan[0].id = id(2); m.sources[0].id = id(2); m.jobs[0].observation_id = id(2);
    const second = await (await route.GET(request(`&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}`))).json();
    expect(second.rows[0].observationId).toBe(id(2));
    m.scan = []; m.calls = [];
    const empty = await (await route.GET(request(`&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(2)}`))).json();
    expect(empty.page).toMatchObject({ partial: false, hasOlder: false, nextCursor: null }); expect(empty.coverageVerified).toBe(false);
    expect(m.calls.every(c => c.table === "intelligence_observations")).toBe(true);
  });
  it.each(["scan", "sources", "companies", "jobs"])("returns unavailable on a failed %s read without negatives or raw errors", async key => {
    m.error = key; const response = await route.GET(request()); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_DATABASE_ERROR");
  });
  it.each(["sources", "companies", "jobs"])("rejects truncated %s reads and duplicate/extraneous bindings", async key => {
    m.counts[key] = 2; expect((await route.GET(request())).status).toBe(503);
    m.counts = {}; const list = m[key as "sources" | "companies" | "jobs"]; list.push({ ...list[0] });
    expect((await route.GET(request())).status).toBe(503);
    list.pop(); list[0].id = id(9999);
    if (key === "jobs") list[0].observation_id = id(9999);
    expect((await route.GET(request())).status).toBe(503);
  });
  it("rejects duplicate, misordered, beyond-ceiling and cursor-repeated scalar IDs", async () => {
    seed(2); m.scan.reverse(); expect((await route.GET(request())).status).toBe(503);
    seed(2); m.scan[1] = { ...m.scan[0] }; expect((await route.GET(request())).status).toBe(503);
    seed(); m.scan[0].observed_at = "2026-10-13T11:00:00.000001Z"; expect((await route.GET(request())).status).toBe(503);
    seed(); expect((await route.GET(request(`&cursorObservedAt=${encodeURIComponent(observed)}&cursorId=${id(1)}`))).status).toBe(503);
  });
});
