import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/sources/newsEvidence", () => ({ readNewsEvidence: mocks.fetch }));
import { externalNewsActionSchema, prepareRetainedHttpArticle, importRetainedHttpArticle } from "./externalNewsIntake";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const article = "Acme has completed its new warehouse in Portland. The expansion provides additional cold storage for its customers. ".repeat(4);
const html = (meta = '<meta property="article:published_time" content="2026-10-12T03:33:00Z">', text = article) =>
  `<!DOCTYPE html><html><head><title>Acme expansion complete</title>${meta}</head><body><main><h1>Expansion complete</h1><p>${text}</p></main></body></html>`;
function raw(bytes: Buffer = Buffer.from(html())) {
  return { action: "import_retained_http", requestId: "10000000-0000-4000-8000-000000000001", taskId: "/root/actual-reader",
    companyId: "20000000-0000-4000-8000-000000000001", expectedIdentity: { name: "Acme", domain: "acme.com", netsuiteInternalId: "123" },
    sourceOnly: true, observationId: "30000000-0000-4000-8000-000000000001", expectedContentHash: "a".repeat(64),
    receipt: { sourceKind: "retained_http", attestorTaskId: "/root/actual-reader", requestedUrl: "https://acme.com/news/warehouse",
      finalUrl: "https://acme.com/news/warehouse", fetchedAt: "2026-10-14T00:49:35.552Z", status: 200, redirectCount: 0,
      completeResponse: true, headers: { "content-type": "text/html; charset=UTF-8" },
      bodyBase64: bytes.toString("base64"), bodyBytes: bytes.length, bodySha256: sha(bytes) } };
}
function input(value = raw()) {
  return externalNewsActionSchema.parse(value) as Extract<ReturnType<typeof externalNewsActionSchema.parse>, { action: "import_retained_http" }>;
}
const now = Date.parse("2026-10-15T00:00:00Z");
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true"); });
describe("saved public HTTP article intake", () => {
  it("retains exact bytes/attestor, uses actual fetch time and server-extracted dates/sections, and is deterministic", () => {
    const p = input(), a = prepareRetainedHttpArticle(p, now), b = prepareRetainedHttpArticle(p, now + 86400000);
    expect(a).toEqual(b);
    expect(a.receipt.bodyBase64).toBe(p.receipt.bodyBase64);
    expect(a.observation).toMatchObject({ observedAt: p.receipt.fetchedAt, eventDate: "2026-10-12T03:33:00.000Z",
      metadata: { articleBodyAvailable: true, textTruncated: false, eventDateBasis: "page_publication", sourceOnly: true,
        retainedHttp: { sourceKind: "retained_http", networkIndependentlyVerified: false, attestorTaskId: p.taskId, bodySha256: p.receipt.bodySha256 } } });
    expect(a.observation.sections.map(s => s.text).join("")).toBe(a.observation.text);
    expect(a.observation.metadata).not.toHaveProperty("retainedHttp.bodyBase64");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves a complete HTML response with trailing cache comments, without treating the cache date as publication", () => {
    const body = html() + "\n<!-- Cached by public cache; Last modified: October 13, 2026 -->\n";
    const p = prepareRetainedHttpArticle(input(raw(Buffer.from(body))), now);
    expect(p.receipt.bodyBase64).toBe(Buffer.from(body).toString("base64"));
    expect(p.observation.eventDate).toBe("2026-10-12T03:33:00.000Z");
    expect(p.observation.text).not.toContain("Cached by");
    expect(() => prepareRetainedHttpArticle(input(raw(Buffer.from(html().replace("</html>", "") + "<!-- cache -->"))), now)).toThrow();
  });
  it.each(["", '<meta property="article:modified_time" content="2026-10-12">',
    '<meta property="article:published_time" content="2026-10-12"><meta property="article:published_time" content="2026-10-11">',
    '<meta property="article:published_time" content="2026-10-15">'])("keeps missing/conflicting/modified/after-fetch dates unknown (%s)", meta => {
    expect(prepareRetainedHttpArticle(input(raw(Buffer.from(html(meta)))), now).observation).toMatchObject({ eventDate: null, metadata: { eventDateBasis: "unknown" } });
  });
  it("rejects corrupt bytes, invalid UTF-8, nulls and unpaired surrogates without replacement", () => {
    for (const patch of [{ bodyBytes: 1 }, { bodySha256: "0".repeat(64) }, { bodyBase64: raw().receipt.bodyBase64 + "\n" }]) {
      const p = input(); Object.assign(p.receipt, patch); expect(() => prepareRetainedHttpArticle(p, now)).toThrow("byte_binding");
    }
    expect(() => prepareRetainedHttpArticle(input(raw(Buffer.from([0xc3, 0x28]))), now)).toThrow("malformed_utf8");
    expect(() => prepareRetainedHttpArticle(input(raw(Buffer.from(html("", article + "\0")))), now)).toThrow("malformed_text");
    const p = input(); p.expectedIdentity.name = "invalid\uD800"; expect(() => prepareRetainedHttpArticle(p, now)).toThrow("malformed_text");
    const valid = prepareRetainedHttpArticle(input(raw(Buffer.from(html("", article + " 😀 ")))), now);
    expect(valid.observation.text).toContain("😀");
  });
  it("rejects unsafe/gateway/redirect URLs, wrong actor, future fetch, non-UTF8 and blocked/partial/oversize HTML", () => {
    for (const url of ["http://127.0.0.1/article", "https://user:secret@acme.com/article", "https://news.google.com/article"]) {
      const p = input(); p.receipt.requestedUrl = p.receipt.finalUrl = url; expect(() => prepareRetainedHttpArticle(p, now)).toThrow();
    }
    for (const patch of [{ finalUrl: "https://acme.com/another" }, { attestorTaskId: "/root/other" }, { fetchedAt: "2026-10-16T00:00:00Z" },
      { headers: { "content-type": "text/html; charset=windows-1252" } }]) {
      const p = input(); Object.assign(p.receipt, patch); expect(() => prepareRetainedHttpArticle(p, now)).toThrow();
    }
    for (const body of [html().replace("</html>", ""), html().replace("Acme expansion complete", "Access denied"), html("", "Short teaser"), html("", "body ".repeat(6000))]) {
      expect(() => prepareRetainedHttpArticle(input(raw(Buffer.from(body))), now)).toThrow();
    }
  });
  it("strictly rejects credentials, asserted extracts/dates, redirects and incomplete transport receipts", () => {
    const p = raw();
    for (const v of [{ ...p, eventDate: "2026-10-12" }, { ...p, text: article }, { ...p, sourceOnly: false },
      { ...p, receipt: { ...p.receipt, status: 403 } }, { ...p, receipt: { ...p.receipt, redirectCount: 1 } },
      { ...p, receipt: { ...p.receipt, completeResponse: false } },
      { ...p, receipt: { ...p.receipt, headers: { ...p.receipt.headers, authorization: "secret" } } }]) {
      expect(() => externalNewsActionSchema.parse(v)).toThrow();
    }
  });
  it("imports once then exact-readbacks; uncertainty never retries and never invokes HTTP", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      mocks.rpc.mockResolvedValue({ data: { state: "captured", analysisCompleted: false }, error: null });
      await expect(importRetainedHttpArticle(input())).resolves.toMatchObject({ state: "captured", analysisCompleted: false });
      expect(mocks.rpc.mock.calls.map(c => c[1].p_action)).toEqual(["import_retained_http", "status"]);
      mocks.rpc.mockClear(); mocks.rpc.mockResolvedValue({ data: null, error: { code: "lost" } });
      await expect(importRetainedHttpArticle(input())).rejects.toThrow("unconfirmed");
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      mocks.rpc.mockReset(); mocks.rpc.mockResolvedValueOnce({ data: { state: "captured" }, error: null }).mockResolvedValueOnce({ data: null, error: null });
      await expect(importRetainedHttpArticle(input())).rejects.toThrow("readback_unconfirmed");
      expect(mocks.rpc).toHaveBeenCalledTimes(2); expect(mocks.fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
