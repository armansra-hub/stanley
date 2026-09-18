import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./http", () => ({ fetchJson: mocks.fetch }));
import { searchReceivedContractSubawardsPage, searchContractAwardsPage, fetchAwardTransactionsPage } from "./usaspending";
beforeEach(() => mocks.fetch.mockReset());

describe("bounded subaward source page", () => {
  it("uses one20second attempt and preserves nested prime provenance", async () => {
    mocks.fetch.mockResolvedValue({ results: [{ "Prime Award ID": "P1", "Prime Recipient Name": "Prime", "Prime Award Recipient UEI": "ABCDEFGHIJKL",
      Subawards: [{ "Sub-Award ID": "S1", "Sub-Recipient UEI": "ZYXWVUTSRQPO" }] }], page_metadata: { hasNext: true } });
    const result = await searchReceivedContractSubawardsPage("Alias", 4, "2026-09-14", 5000);
    expect(result).toEqual({ rows: [expect.objectContaining({ "Sub-Award ID": "S1", primeAwardId: "P1", "Prime Recipient Name": "Prime",
      "Prime Award Recipient UEI": "ABCDEFGHIJKL", "Sub-Recipient UEI": "ZYXWVUTSRQPO" })], hasNext: true, sourceResultCount: 1 });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: expect.any(String) }), 20_000, 1, 5000);
    const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ page: 4, limit: 100, subawards: true, filters: { recipient_search_text: ["Alias"], time_period: [{ end_date: "2026-09-14", start_date: "2007-10-01" }] } });
  });
  it("sends both frozen inclusive partition boundaries", async () => {
    mocks.fetch.mockResolvedValue({ results: [], page_metadata: { hasNext: false } });
    await searchReceivedContractSubawardsPage("Alias", 1, "2020-02-29", 5000, "2020-02-01");
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).filters.time_period)
      .toEqual([{ start_date: "2020-02-01", end_date: "2020-02-29" }]);
  });
  it("rejects missing pagination instead of claiming an incomplete history done", async () => {
    mocks.fetch.mockResolvedValue({ results: [] });
    await expect(searchReceivedContractSubawardsPage("Alias", 1, "2026-09-14")).rejects.toThrow("explicit pagination");
  });
  it.each([{}, { results: [] }, { results: {}, page_metadata: { hasNext: false } }])("rejects incomplete prime/transaction response %j", async (data) => {
    mocks.fetch.mockResolvedValue(data);
    await expect(searchContractAwardsPage("Acme", 1, "2026-09-18")).rejects.toThrow("explicit pagination");
    await expect(fetchAwardTransactionsPage("A1", 1)).rejects.toThrow("explicit pagination");
  });
  it("rejects malformed prime rows instead of silently dropping their coverage", async () => {
    mocks.fetch.mockResolvedValue({ results: [{ "Recipient Name": "Acme" }], page_metadata: { hasNext: false } });
    await expect(searchContractAwardsPage("Acme", 1, "2026-09-18")).rejects.toThrow("invalid identity rows");
  });
});
