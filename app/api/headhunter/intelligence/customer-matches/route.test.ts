import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ authorized: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: mocks.authorized }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
vi.mock("@/lib/intelligence/customerMatchesServer", () => ({ loadCustomerMatches: mocks.load }));
import { GET } from "./route";
beforeEach(() => { mocks.authorized.mockReset().mockReturnValue(true); mocks.load.mockReset().mockResolvedValue({ accounts: [], total: 0 }); });
describe("customer match cached API", () => {
  it("requires app authorization", async () => {
    mocks.authorized.mockReturnValue(false);
    expect((await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/customer-matches"))).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each(["pattern=other", "page=0", "page=1.5", "showHidden=1", "page=Infinity", "industry=", "industry=%00", `industry=${"x".repeat(181)}`])("rejects invalid query %s", async query => {
    expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/intelligence/customer-matches?${query}`))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("passes an explicit industry alongside the independent pattern filter", async () => {
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/customer-matches?pattern=all&industry=Facilities%20Management"));
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith({ pattern: "all", industry: "Facilities Management", page: 1, showHidden: false });
  });
  it("passes explicit pattern/page/visibility without calling Jev", async () => {
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/customer-matches?pattern=transport&page=42&showHidden=true"));
    expect(response.status).toBe(200); expect(mocks.load).toHaveBeenCalledWith({ pattern: "transport", industry: "all", page: 42, showHidden: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns a bounded failure without exposing private database text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.load.mockRejectedValue({ code: "57014", message: "private customer query" });
    const response = await GET(new NextRequest("https://stanley.test/api/headhunter/intelligence/customer-matches"));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "customer_matches_unavailable" });
    expect(log).toHaveBeenCalledWith("intelligence.customer_matches_unavailable", { code: "57014" }); log.mockRestore();
  });
});
