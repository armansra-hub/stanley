import { describe, expect, it, vi } from "vitest";
import { fetchConditionalText, retainedValidators } from "./conditionalFetch";
const url = "https://company.com/news";
const response = (status: number, finalUrl = url) => ({ status, finalUrl, body: status === 304 ? "" : "Existing article body", contentType: "text/html" });
describe("conditional public source requests", () => {
  it("sends validators only for the retained exact representation and accepts 304", async () => {
    const fetch = vi.fn().mockResolvedValue(response(304));
    expect((await fetchConditionalText(url, { timeoutMs: 1000 }, { retained: true, validators: { url, etag: '"v1"', lastModified: "Fri, 18 Sep 2026 00:00:00 GMT" } }, fetch)).status).toBe(304);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ ifNoneMatch: '"v1"', ifModifiedSince: expect.any(String) }));
    expect(retainedValidators({ url, etag: '"v1"\r\nx-secret: bad' }, url)).toBeUndefined();
    expect(retainedValidators({ url, etag: '"v1"' }, "https://different.com")).toBeUndefined();
  });
  it("recovers an unsolicited 304 without inventing an empty successful source", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(304)).mockResolvedValueOnce(response(200));
    expect((await fetchConditionalText(url, { timeoutMs: 1000 }, { retained: false, validators: { url, etag: '"v1"' } }, fetch)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, options]) => !options.ifNoneMatch)).toBe(true);
    const invalid = vi.fn().mockResolvedValue(response(304));
    await expect(fetchConditionalText(url, { timeoutMs: 1000 }, undefined, invalid)).rejects.toThrow("304");
  });
  it("does not reuse a cached original representation after a redirect target responds 304", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(304, "https://other.com/news")).mockResolvedValueOnce(response(200));
    expect((await fetchConditionalText(url, { timeoutMs: 1000 }, { retained: true, validators: { url, etag: '"v1"' } }, fetch)).status).toBe(200);
    expect(fetch.mock.calls[1][1]).not.toHaveProperty("ifNoneMatch");
  });
});
