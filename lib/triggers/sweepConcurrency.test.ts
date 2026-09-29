import { afterEach, expect, it, vi } from "vitest";
import { sweepBase } from "./sweep";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), checked: vi.fn(), news: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: vi.fn(), intelligenceEnabled: () => true }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: async () => ({ cursor: null }), writeSourceState: mocks.write }));
vi.mock("@/lib/sources/googleNews", () => ({ fetchNewsForCompanyResult: mocks.news, fetchNewsItemsResult: vi.fn() }));
vi.mock("@/lib/sources/newsEvidence", () => ({ readNewsEvidence: vi.fn() }));
vi.mock("@/lib/db/triggers", () => ({ pickForRotation: mocks.pick, markChecked: mocks.checked, recordTrigger: vi.fn(), recomputePriority: vi.fn(), setErpFlags: vi.fn(), queueCandidate: vi.fn(), headlineCandidateSeen: vi.fn() }));
vi.mock("@/lib/db/companies", () => ({ normalizeCompanyName: (name: string) => name.toLowerCase() }));
vi.mock("@/lib/db/settings", () => ({ claimClassifierCall: vi.fn() }));
vi.mock("@/lib/triggers/config", () => ({ classifyHeadline: vi.fn() }));
vi.mock("@/lib/triggers/classify", () => ({ classifyEventLLM: vi.fn(), HEADLINE_CLASSIFIER_BATCH_BUDGET_MS: 30_000 }));
vi.mock("@/lib/apify/run", () => ({ runActor: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("attempts every reserved company in order while bounding news company concurrency to four", async () => {
  // Use the real rotation generator, including its exact final remainder.
  const companies = Array.from({ length: 30 }, (_, index) => ({ id: `account-${index}`, name: `Company ${index}` }));
  const attempted: string[] = [];
  let cursor = 0, active = 0, peak = 0;
  mocks.pick.mockImplementation(async (size: number) => {
    const rows = companies.slice(cursor, cursor + size);
    cursor += rows.length;
    return rows;
  });
  mocks.news.mockImplementation(async (company: { id: string }) => {
    attempted.push(company.id);
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return { items: [], status: "empty" };
  });
  mocks.checked.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);

  expect(await sweepBase(30)).toMatchObject({ checked: 30, attempted: 30, succeeded: 30, failed: 0 });
  expect(peak).toBe(4);
  expect(attempted).toEqual(companies.map(company => company.id));
  expect(mocks.pick.mock.calls).toEqual([[4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [2, 0]]);
  expect(mocks.checked.mock.calls.flatMap(([ids]) => ids)).toEqual(attempted);
});
