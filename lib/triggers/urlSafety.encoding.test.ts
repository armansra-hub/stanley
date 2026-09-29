import { EventEmitter } from "node:events";
import type { Transform } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ request: vi.fn(), stall: false, decoder: null as Transform | null, requestDestroyed: false }));
vi.mock("node:https", () => ({ request: mock.request }));
vi.mock("node:zlib", async original => {
  const actual = await original<typeof import("node:zlib")>();
  const { Transform } = await import("node:stream");
  return { ...actual, createGunzip: (...args: Parameters<typeof actual.createGunzip>) => {
    if (!mock.stall) return actual.createGunzip(...args);
    mock.decoder = new Transform({ transform() { /* A decoder that never completes. */ } });
    return mock.decoder;
  } };
});
import { fetchPublicHttpBytes, fetchPublicHttpText } from "./urlSafety";

const resolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
let payload: Buffer, encoding: string, status: number, location: string | undefined;
beforeEach(() => {
  payload = Buffer.from("Public evidence"); encoding = "identity"; status = 200; location = undefined;
  mock.request.mockReset(); mock.stall = false; mock.decoder = null; mock.requestDestroyed = false;
  mock.request.mockImplementation((_url, options, onResponse) => {
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    // Deliberately do not emit an error after response completion: timeout must
    // reject explicitly while an asynchronous decoder is still outstanding.
    request.destroy = () => { mock.requestDestroyed = true; };
    request.end = () => queueMicrotask(() => {
      expect(options.agent).toBe(false);
      options.lookup("publisher.com", {}, (error: unknown, address: string) => { expect(error).toBeNull(); expect(address).toBe("93.184.216.34"); });
      const response = new EventEmitter() as EventEmitter & { headers: unknown; statusCode: number; destroy(error?: Error): void };
      response.headers = { "content-type": "text/html; charset=UTF-8", "content-encoding": encoding, etag: '"page-v1"', location };
      response.statusCode = status;
      let destroyed = false;
      response.destroy = error => { destroyed = true; if (error) response.emit("error", error); };
      onResponse(response);
      if (!destroyed) { response.emit("data", payload); if (!destroyed) response.emit("end"); }
    });
    return request;
  });
});

describe("bounded HTTP content decoding", () => {
  it.each([ ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync] ] as const)("decodes %s before UTF-8 conversion", async (type, compress) => {
    const text = "<article>Public café evidence 😀.</article>";
    encoding = type; payload = compress(text);
    expect(await fetchPublicHttpText("https://publisher.com/news/update", { resolver })).toMatchObject({ body: text, status: 200, etag: '"page-v1"' });
  });

  it("returns the decoded binary representation without a lossy UTF-8 roundtrip", async () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x89]);
    encoding = "gzip"; payload = gzipSync(pdf);
    expect((await fetchPublicHttpBytes("https://publisher.com/document.pdf", { resolver })).body).toEqual(new Uint8Array(pdf));
  });

  it("enforces both the compressed wire cap and decoded expansion cap", async () => {
    encoding = "gzip"; payload = Buffer.alloc(20_000);
    await expect(fetchPublicHttpBytes("https://publisher.com/news/update", { resolver, maxBytes: 16_384 })).rejects.toThrow("HTTP response exceeded size limit");
    payload = gzipSync(Buffer.alloc(20_000, 65));
    expect(payload.length).toBeLessThan(16_384);
    await expect(fetchPublicHttpBytes("https://publisher.com/news/update", { resolver, maxBytes: 16_384 })).rejects.toThrow("decoded response exceeded size limit");
  });

  it.each(["gzip", "deflate", "br"])("rejects corrupt %s without returning binary text", async type => {
    encoding = type; payload = Buffer.from([0xff, 0, 0xff, 0]);
    await expect(fetchPublicHttpText("https://publisher.com/news/update", { resolver })).rejects.toThrow("content decoding failed");
  });

  it("rejects unsupported encodings but leaves bodyless statuses and redirect safety unchanged", async () => {
    encoding = "zstd";
    await expect(fetchPublicHttpText("https://publisher.com/news/update", { resolver })).rejects.toThrow("Unsupported HTTP content encoding");
    status = 304;
    expect(await fetchPublicHttpText("https://publisher.com/news/update", { resolver })).toMatchObject({ body: "", status: 304, etag: '"page-v1"' });
    status = 302; location = "http://169.254.169.254/private";
    const before = mock.request.mock.calls.length;
    await expect(fetchPublicHttpText("https://publisher.com/news/update", { resolver })).rejects.toThrow();
    expect(mock.request.mock.calls.length - before).toBe(1);
  });

  it("keeps the absolute timeout active after HTTP end and destroys the decoder", async () => {
    encoding = "gzip"; payload = gzipSync("Public evidence"); mock.stall = true;
    await expect(fetchPublicHttpText("https://publisher.com/news/update", { resolver, timeoutMs: 250 })).rejects.toThrow("HTTP fetch timed out");
    expect(mock.decoder?.destroyed).toBe(true);
    expect(mock.requestDestroyed).toBe(true);
  });
});
