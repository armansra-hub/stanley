import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), catalog: vi.fn(), examples: vi.fn(), matches: vi.fn() }));
vi.mock("@/lib/intelligence/http", () => ({ intelligenceUiAuthorized: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: (_: number, work: () => unknown) => work() }));
vi.mock("@/lib/intelligence/customerCriteriaServer", () => ({ loadCustomerCriteriaCatalog: mocks.catalog, loadCustomerCriterionExamples: mocks.examples, loadCustomerCriteriaMatches: mocks.matches }));
import { GET as catalog } from "@/app/api/headhunter/intelligence/customer-criteria/route";
import { GET as examples } from "@/app/api/headhunter/intelligence/customer-criteria/examples/route";
import { GET as matches } from "@/app/api/headhunter/intelligence/customer-criteria/matches/route";
const request = (query = "") => new NextRequest(`https://stanley.example/api?${query}`);
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockReturnValue(true); });
describe("read-only approved criteria endpoints", () => {
  it("requires the user session for definitions and private customer/prospect proof", async () => {
    mocks.auth.mockReturnValue(false);
    for (const get of [catalog, examples, matches]) expect((await get(request())).status).toBe(401);
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.examples).not.toHaveBeenCalled(); expect(mocks.matches).not.toHaveBeenCalled();
  });
  it("rejects unpinned versions, invalid provider industries and invalid page/visibility before reading", async () => {
    for (const query of ["criterion=one", "version=v&criterion=one&industry=customer-sector", "version=v&criterion=one&page=0", "version=v&criterion=one&showHidden=maybe"])
      expect((await matches(request(query))).status).toBe(400);
    expect(mocks.matches).not.toHaveBeenCalled();
  });
  it("distinguishes unavailable data from no selection and unevaluated matches", async () => {
    mocks.catalog.mockResolvedValue({ available: false, reason: "not_selected" });
    expect(await (await catalog(request())).json()).toEqual({ available: false, reason: "not_selected" });
    mocks.catalog.mockRejectedValue(new Error("database detail must stay private"));
    const failed = await catalog(request()); expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain("database detail");
    mocks.matches.mockResolvedValue({ state: "not_yet_evaluated", total: null, accounts: [] });
    const response = await matches(request("version=v&criterion=all&industry=G10"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ state: "not_yet_evaluated", total: null });
    expect(mocks.matches).toHaveBeenCalledWith({ version: "v", criterion: "all", industry: "G10", page: 1, showHidden: false });
  });
});
