import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/sources/newsEvidence", () => ({ readNewsEvidence: mocks.read }));
import { externalNewsActionSchema, prepareExternalDiscovery, importExternalDiscovery, captureExternalDiscovery } from "./externalNewsIntake";

const id = "10000000-0000-4000-8000-000000000001", companyId = "20000000-0000-4000-8000-000000000001";
const expectedIdentity = { name: "Acme", domain: "acme.com", netsuiteInternalId: "123" };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const result = { title: "Acme opens a new office", url: "https://acme.com/news/office?utm_source=feed", position: 1, date: "2 months ago" };
function input(results: unknown[] = [result], page = 0) {
  const providerRequest = JSON.stringify({ endpoint_id: "tinyfish.web.search.news", query: {
    query: '"Acme"', domain_type: "news", after_date: "2026-04-15", before_date: "2026-10-14", language: "en", page },
    headers: { "X-Treg-Route-Max-Cost": "0" } });
  const providerResponse = JSON.stringify({ isError: false, structuredContent: { status: 200, endpoint_id: "tinyfish.web.search.news", call_id: "synthetic-call",
    body: { query: '"Acme"', results, total_results: results.length, page }, error: null } });
  return externalNewsActionSchema.parse({ action: "import_discovery", requestId: id, taskId: "/root/reader", companyId,
    expectedIdentity, sourceOnly: true, lane: "news", retrievedAt: "2026-10-12T00:00:00Z", providerRequest, providerResponse,
    requestSha256: hash(providerRequest), responseSha256: hash(providerResponse) }) as Extract<ReturnType<typeof externalNewsActionSchema.parse>, { action: "import_discovery" }>;
}
function editedResponse(edit: (v: any) => void) {
  const p = input(), raw = JSON.parse(p.providerResponse); edit(raw);
  p.providerResponse = JSON.stringify(raw); p.responseSha256 = hash(p.providerResponse); return p;
}
const capture = () => externalNewsActionSchema.parse({ action: "capture_discovery_url", requestId: id, taskId: "/root/reader", companyId,
  expectedIdentity, sourceOnly: true, discoveryId: "30000000-0000-4000-8000-000000000001", position: 1 }) as Extract<ReturnType<typeof externalNewsActionSchema.parse>, { action: "capture_discovery_url" }>;
const rpcResult = (data: unknown) => ({ data, error: null });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true"); });

describe("external discovery receipt validation", () => {
  it("binds exact public bytes and preserves relative dates, page and unknown pagination without completion credit", () => {
    const p = input([result], 2), prepared = prepareExternalDiscovery(p);
    expect(prepared).toMatchObject({ outcome: "success", page: 2, pagination: "unknown", coverage: "query_page_only", analysisCompleted: false, accountCompleted: false });
    expect(prepared.items[0]).toMatchObject({ canonicalUrl: "https://acme.com/news/office", date: "2 months ago", eventDate: null });
    expect(prepared.providerResponse).toBe(p.providerResponse);
    expect(prepareExternalDiscovery({ ...p, lane: "oracle_partnership" }).queryHash).not.toBe(prepared.queryHash);
  });
  it("retains successful empty pages without claiming query exhaustion", () => {
    expect(prepareExternalDiscovery(input([]))).toMatchObject({ outcome: "empty", items: [], pagination: "unknown", accountCompleted: false });
  });
  it("rejects mismatched bytes, response/query/page binding, provider failures and duplicate positions before persistence", async () => {
    const bad = [ { ...input(), responseSha256: "0".repeat(64) },
      editedResponse(r => { r.structuredContent.body.query = "another company"; }),
      editedResponse(r => { r.structuredContent.body.page = 1; }),
      editedResponse(r => { r.structuredContent.status = 503; }),
      editedResponse(r => { r.isError = true; }),
      editedResponse(r => { r.structuredContent.error = "provider failure"; }), input([result, result]) ];
    for (const p of bad) await expect(importExternalDiscovery(p)).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects private/gateway URLs, credentials, future receipt time, invalid windows and unsupported mutations", () => {
    for (const url of ["http://127.0.0.1/private", "http://169.254.169.254/", "https://user:pass@acme.com/"]) {
      expect(() => prepareExternalDiscovery(input([{ ...result, url }]))).toThrow();
    }
    for (const url of ["https://news.google.com/rss/articles/token", "https://news.google.com./rss/articles/token", "https://www.bing.com/news"]) {
      expect(prepareExternalDiscovery(input([{ ...result, url }]))).toMatchObject({ outcome: "success", capturableResultCount: 0,
        items: [{ url, captureEligible: false, captureHoldReason: "direct_original_url_required" }] });
    }
    const p = input(); p.providerRequest = JSON.stringify({ ...JSON.parse(p.providerRequest), headers: { Authorization: "never-accepted" } });
    p.requestSha256 = hash(p.providerRequest); expect(() => prepareExternalDiscovery(p)).toThrow("credential_field_rejected");
    expect(() => prepareExternalDiscovery(input(), Date.parse("2026-10-11"))).toThrow("external_query_date_invalid");
    expect(() => externalNewsActionSchema.parse({ ...input(), sourceOnly: false })).toThrow();
    expect(() => externalNewsActionSchema.parse({ ...input(), publish: true })).toThrow();
  });
});

describe("source-only intake and uncertain write recovery", () => {
  it("imports and exact-readbacks with no HTTP/model call, and compares objects independent of key order", async () => {
    mocks.rpc.mockResolvedValueOnce(rpcResult({ state: "imported", sourceCount: 1 })).mockResolvedValueOnce(rpcResult({ sourceCount: 1, state: "imported" }));
    await expect(importExternalDiscovery(input())).resolves.toEqual({ sourceCount: 1, state: "imported" });
    expect(mocks.rpc.mock.calls.map(c => c[1].p_action)).toEqual(["import", "status"]);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("never retries an uncertain import or capture admission", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "lost response" } });
    await expect(importExternalDiscovery(input())).rejects.toThrow("external_news_intake_unconfirmed");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.rpc.mockClear(); await expect(captureExternalDiscovery(capture())).rejects.toThrow("external_news_intake_unconfirmed");
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("returns existing uncertain/native/held capture operations without another fetch", async () => {
    for (const state of ["capturing", "reused", "held", "captured"]) {
      mocks.rpc.mockResolvedValue(rpcResult({ fetch: false, operation: { state } }));
      await expect(captureExternalDiscovery(capture())).resolves.toEqual({ state });
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("uses fenced direct-original fetch, passes complete text/date provenance to atomic finish, and does not publish", async () => {
    const company = { id: companyId, name: "Acme", domain: "acme.com", netsuite_internal_id: "123", subindustry: null };
    mocks.rpc.mockResolvedValueOnce(rpcResult({ fetch: true, operation: { state: "capturing" }, company, item: { ...result, canonicalUrl: result.url, itemSha256: "a".repeat(64) }, lease: "lease" }))
      .mockResolvedValueOnce(rpcResult({ state: "captured" })).mockResolvedValueOnce(rpcResult({ state: "captured" }));
    mocks.read.mockResolvedValue({ bodyAvailable: true, sourceUrl: "https://acme.com/news/office", title: result.title,
      text: "Complete official article. ".repeat(30), metadata: { articleBodyAvailable: true, evidenceKind: "article_body", textTruncated: false,
        sourceDates: [{ kind: "published", value: "2026-09-12T00:00:00.000Z", source: "article:published_time" }] } });
    await captureExternalDiscovery(capture());
    expect(mocks.read.mock.calls[0][1]).toMatchObject({ directOnly: true });
    const finish = mocks.rpc.mock.calls[1][1];
    expect(finish.p_action).toBe("finish_capture");
    expect(finish.p_payload.observation).toMatchObject({ eventDate: "2026-09-12T00:00:00.000Z", metadata: { sourceOnly: true, eventDateBasis: "page_publication", providerRawDate: "2 months ago", externalCaptureId: id } });
    expect(finish.p_payload.observation.metadata.sourceDates).toHaveLength(1);
    expect(mocks.rpc.mock.calls.map(c => c[1].p_action)).toEqual(["begin_capture", "finish_capture", "status"]);
  });
  it("finishes incomplete source as an explicit hold without a headline observation", async () => {
    mocks.rpc.mockResolvedValueOnce(rpcResult({ fetch: true, operation: {}, company: { id: companyId, name: "Acme" }, item: { canonicalUrl: "https://acme.com/news", title: "News" }, lease: "lease" }))
      .mockResolvedValueOnce(rpcResult({ state: "held" })).mockResolvedValueOnce(rpcResult({ state: "held" }));
    mocks.read.mockResolvedValue({ bodyAvailable: false, text: "Headline only", metadata: {} });
    await captureExternalDiscovery(capture());
    expect(mocks.rpc.mock.calls[1][1].p_payload).toMatchObject({ observation: null, failure: "original_unavailable" });
  });
  it.each([[], [{ kind: "modified", value: "2026-09-01T00:00:00Z" }],
    [{ kind: "published", value: "2026-09-01T00:00:00Z" }, { kind: "published", value: "2026-09-02T00:00:00Z" }],
    [{ kind: "published", value: "2099-09-01T00:00:00Z" }]])("does not manufacture an event date from missing/conflicting/modified/future original metadata (%j)", async (...sourceDates) => {
    // it.each spreads each row; preserve the source-date objects as an array.
    mocks.rpc.mockResolvedValueOnce(rpcResult({ fetch: true, operation: {}, company: { id: companyId, name: "Acme" }, item: { canonicalUrl: "https://acme.com/news", title: "News", date: "yesterday" }, lease: "lease" }))
      .mockResolvedValueOnce(rpcResult({ state: "captured" })).mockResolvedValueOnce(rpcResult({ state: "captured" }));
    mocks.read.mockResolvedValue({ bodyAvailable: true, title: "News", sourceUrl: "https://acme.com/news", text: "Complete dated original. ".repeat(30),
      metadata: { sourceDates, articleBodyAvailable: true, evidenceKind: "article_body", textTruncated: false } });
    await captureExternalDiscovery(capture());
    expect(mocks.rpc.mock.calls[1][1].p_payload.observation).toMatchObject({ eventDate: null, metadata: { eventDateBasis: "unknown", providerRawDate: "yesterday" } });
  });
});
