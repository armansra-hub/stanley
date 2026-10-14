import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mock.request }));
import { fetchPublicHttpText } from "./urlSafety";

const url = "https://news.google.com/rss/search?q=Acme";
const resolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
let status: number, headers: Record<string, string>, chunks: Buffer[], mode: "end" | "error" | "stall", headerDelay: number;
beforeEach(() => {
  status = 503; headers = { "content-type": "text/html; charset=UTF-8", "retry-after": "60", "set-cookie": "secret-cookie", authorization: "Bearer secret" };
  chunks = [Buffer.from("<html>Service unavailable. secret-user@example.com</html>")]; mode = "end"; headerDelay = 0;
  mock.request.mockReset();
  mock.request.mockImplementation((_url, _options, onResponse) => {
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    request.destroy = error => { if (error) request.emit("error", error); };
    request.end = () => {
      const deliver = () => {
        const response = new EventEmitter() as EventEmitter & { headers: unknown; statusCode: number; destroy(): void };
        response.headers = headers; response.statusCode = status;
        let destroyed = false;
        response.destroy = () => { destroyed = true; response.emit("close"); };
        onResponse(response);
        for (const chunk of chunks) if (!destroyed) response.emit("data", chunk);
        if (!destroyed && mode !== "stall") response.emit(mode === "end" ? "end" : "error", new Error("secret stream failure"));
      };
      if (headerDelay) setTimeout(deliver, headerDelay); else queueMicrotask(deliver);
    };
    return request;
  });
});
afterEach(() => vi.useRealTimers());

describe("Google RSS bounded failure diagnostics", () => {
  it("retains only a wire-prefix hash, fixed category and safe normalized headers", async () => {
    const response = await fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true });
    expect(response).toMatchObject({ status: 503, body: "", errorDiagnostics: {
      schema: "google-news-http-error-v1", bodyPrefixSha256: createHash("sha256").update(chunks[0]).digest("hex"),
      bodyPrefixBytes: chunks[0].length, bodyComplete: true, readStop: "end", category: "service_unavailable", encoding: "identity", mediaType: "text/html", retryAfterSeconds: 60, retryAfterDate: null,
    } });
    expect(JSON.stringify(response.errorDiagnostics)).not.toMatch(/secret|Bearer|cookie|example\.com/);
    expect(mock.request).toHaveBeenCalledOnce();
  });

  it("caps bytes across chunks and discards unsafe or unknown header values", async () => {
    chunks = [Buffer.alloc(4000, 65), Buffer.alloc(10000, 66), Buffer.from("captcha secret")];
    headers = { "content-type": "secret/private; token=secret", "retry-after": "60\r\nsecret", "content-encoding": "secret" };
    const response = await fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true });
    expect(response.errorDiagnostics).toMatchObject({ bodyPrefixBytes: 8192, bodyComplete: false, readStop: "byte_limit", category: "encoded", encoding: "other", mediaType: "other", retryAfterSeconds: null, retryAfterDate: null,
      bodyPrefixSha256: createHash("sha256").update(Buffer.concat(chunks).subarray(0, 8192)).digest("hex") });
    expect(JSON.stringify(response.errorDiagnostics)).not.toContain("secret");
  });

  it.each(["error", "stall"] as const)("preserves HTTP503 when diagnostic body ends in %s", async failure => {
    vi.useFakeTimers(); mode = failure;
    const pending = fetchPublicHttpText(url, { resolver, timeoutMs: 1000, googleNewsErrorDiagnostics: true });
    await vi.advanceTimersByTimeAsync(260);
    expect(await pending).toMatchObject({ status: 503, body: "", errorDiagnostics: { bodyComplete: false, readStop: failure === "error" ? "stream_error" : "time_limit" } });
    expect(mock.request).toHaveBeenCalledOnce();
  });

  it("does not extend the existing absolute request deadline", async () => {
    vi.useFakeTimers(); mode = "stall"; headerDelay = 240;
    const pending = fetchPublicHttpText(url, { resolver, timeoutMs: 250, googleNewsErrorDiagnostics: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ status: 503, errorDiagnostics: { readStop: "time_limit", bodyComplete: false } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps success, 304, non-opt-in and non-Google callers unchanged", async () => {
    mode = "stall";
    expect(await fetchPublicHttpText(url, { resolver })).toMatchObject({ status: 503, body: "" });
    expect(await fetchPublicHttpText("https://company.com/news", { resolver, googleNewsErrorDiagnostics: true })).not.toHaveProperty("errorDiagnostics");
    status = 304;
    expect(await fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true })).not.toHaveProperty("errorDiagnostics");
    status = 200; mode = "end";
    const success = await fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true });
    expect(success.body).toBe(chunks[0].toString()); expect(success).not.toHaveProperty("errorDiagnostics");
  });

  it("does not alter redirect safety and normalizes a valid Retry-After date", async () => {
    status = 302; headers.location = "http://169.254.169.254/private";
    await expect(fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true })).rejects.toThrow();
    expect(mock.request).toHaveBeenCalledOnce();
    status = 503; delete headers.location; headers["retry-after"] = "Wed, 14 Oct 2026 04:00:00 GMT";
    expect((await fetchPublicHttpText(url, { resolver, googleNewsErrorDiagnostics: true })).errorDiagnostics?.retryAfterDate).toBe("2026-10-14T04:00:00.000Z");
  });
});
