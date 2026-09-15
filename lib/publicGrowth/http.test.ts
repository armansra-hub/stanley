import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fetchJson, PublicGrowthDeadlineError } from "./http";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("public-growth provider deadline", () => {
  it("does not start an expired provider request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchJson("https://example.test", {}, 20_000, 1, Date.now() - 1)).rejects.toBeInstanceOf(PublicGrowthDeadlineError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts an in-flight request at the shared deadline instead of the full20seconds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const result = fetchJson("https://example.test", {}, 20_000, 3, 1250);
    const assertion = expect(result).rejects.toBeInstanceOf(PublicGrowthDeadlineError);
    await vi.advanceTimersByTimeAsync(250); await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not sleep past the deadline for Retry-After", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "30" } })));
    await expect(fetchJson("https://example.test", {}, 20_000, 3, 1500)).rejects.toBeInstanceOf(PublicGrowthDeadlineError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
