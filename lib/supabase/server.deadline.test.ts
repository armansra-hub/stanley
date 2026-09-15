import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }));
import { deadlineFetch, serviceClient, withServiceDeadline } from "./server";
beforeEach(() => { mocks.create.mockReset(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("opt-in service deadline", () => {
  it("leaves ordinary callers unchanged and isolates concurrent async scopes", async () => {
    await Promise.all([withServiceDeadline(Date.now() + 5000, async () => { await Promise.resolve(); serviceClient(); }), Promise.resolve().then(() => serviceClient())]);
    expect(mocks.create.mock.calls.map((call) => Boolean(call[2].global?.fetch)).sort()).toEqual([false, true]);
    serviceClient(); expect(mocks.create.mock.lastCall?.[2]).toEqual({ auth: { persistSession: false } });
  });
  it("cannot extend a parent deadline, makes no expired request, and restores scope after errors", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(withServiceDeadline(Date.now() - 1, () => withServiceDeadline(Date.now() + 5000, async () => {
      serviceClient(); await mocks.create.mock.lastCall![2].global.fetch("https://example.invalid");
    }))).rejects.toThrow(/deadline/);
    expect(fetcher).not.toHaveBeenCalled(); serviceClient(); expect(mocks.create.mock.lastCall![2].global).toBeUndefined();
  });
  it("retains caller cancellation and refuses authenticated redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    const ctl = new AbortController();
    await deadlineFetch(Date.now() + 5000)("https://example.invalid", { signal: ctl.signal, headers: { authorization: "test-only" } });
    const init = fetcher.mock.calls[0][1]; expect(init.redirect).toBe("error"); expect(init.headers.authorization).toBe("test-only");
    ctl.abort(); expect(init.signal.aborted).toBe(true);
  });
  it("keeps a live timeout signal through response-body consumption", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    await deadlineFetch(Date.now() + 10)("https://example.invalid");
    const signal = fetcher.mock.calls[0][1].signal;
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(signal.aborted).toBe(true);
  });
});
