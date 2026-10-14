import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkCompanyNews, sweepBase } from "./sweep";
import { sourceProjection } from "@/lib/intelligence/manualCoverage";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), checked: vi.fn(), news: vi.fn(), write: vi.fn(), read: vi.fn(), executive: vi.fn(), body: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue, intelligenceEnabled: () => true }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: mocks.read, writeSourceState: mocks.write }));
vi.mock("@/lib/sources/googleNews", () => ({ fetchNewsForCompanyResult: mocks.news, fetchNewsItemsResult: mocks.executive }));
vi.mock("@/lib/sources/newsEvidence", () => ({ readNewsEvidence: mocks.body }));
vi.mock("@/lib/db/triggers", () => ({ pickForRotation: mocks.pick, markChecked: mocks.checked, recordTrigger: vi.fn(), recomputePriority: vi.fn(), setErpFlags: vi.fn(), queueCandidate: vi.fn(), headlineCandidateSeen: vi.fn() }));
vi.mock("@/lib/db/companies", () => ({ normalizeCompanyName: (name: string) => name.toLowerCase() }));
vi.mock("@/lib/db/settings", () => ({ claimClassifierCall: vi.fn() }));
vi.mock("@/lib/triggers/config", () => ({ classifyHeadline: vi.fn() }));
vi.mock("@/lib/triggers/classify", () => ({ classifyEventLLM: vi.fn(), HEADLINE_CLASSIFIER_BATCH_BUDGET_MS: 30_000 }));
vi.mock("@/lib/apify/run", () => ({ runActor: vi.fn() }));

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.read.mockResolvedValue({ cursor: null });
  mocks.checked.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.executive.mockResolvedValue({ items: [], status: "empty" });
  mocks.enqueue.mockResolvedValue({ id: "saved-observation" });
  mocks.body.mockImplementation(async item => ({ bodyAvailable: true, sourceUrl: item.source_url, title: item.raw_excerpt,
    text: "Retained public article body", eventDate: item.signal_date, metadata: {} }));
});
afterEach(() => vi.restoreAllMocks());

it("attempts every reserved company in order while bounding news company concurrency to four", async () => {
  // Use the real rotation generator, including its exact final remainder.
  const companies = Array.from({ length: 30 }, (_, index) => ({ id: `account-${index}`, name: `Company ${index}` }));
  const attempted: string[] = [];
  let cursor = 0, active = 0, peak = 0;
  mocks.pick.mockImplementation(async (size: number) => {
    const rows = companies.slice(cursor, cursor + size);
    cursor += rows.length;
    return rows;
  });
  mocks.news.mockImplementation(async (company: { id: string }) => {
    attempted.push(company.id);
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return { items: [], status: "empty" };
  });
  mocks.checked.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);

  expect(await sweepBase(30)).toMatchObject({ checked: 30, attempted: 30, succeeded: 30, failed: 0 });
  expect(peak).toBe(4);
  expect(attempted).toEqual(companies.map(company => company.id));
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [2, 0]]);
  expect(mocks.checked.mock.calls.flatMap(([ids]) => ids)).toEqual(attempted);
});

function finiteFixture(count = 100) {
  const companies = Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`, name: `Acme Logistics ${i}`, domain: "acme.com", claimable: true, record_dead: false,
  }));
  let cursor = 0;
  mocks.pick.mockImplementation(async (size: number) => {
    const rows = companies.slice(cursor, cursor + size); cursor += rows.length; return rows;
  });
  return { companies, collection: { companyIds: companies.map(c => c.id), runCutoff: "2026-01-01T00:00:00Z" } };
}
const unavailable = { items: [], status: "unavailable", error: "http_error", httpStatus: 503,
  queries: [1, 2].map(() => ({ query: "private retrieval text", status: "unavailable", error: "http_error", httpStatus: 503 })) };

it.each([false, true])("propagates bounded failure diagnostics through existing source, scheduled and finite receipts (finite=%s)", async finite => {
  const { collection } = finiteFixture(3);
  const diagnostic = { schema: "google-news-http-error-v1", bodyPrefixSha256: "a".repeat(64), bodyPrefixBytes: 80, bodyComplete: true,
    readStop: "end", category: "service_unavailable", encoding: "identity", mediaType: "text/html", retryAfterSeconds: 30, retryAfterDate: null };
  const requestContext = { attempts: 2, conditionalFirstRequest: false, unretained304Recovery: true };
  const queries = [{ status: "empty", httpStatus: 200 }, { query: "private query", status: "unavailable", error: "http_error", httpStatus: 503, errorDiagnostics: diagnostic, requestContext }];
  mocks.news.mockResolvedValue({ items: [], status: "empty", partial: true, error: "http_error", httpStatus: 200, queries });
  const result = await sweepBase(3, { sourceOnly: true, ...(finite ? { collection } : {}) });
  expect(result).toMatchObject({ attempted: finite ? 2 : 3, partial: finite ? 2 : 3, succeeded: 0 });
  expect(mocks.news).toHaveBeenCalledTimes(finite ? 2 : 3);
  expect(mocks.executive).toHaveBeenCalledTimes(finite ? 0 : 3);
  const state = mocks.write.mock.calls[0][2];
  expect(state.details.queries).toEqual(queries);
  expect(result.errors[0]).toMatchObject({ source: "news", stage: "feed", code: "source_failure", httpDiagnostics: [
    { ordinal: 2, httpStatus: 503, errorDiagnostics: diagnostic, requestContext },
  ] });
  expect(JSON.stringify(result)).not.toContain("private query");
  if (finite) expect(result.finiteNewsControl).toMatchObject({ feedFailureCompanies: 2, feedUnavailableCompanies: 0, circuitReason: "systemic_feed_unavailable",
    affectedFeeds: [{ queries: [{ httpStatus: 200 }, { httpStatus: 503, errorDiagnostics: diagnostic, requestContext }] }, expect.anything()] });
  // The retained source projection revalidates every field, not merely a trusted TS type.
  const hostile = { ...diagnostic, rawBody: "secret-body", cookie: "secret-cookie", mediaType: { secret: true }, retryAfterDate: "secret-date" };
  const projected = sourceProjection({ source_key: "news:google", error_details: { ...state.details, queries: [
    { ...queries[1], errorDiagnostics: hostile, requestContext: { ...requestContext, token: "secret-token" } },
    { ...queries[1], errorDiagnostics: { ...diagnostic, bodyPrefixSha256: "secret-invalid" }, requestContext: { attempts: 99, conditionalFirstRequest: "secret" } },
  ] } });
  const json = JSON.stringify(projected);
  expect(json).not.toMatch(/secret|private query|rawBody|cookie|token/);
  expect(projected).toMatchObject({ newsDiagnostics: { queries: [
    { errorDiagnostics: { ...diagnostic, mediaType: null }, requestContext }, { ordinal: 2 },
  ] } });
});

it.each([undefined, "oracle_partnership"] as const)("stops finite %s before a third reservation and preserves all exact unattempted IDs", async topic => {
  const { collection } = finiteFixture();
  mocks.news.mockResolvedValue(unavailable);
  // Stored prior evidence does not turn current all-query failure into success.
  mocks.read.mockResolvedValue({ cursor: { seen: ["retained-original"], pending: [], retries: {} } });
  const result = await sweepBase(100, { sourceOnly: true, collection, ...(topic ? { topic } : {}) });
  expect(result).toMatchObject({ checked: 2, attempted: 2, unavailable: 2, succeeded: 0,
    finiteNewsControl: { companyConcurrency: 1, feedUnavailableCompanies: 2, feedFailureCompanies: 2, circuitThreshold: 2, stoppedBeforeNextReservation: true, circuitReason: "systemic_feed_unavailable" } });
  expect(mocks.pick.mock.calls).toEqual(Array.from({ length: 2 }, () => topic ? [1, 0, collection, topic] : [1, 0, collection]));
  expect(result.collection).toEqual({ runCutoff: collection.runCutoff, requestedCompanyIds: collection.companyIds,
    outcomes: collection.companyIds.map((companyId, index) => index < 2
      ? { companyId, admission: "attempted", collectorOutcome: "unavailable" }
      : { companyId, admission: "not_reserved", reason: "unknown" }),
    coverage: "reservation_and_collector_outcomes_only", analysisCompleted: false });
  expect(mocks.news).toHaveBeenCalledTimes(2); expect(mocks.executive).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledTimes(2);
  for (const [, sourceKey, value] of mocks.write.mock.calls) {
    expect(sourceKey).toBe(topic ? "news:oracle_partnership" : "news:google");
    expect(value).toMatchObject({ complete: false, status: "partial", cursor: { seen: ["retained-original"] }, details: { feedStatus: "unavailable", queries: unavailable.queries } });
  }
  expect(mocks.checked.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  expect(result.finiteNewsControl?.affectedFeeds).toHaveLength(2);
  expect(JSON.stringify(result.finiteNewsControl)).not.toContain("private retrieval text");
});

it.each([200, 401, 403, 429])("stops finite mode after the first access-limited query (%s), including mixed feed availability", async httpStatus => {
  const { collection } = finiteFixture();
  mocks.news.mockResolvedValue({ items: [], status: "empty", partial: true, error: "blocked", httpStatus: 200,
    queries: [{ status: "empty", httpStatus: 200 }, { status: "unavailable", error: "blocked", httpStatus }] });
  const result = await sweepBase(100, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 1, partial: 1, succeeded: 0,
    finiteNewsControl: { feedUnavailableCompanies: 0, circuitReason: "access_limited", stoppedBeforeNextReservation: true,
      affectedFeeds: [{ queries: [{ status: "empty", errorCode: null, httpStatus: 200 }, { status: "unavailable", errorCode: "blocked", httpStatus }] }] } });
  expect(mocks.pick).toHaveBeenCalledOnce(); expect(mocks.news).toHaveBeenCalledOnce(); expect(mocks.executive).not.toHaveBeenCalled();
  expect(result.collection?.outcomes.filter(row => row.admission === "not_reserved")).toHaveLength(99);
});

const accessDiagnostic = { schema: "google-news-http-error-v1", bodyPrefixSha256: "a".repeat(64), bodyPrefixBytes: 1103,
  bodyComplete: true, readStop: "end", category: "unusual_traffic", encoding: "identity", mediaType: "text/html",
  retryAfterSeconds: null, retryAfterDate: null };

it.each(["unusual_traffic", "human_verification", "access_denied", "rate_limited"])("finishes only the current scheduled group on a validated503 %s restriction", async category => {
  const { companies } = finiteFixture(12);
  const attempted: string[] = [];
  const settled: string[] = [];
  let active = 0, peak = 0;
  let release: () => void = () => {};
  const remaining = new Promise<void>(resolve => { release = resolve; });
  const diagnostic = { ...accessDiagnostic, category };
  const queries = unavailable.queries.map(query => ({ ...query, errorDiagnostics: diagnostic }));
  mocks.news.mockImplementation(async (company: { id: string }) => {
    attempted.push(company.id); peak = Math.max(peak, ++active);
    if (company.id === companies[0].id) { release(); }
    else await remaining;
    active--; settled.push(company.id);
    return { ...unavailable, queries };
  });
  const result = await sweepBase(12);
  expect(result).toMatchObject({ checked: 4, attempted: 4, unavailable: 4, succeeded: 0,
    finiteNewsControl: { companyConcurrency: 4, circuitThreshold: null, feedFailureCompanies: 4,
      feedUnavailableCompanies: 4, circuitReason: "access_limited", stoppedBeforeNextReservation: true } });
  expect(peak).toBeGreaterThan(1);
  expect(attempted).toEqual(companies.slice(0, 4).map(c => c.id));
  expect(settled).toHaveLength(4);
  expect(mocks.pick.mock.calls).toEqual([[4, 0]]);
  expect(mocks.executive).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledTimes(4);
  expect(mocks.checked.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  expect(result).not.toHaveProperty("collection");
  expect(result.finiteNewsControl?.affectedFeeds).toHaveLength(4);
  expect(result.errors[0].httpDiagnostics?.[0]).toMatchObject({ httpStatus: 503, errorDiagnostics: diagnostic });
});

it("preserves every deferred scheduled article and retry while finishing successful in-flight peers truthfully", async () => {
  const { companies } = finiteFixture(8);
  const pending = Array.from({ length: 55 }, (_, index) => ({ source_name: "Google News", source_url: `https://example.com/pending-${index}`,
    raw_excerpt: `Acme Logistics retained announcement ${index}`, signal_date: new Date().toISOString() }));
  const fresh = { ...pending[0], source_url: "https://example.com/new-article" };
  const retries = { retained: { attempts: 3, after: "2026-12-01T00:00:00Z" } };
  mocks.read.mockImplementation(async (id, key) => id === companies[0].id && key === "news:google"
    ? { cursor: { pending, retries, seen: ["prior-original"] } } : { cursor: null });
  mocks.news.mockImplementation(async company => company.id === companies[0].id
    ? { items: [pending[0], fresh], status: "success", partial: true, error: "http_error", httpStatus: 200,
      queries: [{ status: "success", httpStatus: 200 }, { status: "unavailable", error: "http_error", httpStatus: 503, errorDiagnostics: accessDiagnostic }] }
    : { items: [], status: "empty", queries: [{ status: "empty", httpStatus: 200 }] });
  const result = await sweepBase(8);
  expect(result).toMatchObject({ attempted: 4, succeeded: 3, partial: 1, unavailable: 0,
    finiteNewsControl: { companyConcurrency: 4, feedFailureCompanies: 1, circuitReason: "access_limited", stoppedBeforeNextReservation: true } });
  expect(mocks.pick.mock.calls).toEqual([[4, 0]]);
  expect(mocks.write).toHaveBeenCalledWith(companies[0].id, "news:google", expect.objectContaining({ complete: false, status: "partial",
    cursor: expect.objectContaining({ pending: [...pending, fresh], retries, seen: ["prior-original"] }),
    details: expect.objectContaining({ saved: 0, bodyCount: 0, articleCaptureDeferred: true, deferredArticleCount: 56 }) }));
  expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.executive).toHaveBeenCalledTimes(3);
  expect(mocks.checked.mock.calls.flatMap(([ids]) => ids)).toEqual(companies.slice(1, 4).map(c => c.id));
});

it.each([undefined, { ...accessDiagnostic, category: "service_unavailable" }, { ...accessDiagnostic, category: "unknown" },
  { ...accessDiagnostic, bodyPrefixSha256: "invalid" }])("does not broaden the scheduled stop to generic503 or malformed diagnostics (%j)", async errorDiagnostics => {
  finiteFixture(8);
  mocks.news.mockResolvedValue({ ...unavailable, queries: unavailable.queries.map(query => ({ ...query, errorDiagnostics })) });
  const result = await sweepBase(8);
  expect(result).toMatchObject({ checked: 8, attempted: 8, unavailable: 8 });
  expect(result).not.toHaveProperty("finiteNewsControl");
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0]]);
  expect(mocks.executive).toHaveBeenCalledTimes(8);
  expect(mocks.write.mock.calls.every(([, , state]) => state.details.articleCaptureDeferred === undefined)).toBe(true);
});

it("reports earlier scheduled failures accurately when a later group encounters an access restriction", async () => {
  const { companies } = finiteFixture(12);
  mocks.news.mockImplementation(async company => companies.findIndex(c => c.id === company.id) < 4 ? unavailable
    : { ...unavailable, queries: unavailable.queries.map(query => ({ ...query, errorDiagnostics: accessDiagnostic })) });
  const result = await sweepBase(12);
  expect(result).toMatchObject({ checked: 8, attempted: 8, unavailable: 8,
    finiteNewsControl: { companyConcurrency: 4, circuitThreshold: null, feedFailureCompanies: 8,
      feedUnavailableCompanies: 8, circuitReason: "access_limited", stoppedBeforeNextReservation: true } });
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0]]);
  expect(mocks.executive).toHaveBeenCalledTimes(4);
  expect(result.finiteNewsControl?.affectedFeeds.map(row => row.companyId)).toEqual(companies.slice(0, 8).map(c => c.id));
});

it.each(["unusual_traffic", "human_verification", "access_denied", "rate_limited"])("stops after the first finite503 %s restriction and preserves deferred evidence", async category => {
  const { collection } = finiteFixture();
  const pending = [{ source_name: "Google News", source_url: "https://example.com/retained-article",
    raw_excerpt: "Acme Logistics retained announcement", signal_date: new Date().toISOString() }];
  const retries = { retained: { attempts: 2, after: "2026-12-01T00:00:00Z" } };
  mocks.read.mockResolvedValue({ cursor: { pending, retries, seen: ["prior-original"] } });
  const diagnostic = { ...accessDiagnostic, category };
  const requestContext = { attempts: 1, conditionalFirstRequest: false, unretained304Recovery: false };
  const queries = unavailable.queries.map(query => ({ ...query, errorDiagnostics: diagnostic, requestContext }));
  mocks.news.mockResolvedValue({ ...unavailable, queries });
  const result = await sweepBase(100, { sourceOnly: true, collection, topic: "oracle_partnership" });
  expect(result).toMatchObject({ attempted: 1, unavailable: 1, succeeded: 0,
    finiteNewsControl: { companyConcurrency: 1, feedUnavailableCompanies: 1, feedFailureCompanies: 1,
      circuitThreshold: 2, circuitReason: "access_limited", stoppedBeforeNextReservation: true,
      affectedFeeds: [{ queries: queries.map(() => ({ status: "unavailable", errorCode: "http_error", httpStatus: 503, errorDiagnostics: diagnostic, requestContext })) }] } });
  expect(mocks.pick.mock.calls).toEqual([[1, 0, collection, "oracle_partnership"]]);
  expect(mocks.news).toHaveBeenCalledTimes(1);
  expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.executive).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith(collection.companyIds[0], "news:oracle_partnership", expect.objectContaining({ complete: false,
    cursor: expect.objectContaining({ pending, retries, seen: ["prior-original"] }),
    details: expect.objectContaining({ queries, saved: 0, bodyCount: 0, articleCaptureDeferred: true, deferredArticleCount: 1 }) }));
  expect(result.collection?.outcomes.filter(row => row.admission === "not_reserved")).toHaveLength(99);
  expect(result.errors[0].httpDiagnostics?.[0]).toMatchObject({ httpStatus: 503, errorDiagnostics: diagnostic, requestContext });
});

it("recognizes a mixed200/503 diagnostic restriction without losing new or retained articles", async () => {
  const { collection } = finiteFixture();
  const item = { source_name: "Google News", source_url: "https://example.com/new-article", raw_excerpt: "Acme Logistics announcement", signal_date: new Date().toISOString() };
  mocks.news.mockResolvedValue({ items: [item], status: "success", partial: true, error: "http_error", httpStatus: 200,
    queries: [{ status: "success", httpStatus: 200 }, { status: "unavailable", error: "http_error", httpStatus: 503, errorDiagnostics: accessDiagnostic }] });
  const result = await sweepBase(100, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 1, partial: 1, finiteNewsControl: { feedUnavailableCompanies: 0, feedFailureCompanies: 1, circuitReason: "access_limited" } });
  expect(mocks.pick).toHaveBeenCalledTimes(1); expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.executive).not.toHaveBeenCalled();
  expect(mocks.write.mock.calls[0][2]).toMatchObject({ cursor: { pending: [item] }, details: { articleCaptureDeferred: true, deferredArticleCount: 1 } });
});

it.each([
  undefined, { ...accessDiagnostic, category: "service_unavailable" }, { ...accessDiagnostic, category: "unrecognized" },
  { ...accessDiagnostic, category: "untrusted-new-category" }, { ...accessDiagnostic, schema: "untrusted" },
  { ...accessDiagnostic, bodyPrefixSha256: "invalid" }, { ...accessDiagnostic, bodyPrefixBytes: "1103" },
  { ...accessDiagnostic, bodyComplete: false },
])("retains the two-company fallback for generic503 or invalid access diagnostics (%j)", async errorDiagnostics => {
  const { collection } = finiteFixture();
  mocks.news.mockResolvedValue({ ...unavailable, queries: unavailable.queries.map(query => ({ ...query, errorDiagnostics })) });
  const result = await sweepBase(100, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 2, unavailable: 2,
    finiteNewsControl: { feedFailureCompanies: 2, circuitReason: "systemic_feed_unavailable", stoppedBeforeNextReservation: true } });
  expect(mocks.pick).toHaveBeenCalledTimes(2); expect(mocks.news).toHaveBeenCalledTimes(2);
  expect(result.collection?.outcomes.filter(row => row.admission === "not_reserved")).toHaveLength(98);
});

it("does not trust restriction metadata on successful200/304 results", async () => {
  const { collection } = finiteFixture(3);
  mocks.news.mockResolvedValue({ items: [], status: "empty", queries: [200, 304].map(httpStatus => ({ status: "empty", httpStatus, errorDiagnostics: accessDiagnostic })) });
  const result = await sweepBase(3, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 3, succeeded: 3, finiteNewsControl: { feedFailureCompanies: 0, circuitReason: null, stoppedBeforeNextReservation: false } });
  expect(mocks.news).toHaveBeenCalledTimes(3); expect(mocks.executive).toHaveBeenCalledTimes(3);
});

it("defers all48 retained and24 new articles on access limits without fetching, losing debt, or advancing body retries", async () => {
  const { collection, companies } = finiteFixture();
  const items = Array.from({ length: 72 }, (_, index) => ({ source_name: "Google News", source_url: `https://news.google.com/rss/articles/article-${index}`,
    raw_excerpt: `Acme Logistics announcement ${index}`, signal_date: new Date(Date.now() - 1000).toISOString() }));
  const key = (item: typeof items[number]) => createHash("sha256").update(JSON.stringify([item.source_url, item.raw_excerpt, item.signal_date])).digest("hex");
  const pending = items.slice(0, 48), fresh = items.slice(48);
  const retries = { [key(pending[0])]: { attempts: 2, after: new Date(Date.now() - 1000).toISOString() },
    [key(fresh[0])]: { attempts: 3, after: new Date(Date.now() + 86_400_000).toISOString() } };
  mocks.read.mockResolvedValue({ cursor: { pending, retries, seen: ["prior-complete-original"] } });
  mocks.news.mockResolvedValue({ items: [pending[0], ...fresh], status: "success", partial: true, error: "blocked", httpStatus: 200,
    queries: [{ status: "success", httpStatus: 200 }, { status: "unavailable", error: "blocked", httpStatus: 429 }] });
  const result = await sweepBase(100, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 1, partial: 1, finiteNewsControl: { circuitReason: "access_limited" } });
  expect(result.collection?.outcomes.filter(row => row.admission === "not_reserved")).toHaveLength(99);
  expect(mocks.body).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.executive).not.toHaveBeenCalled();
  const deferred = mocks.write.mock.calls[0][2];
  expect(deferred).toMatchObject({ complete: false, status: "partial", cursor: { pending: items, retries, seen: ["prior-complete-original"] },
    details: { saved: 0, bodyCount: 0, storageFailures: 0, processingFailures: 0, warningCodes: {}, articleCaptureDeferred: true, deferredArticleCount: 72 } });
  // A later ordinary pass keeps the same processing window and carries every
  // unprocessed overflow item/retry. Success in that window is not completion.
  mocks.read.mockResolvedValue({ cursor: deferred.cursor });
  mocks.news.mockResolvedValue({ items: [], status: "empty" });
  mocks.write.mockClear();
  await checkCompanyNews(companies[0], { sourceOnly: true });
  expect(mocks.body.mock.calls.map(([item]) => item)).toEqual(pending);
  expect(mocks.enqueue).toHaveBeenCalledTimes(48);
  expect(mocks.write).toHaveBeenCalledWith(companies[0].id, "news:google", expect.objectContaining({ complete: false, status: "partial",
    cursor: expect.objectContaining({ pending: fresh, retries: { [key(fresh[0])]: retries[key(fresh[0])] } }),
    details: expect.objectContaining({ saved: 48, bodyCount: 48 }) }));
});

it.each([undefined, "oracle_partnership"] as const)("stops finite %s after two mixed-query failures without executive fetches or lost captures", async topic => {
  const { collection } = finiteFixture();
  const item = { source_name: "Google News", source_url: "https://example.com/recent-announcement",
    raw_excerpt: "Acme Logistics announcement", signal_date: new Date(Date.now() - 1000).toISOString() };
  const queries = [{ status: "success", httpStatus: 200 }, { status: "unavailable", error: "http_error", httpStatus: 503 }];
  mocks.news.mockResolvedValue({ items: [item], status: "success", partial: true, error: "http_error", httpStatus: 200, queries });
  const result = await sweepBase(100, { sourceOnly: true, collection, ...(topic ? { topic } : {}) });
  expect(result).toMatchObject({ attempted: 2, partial: 2, succeeded: 0, unavailable: 0,
    finiteNewsControl: { feedUnavailableCompanies: 0, feedFailureCompanies: 2, circuitReason: "systemic_feed_unavailable", stoppedBeforeNextReservation: true,
      affectedFeeds: [0, 1].map(i => ({ companyId: collection.companyIds[i], status: "success", queries: [
        { status: "success", errorCode: null, httpStatus: 200 }, { status: "unavailable", errorCode: "http_error", httpStatus: 503 },
      ] })) } });
  expect(mocks.pick.mock.calls).toEqual(Array.from({ length: 2 }, () => topic ? [1, 0, collection, topic] : [1, 0, collection]));
  expect(mocks.news).toHaveBeenCalledTimes(2); expect(mocks.executive).not.toHaveBeenCalled();
  expect(mocks.body).toHaveBeenCalledTimes(2); expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  for (const [, , state] of mocks.write.mock.calls) expect(state).toMatchObject({ complete: false, status: "partial", details: { saved: 1, bodyCount: 1, queries } });
  expect(result.collection).toEqual({ runCutoff: collection.runCutoff, requestedCompanyIds: collection.companyIds,
    outcomes: collection.companyIds.map((companyId, i) => i < 2
      ? { companyId, admission: "attempted", collectorOutcome: "partial" }
      : { companyId, admission: "not_reserved", reason: "unknown" }),
    coverage: "reservation_and_collector_outcomes_only", analysisCompleted: false });
});

it("allows quiet empty feeds while bounding finite concurrency to one company", async () => {
  const { collection } = finiteFixture(6);
  let active = 0, peak = 0;
  mocks.news.mockImplementation(async () => {
    peak = Math.max(peak, ++active); await Promise.resolve(); active--;
    return { items: [], status: "empty", queries: [{ status: "empty", httpStatus: 304 }] };
  });
  const result = await sweepBase(6, { sourceOnly: true, collection });
  expect(peak).toBe(1); expect(result).toMatchObject({ attempted: 6, succeeded: 6, finiteNewsControl: { feedUnavailableCompanies: 0, feedFailureCompanies: 0, circuitReason: null, stoppedBeforeNextReservation: false } });
  expect(mocks.executive).toHaveBeenCalledTimes(6);
  expect(result.collection?.outcomes.every(row => row.admission === "attempted")).toBe(true);
});

it.each([undefined, []])("uses aggregate unavailable when paired query details are absent (%s)", async queries => {
  const { collection } = finiteFixture();
  mocks.news.mockResolvedValue({ items: [], status: "unavailable", error: "timeout", queries });
  const result = await sweepBase(100, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 2, unavailable: 2, finiteNewsControl: {
    feedUnavailableCompanies: 2, feedFailureCompanies: 2, circuitReason: "systemic_feed_unavailable",
    affectedFeeds: [0, 1].map(i => ({ companyId: collection.companyIds[i], queryCount: queries?.length ?? null, queries: [] })),
  } });
  expect(mocks.pick).toHaveBeenCalledTimes(2); expect(mocks.executive).not.toHaveBeenCalled();
  expect(result.collection?.outcomes.filter(row => row.admission === "not_reserved")).toHaveLength(98);
});

it.each([undefined, [{ status: "success", httpStatus: 200 }]])("preserves article-only pending debt without counting it as a feed failure (%s)", async queries => {
  const { collection } = finiteFixture(3);
  const item = { source_name: "Google News", source_url: "https://example.com/pending-original",
    raw_excerpt: "Acme Logistics announcement", signal_date: new Date(Date.now() - 1000).toISOString() };
  mocks.news.mockResolvedValue({ items: [item], status: "success", queries });
  mocks.body.mockResolvedValue({ bodyAvailable: false, sourceUrl: item.source_url, title: item.raw_excerpt,
    text: item.raw_excerpt, eventDate: item.signal_date, error: "timeout", metadata: {} });
  const result = await sweepBase(3, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 3, partial: 3, finiteNewsControl: {
    feedUnavailableCompanies: 0, feedFailureCompanies: 0, circuitReason: null, affectedFeeds: [],
  } });
  expect(mocks.executive).toHaveBeenCalledTimes(3); expect(mocks.body).toHaveBeenCalledTimes(3);
  for (const [, , state] of mocks.write.mock.calls) expect(state).toMatchObject({ complete: false, status: "partial",
    cursor: { pending: [item] }, details: { feedStatus: "success", saved: 1, headlineOnly: 1, bodyCount: 0, warningCodes: { timeout: 1 } } });
});

it("does not misclassify unavailable storage as confirmed feed failure or alter scheduled failure behavior", async () => {
  const { collection } = finiteFixture(3);
  mocks.read.mockRejectedValue(new Error("Source state read failed: database_error"));
  const result = await sweepBase(3, { sourceOnly: true, collection });
  expect(result).toMatchObject({ attempted: 3, failed: 3, finiteNewsControl: { feedUnavailableCompanies: 0, circuitReason: null } });
  expect(mocks.news).not.toHaveBeenCalled();
  mocks.read.mockResolvedValue({ cursor: null }); mocks.pick.mockClear(); mocks.executive.mockClear(); finiteFixture(8);
  mocks.news.mockResolvedValue(unavailable);
  const scheduled = await sweepBase(8, { sourceOnly: true });
  expect(scheduled).toMatchObject({ attempted: 8, unavailable: 8 });
  expect(scheduled).not.toHaveProperty("finiteNewsControl");
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0]]);
  expect(mocks.executive).toHaveBeenCalledTimes(8);
  mocks.pick.mockClear(); mocks.executive.mockClear(); finiteFixture(8);
  mocks.news.mockResolvedValue({ items: [], status: "empty", partial: true, error: "timeout",
    queries: [{ status: "empty", httpStatus: 200 }, { status: "unavailable", error: "timeout" }] });
  const mixedScheduled = await sweepBase(8, { sourceOnly: true });
  expect(mixedScheduled).toMatchObject({ attempted: 8, partial: 8 });
  expect(mixedScheduled).not.toHaveProperty("finiteNewsControl");
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0]]);
  expect(mocks.executive).toHaveBeenCalledTimes(8);
});
