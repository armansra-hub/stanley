import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepTalNews, TAL_NEWS_BUDGET_MS, TAL_NEWS_FINAL_BATCH_HEADROOM_MS } from "./talSweep";

const mocks = vi.hoisted(() => ({ list: vi.fn(), alert: vi.fn(), priority: vi.fn(), checked: vi.fn(), collect: vi.fn(), deadline: vi.fn() }));
vi.mock("@/lib/db/triggers", () => ({ listTalCompanies: mocks.list, setTalAlert: mocks.alert, recomputePriority: mocks.priority, markChecked: mocks.checked }));
vi.mock("@/lib/triggers/sweep", () => ({ checkCompanyNews: mocks.collect }));
vi.mock("@/lib/triggers/classify", () => ({ HEADLINE_CLASSIFIER_BATCH_BUDGET_MS: 30_000 }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: mocks.deadline }));

const companies = (n: number) => Array.from({ length: n }, (_, index) => ({ id: `tal-${index}`, name: `TAL ${index}`, domain: null, last_checked_at: null }));
let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.list.mockResolvedValue(companies(1));
  mocks.alert.mockResolvedValue(undefined);
  mocks.priority.mockResolvedValue(undefined);
  mocks.checked.mockResolvedValue(undefined);
  mocks.deadline.mockImplementation(async (_deadline, operation) => operation());
  mocks.collect.mockImplementation(async (_company, options) => { options.onOutcome("succeeded"); return 1; });
});
afterEach(() => vi.restoreAllMocks());

describe("bounded TAL news supplement", () => {
  it("passes explicit source-only collection without enabling the legacy model", async () => {
    mocks.collect.mockImplementation(async (_company, options) => { options.onOutcome("succeeded"); return 0; });
    expect(await sweepTalNews({ sourceOnly: true })).toMatchObject({ sourceOnly: true, succeeded: 1, alerted: 0 });
    expect(mocks.collect.mock.calls[0][1]).toMatchObject({ sourceOnly: true, llm: false });
    expect(mocks.priority).not.toHaveBeenCalled();
  });
  it("stops admitting work with final-batch headroom and retains that batch's alerts", async () => {
    mocks.list.mockResolvedValue(companies(45));
    mocks.collect.mockImplementation(async (_company, options) => {
      options.onOutcome("succeeded");
      now = TAL_NEWS_BUDGET_MS - TAL_NEWS_FINAL_BATCH_HEADROOM_MS;
      return 1;
    });
    const result = await sweepTalNews();
    expect(mocks.collect).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ checked: 4, attempted: 4, succeeded: 4, alerted: 4,
      eligible: 45, remaining: 41, complete: false, stopReason: "budget_reached" });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledWith(companies(4).map(company => company.id));
    expect(mocks.checked).toHaveBeenCalledWith(companies(4).map(company => company.id));
    expect(mocks.deadline).toHaveBeenCalledWith(TAL_NEWS_BUDGET_MS, expect.any(Function));
    expect(mocks.collect.mock.calls[0][1]).toMatchObject({ llm: true, classifierDeadlineMs: 30_000 });
  });

  it("saves alerts before starting the next batch and processes the loader's oldest-first order", async () => {
    const list = companies(9).reverse();
    mocks.list.mockResolvedValue(list);
    mocks.collect.mockImplementation(async (_company, options) => {
      if (mocks.collect.mock.calls.length === 5) expect(mocks.alert).toHaveBeenCalledTimes(1);
      if (mocks.collect.mock.calls.length === 9) expect(mocks.alert).toHaveBeenCalledTimes(2);
      options.onOutcome("succeeded"); return 1;
    });
    expect(await sweepTalNews()).toMatchObject({ attempted: 9, succeeded: 9, alerted: 9,
      remaining: 0, complete: true, stopReason: "worklist_exhausted" });
    expect(mocks.alert.mock.calls.map(([ids]) => ids.length)).toEqual([4, 4, 1]);
    expect(mocks.collect.mock.calls.map(([company]) => company.id)).toEqual(list.map(company => company.id));
  });

  it("reports provider, storage and alert failures without claiming confirmed alerts or completeness", async () => {
    mocks.list.mockResolvedValue(companies(3));
    mocks.collect
      .mockImplementationOnce(async (_company, options) => { options.onOutcome("unavailable"); throw new Error("timeout"); })
      .mockRejectedValueOnce(new Error("storage unavailable"));
    mocks.alert.mockRejectedValue(new Error("TAL alert checkpoint write failed"));
    const result = await sweepTalNews();
    expect(result).toMatchObject({ attempted: 3, succeeded: 1, unavailable: 1, failed: 1,
      alerted: 0, error_count: 3, remaining: 0, complete: false, failedAlertCompanyIds: ["tal-2"] });
    expect(mocks.checked).toHaveBeenCalledWith([]);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(result.errors.map(error => error.stage)).toEqual(["collection", "collection", "alert_write"]);
  });

  it("retains exact failed-alert targets while stamping unaffected completed accounts", async () => {
    mocks.list.mockResolvedValue(companies(2));
    mocks.collect.mockImplementationOnce(async (_company, options) => { options.onOutcome("succeeded"); return 0; });
    mocks.alert.mockRejectedValue(new Error("TAL alert checkpoint write failed"));
    expect(await sweepTalNews()).toMatchObject({ attempted: 2, succeeded: 2, alerted: 0,
      failedAlertCompanyIds: ["tal-1"], complete: false });
    expect(mocks.checked).toHaveBeenCalledWith(["tal-0"]);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it("reclassifies failed completion stamps while preserving alerts already saved", async () => {
    mocks.checked.mockRejectedValue(new Error("News checkpoint write failed"));
    expect(await sweepTalNews()).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, alerted: 1, error_count: 1, complete: false });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledWith(["tal-0"]);
  });

  it("does not turn a failed membership read into an empty successful sweep", async () => {
    mocks.list.mockRejectedValue(new Error("TAL companies checkpoint read failed"));
    await expect(sweepTalNews()).rejects.toThrow("checkpoint read failed");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
