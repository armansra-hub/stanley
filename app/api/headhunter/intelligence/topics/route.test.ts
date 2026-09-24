import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ authorized: vi.fn(), enabled: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: mocks.authorized, isUuid: (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { GET } from "./route";
beforeEach(() => {
  mocks.authorized.mockReset().mockReturnValue(true); mocks.enabled.mockReset().mockReturnValue(true);
  mocks.rpc.mockReset().mockResolvedValue({ data: { enabled: true, topics: ["inventory"], accounts: [], hasMore: false, nextCursor: null }, error: null });
});
describe("cached operating topic search route", () => {
  it("requires authentication before reading cached account data", async () => {
    mocks.authorized.mockReturnValue(false);
    expect((await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/topics?topic=inventory"))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["topic=constructor", "topic=inventory&limit=13", "topic=inventory&after=invalid", "topic=inventory&mode=none", "topic=inventory&visibility=approve"])("rejects invalid query %s before storage", async query => {
    expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/topics?${query}`))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses the bounded read-only exploration RPC without changing default search", async () => {
    await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/topics?topic=project_delivery&visibility=explore"));
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_topic_explore", {p_topics:["project_delivery"],p_after:null,p_limit:8,p_mode:"all",p_show_hidden:false});
  });
  it("reads one bounded keyset page using only the cached search RPC", async () => {
    const after = "10000000-0000-4000-8000-000000000001";
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/topics?topic=inventory&after=${after}&limit=4`));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("intelligence_topic_search", { p_topics: ["inventory"], p_after: after, p_limit: 4, p_mode: "all", p_show_hidden: false });
    expect(await response.json()).toMatchObject({ coverageLimited: true, accounts: [] });
  });
  it("accepts an empty selection for counts and an explicit Any search", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { enabled: true, topics: [], accounts: [], topicCounts: { inventory: 0 }, hasMore: false, nextCursor: null }, error: null });
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/topics"));
    expect(await response.json()).toMatchObject({ accounts: [], topicCounts: { inventory: 0 } });
    expect(mocks.rpc).toHaveBeenLastCalledWith("intelligence_topic_search", { p_topics: [], p_after: null, p_limit: 8, p_mode: "all", p_show_hidden: false });
    await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/topics?topic=project_delivery&topic=project_billing&mode=any"));
    expect(mocks.rpc).toHaveBeenLastCalledWith("intelligence_topic_search", { p_topics: ["project_delivery", "project_billing"], p_after: null, p_limit: 8, p_mode: "any", p_show_hidden: false });
  });
  it.each(["supported", "explore"])("reads stored %s answers while processing is paused", async visibility => {
    mocks.enabled.mockReturnValue(false);
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/topics?topic=inventory&visibility=${visibility}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, accounts: [] });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(visibility === "explore" ? "intelligence_topic_explore" : "intelligence_topic_search",
      { p_topics: ["inventory"], p_after: null, p_limit: 8, p_mode: "all", p_show_hidden: false });
  });
  it.each(["supported", "explore"])("accepts the future 3PL category and explicit hidden-account recovery in %s", async visibility => {
    mocks.enabled.mockReturnValue(false);
    const response = await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/topics?topic=non_asset_based_3pl&showHidden=true&visibility=${visibility}`));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(visibility === "explore" ? "intelligence_topic_explore" : "intelligence_topic_search",
      { p_topics: ["non_asset_based_3pl"], p_after: null, p_limit: 8, p_mode: "all", p_show_hidden: true });
  });
});
