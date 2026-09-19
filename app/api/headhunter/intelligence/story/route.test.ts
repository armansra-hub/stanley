import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ auth: vi.fn(), origin: vi.fn(), enabled: vi.fn(), account: vi.fn(), load: vi.fn(), queue: vi.fn(), worker: vi.fn(), after: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: m.after }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: m.auth, sameOriginMutation: m.origin,
  isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value), smallJson: (req: Request) => req.json() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: m.enabled }));
vi.mock("@/lib/intelligence/narratives", () => ({ loadAccountIntelligence: m.load, queueAccountStory: m.queue, runAccountStoryWorker: m.worker }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq"]) chain[method] = () => chain;
  chain.maybeSingle = m.account; return chain;
} }) }));
import { GET, POST } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const get = () => GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/story?companyId=${id}`));
const post = () => POST(new NextRequest("https://stanley.test/api/headhunter/intelligence/story", { method: "POST", body: JSON.stringify({ companyId: id }) }));
beforeEach(() => { vi.clearAllMocks(); m.auth.mockReturnValue(true); m.origin.mockReturnValue(true); m.enabled.mockReturnValue(true);
  m.account.mockResolvedValue({ data: { id }, error: null }); m.queue.mockResolvedValue(true); m.load.mockResolvedValue({ events: [], story: null, history: [] }); });
describe("account story routes", () => {
  it("authenticates and rejects cross-origin mutations before reading an account", async () => {
    m.auth.mockReturnValue(false); expect((await get()).status).toBe(401); expect((await post()).status).toBe(401);
    m.auth.mockReturnValue(true); m.origin.mockReturnValue(false); expect((await post()).status).toBe(403); expect(m.account).not.toHaveBeenCalled();
  });
  it("returns cache-only stories without dispatching generation", async () => {
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(m.load).toHaveBeenCalledWith(id); expect(m.queue).not.toHaveBeenCalled(); expect(m.worker).not.toHaveBeenCalled();
  });
  it("does not queue a removed or missing account", async () => {
    m.account.mockResolvedValue({ data: null, error: null }); expect((await post()).status).toBe(404); expect(m.queue).not.toHaveBeenCalled();
  });
  it("persists the queue before starting a bounded after-response worker", async () => {
    expect(await (await post()).json()).toEqual({ ok: true, queued: true }); expect(m.queue).toHaveBeenCalledWith(id, { force: true });
    expect(m.worker).not.toHaveBeenCalled(); await m.after.mock.calls[0][0](); expect(m.worker).toHaveBeenCalledWith(1, expect.any(Number));
  });
  it("keeps an existing leased job without starting a second worker", async () => {
    m.queue.mockResolvedValue(false); expect(await (await post()).json()).toEqual({ ok: true, queued: false }); expect(m.after).not.toHaveBeenCalled();
  });
});
