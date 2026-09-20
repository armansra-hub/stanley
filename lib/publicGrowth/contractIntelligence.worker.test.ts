import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), enqueue: vi.fn(), native: vi.fn(), priority: vi.fn(), trigger: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue }));
vi.mock("@/lib/intelligence/nativeJev", () => ({ evaluateNativeCached: mocks.native }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.priority }));
vi.mock("./storage", () => ({ recordPublicGrowthTrigger: mocks.trigger }));
import { runContractIntelligence, type ContractAward } from "./contractIntelligence";

const company = { id: "10000000-0000-4000-8000-000000000001", name: "Example", domain: "example.test" };
const award: ContractAward = { id: "20000000-0000-4000-8000-000000000001", generated_award_id: "CONT_123", government_entity_id: "entity", award_id: "47QRAA26D0001",
  awarding_agency: "Agency", description: "Services", start_date: null, end_date: null, potential_end_date: null,
  award_ceiling: 1000, current_award_amount: 100, total_obligations: 50, source_url: "https://usaspending.gov/award/CONT_123", payload_hash: "hash" };
const claim = (awards: ContractAward[] = [award]) => ({ company, lease_token: "lease", awards, recipients: { entity: "Example LLC" } });
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
  for (const method of ["select", "eq", "is", "gte", "order", "limit", "maybeSingle", "single", "upsert", "in", "range"]) chain[method] = () => chain;
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enqueue.mockResolvedValue({ id: "observation", queued: true });
  mocks.priority.mockResolvedValue(0);
  mocks.from.mockImplementation((table: string) => query({ data: table === "triggers" ? [] : null, error: null }));
});

describe("contract worker failure receipts", () => {
  it("persists the failing stage and SQLSTATE without advancing the award or exposing database text", async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "contract_intelligence_claim" ? claim() : true, error: null }));
    mocks.from.mockReturnValue(query({ data: null, error: { code: "57014", message: "private SQL and credential payload", details: "private" } }));
    const result = await runContractIntelligence(1);
    expect(result).toMatchObject({ checkedAccounts: 0, failedAccounts: 1, observations: 0,
      failures: [{ companyId: company.id, errorCode: "contract_delivery_lookup_57014", checkpointed: true }] });
    expect(mocks.rpc).toHaveBeenLastCalledWith("contract_intelligence_finish", { p_company: company.id, p_lease: "lease", p_error: "contract_delivery_lookup_57014" });
    expect(mocks.rpc.mock.calls.some(([name]) => name === "contract_intelligence_award_done")).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("retains a completed delivery when timing sync fails and continues to the next leased account", async () => {
    const claims = [claim(), { ...claim([]), company: { ...company, id: "10000000-0000-4000-8000-000000000002" } }];
    mocks.rpc.mockImplementation(async (name: string) => name === "contract_intelligence_claim" ? { data: claims.shift(), error: null }
      : name === "contract_timing_sync" ? { data: null, error: { code: "42883", message: "sensitive SQL" } } : { data: true, error: null });
    const result = await runContractIntelligence(2);
    expect(result).toMatchObject({ checkedAccounts: 1, failedAccounts: 1, observations: 1,
      failures: [{ companyId: company.id, errorCode: "contract_timing_sync_42883", checkpointed: true }] });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.some(([name]) => name === "contract_intelligence_award_done")).toBe(false);
    expect(mocks.priority).toHaveBeenCalledTimes(1);
  });

  it("identifies a nested announcement read failure and reports an unconfirmed error checkpoint", async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "contract_intelligence_claim" ? claim([]) : false, error: null }));
    mocks.from.mockReturnValue(query({ data: null, error: { code: "22P02", message: "private source content" } }));
    const result = await runContractIntelligence(1);
    expect(result.failures).toEqual([{ companyId: company.id, errorCode: "contract_announcement_lookup_22P02", checkpointed: false }]);
    expect(result.failedAccounts).toBe(1); expect(result.checkedAccounts).toBe(0);
  });

  it("keeps existing observation SQLSTATE diagnostics while rejecting arbitrary error messages", async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "contract_intelligence_claim" ? claim() : true, error: null }));
    mocks.enqueue.mockRejectedValueOnce(new Error("Observation persistence failed: 23505"));
    expect((await runContractIntelligence(1)).failures[0].errorCode).toBe("contract_observation_enqueue_23505");
    mocks.enqueue.mockRejectedValueOnce(new Error("https://secret@private.test record excerpt"));
    const result = await runContractIntelligence(1);
    expect(result.failures[0].errorCode).toBe("contract_observation_enqueue_failed");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
