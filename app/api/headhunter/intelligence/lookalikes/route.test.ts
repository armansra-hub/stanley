import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: m.auth, isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: m.enabled }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: m.rpc }) }));
import { GET } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const get = (offset = "0") => GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/lookalikes?companyId=${id}&offset=${offset}`));
beforeEach(() => { vi.clearAllMocks(); m.auth.mockReturnValue(true); m.enabled.mockReturnValue(true); m.rpc.mockResolvedValue({ data: { matches: [], nextOffset: null }, error: null }); });
describe("sourced lookalike API", () => {
  it("authenticates before querying account evidence", async () => { m.auth.mockReturnValue(false); expect((await get()).status).toBe(401); expect(m.rpc).not.toHaveBeenCalled(); });
  it.each(["-1", "NaN", "1.5", "100001"])("rejects invalid offset %s", async offset => { expect((await get(offset)).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled(); });
  it("uses a bounded account-scoped page and returns source-backed results unchanged", async () => {
    const data = { matches: [{ companyId: id, topics: ["project_billing"], sources: [{ url: "https://example.com/services" }] }], nextOffset: 16 };
    m.rpc.mockResolvedValue({ data, error: null }); const response = await get("8"); expect(await response.json()).toEqual(data);
    expect(m.rpc).toHaveBeenCalledWith("intelligence_lookalikes", { p_company: id, p_offset: 8, p_limit: 8 });
  });
  it("keeps stored source-backed matches readable when processing is paused", async () => {
    m.enabled.mockReturnValue(false);
    const data = { matches: [{ companyId: id, topics: ["project_billing"], sources: [{ url: "https://example.com/services" }] }], nextOffset: null };
    m.rpc.mockResolvedValue({ data, error: null });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(data);
    expect(m.rpc).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenCalledWith("intelligence_lookalikes", { p_company: id, p_offset: 0, p_limit: 8 });
  });
});
