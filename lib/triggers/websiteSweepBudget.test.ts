import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), site: vi.fn(), checked: vi.fn(), attempted: vi.fn() }));
vi.mock("@/lib/db/triggers", () => ({ pickSitesForRotation: mocks.pick, setSiteChecked: mocks.checked, markSiteAttempted: mocks.attempted,
  setParent: vi.fn(), recordTrigger: vi.fn(), recomputePriority: vi.fn() }));
vi.mock("@/lib/db/companies", () => ({ setCompaniesStatus: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getAppConfig: async () => ({ parent_autodismiss: false }) }));
vi.mock("@/lib/sources/website", () => ({ fetchSiteSignals: mocks.site, readWebsiteCache: () => ({}) }));
vi.mock("@/lib/triggers/sweep", () => ({ classifyAndRecordHeadline: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: () => false, enqueueObservation: vi.fn() }));
import { sweepWebsites, WEBSITE_ADMISSION_BUDGET_MS } from "./websiteSweep";

const companies = Array.from({ length: 24 }, (_, index) => ({ id: `company-${index}`, name: `Company ${index}`, domain: `company-${index}.example`, site_hash: null }));
const scan = { growth: [], parent: null, feedUrl: null, financeRoles: [], pages: [], discoveredUrls: [],
  coverage: { attemptedUrls: [], succeededUrls: [], remainingUrls: [] } };
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  Object.values(mocks).forEach(mock => mock.mockReset());
  let reserved = 0;
  mocks.pick.mockImplementation(async (size: number) => {
    const batch = companies.slice(reserved, reserved + size);
    reserved += batch.length;
    return batch;
  });
  mocks.site.mockResolvedValue(scan);
  mocks.checked.mockResolvedValue(undefined);
  mocks.attempted.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("website admission headroom with the real reservation loop", () => {
  it("finishes the admitted batch but leaves later companies unreserved after 150 seconds", async () => {
    mocks.site.mockImplementation(async () => { now = WEBSITE_ADMISSION_BUDGET_MS; return scan; });
    const result = await sweepWebsites(companies.length);
    expect(WEBSITE_ADMISSION_BUDGET_MS).toBe(150_000);
    expect(result).toMatchObject({ checked: 12, attempted: 12, unavailable: 12 });
    expect(mocks.pick).toHaveBeenCalledTimes(1);
    expect(mocks.pick).toHaveBeenCalledWith(12, 0, "claimable");
    expect(mocks.site.mock.calls.map(([domain]) => domain)).toEqual(companies.slice(0, 12).map(company => company.domain));
    expect(mocks.attempted.mock.calls.map(([id]) => id)).toEqual(companies.slice(0, 12).map(company => company.id));
  });

  it("still attempts every row already reserved when the reservation itself crosses the budget", async () => {
    mocks.pick.mockImplementation(async () => { now = WEBSITE_ADMISSION_BUDGET_MS + 1; return companies.slice(0, 12); });
    expect(await sweepWebsites(companies.length)).toMatchObject({ checked: 12, attempted: 12 });
    expect(mocks.pick).toHaveBeenCalledTimes(1);
    expect(mocks.site).toHaveBeenCalledTimes(12);
    expect(mocks.attempted).toHaveBeenCalledTimes(12);
  });
});
