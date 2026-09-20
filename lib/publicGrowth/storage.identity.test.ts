import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/db/reheat", () => ({ reheatCompanyForFreshSignal: vi.fn() }));
import { saveCompanyGovernmentMatch, saveGovernmentEntity, stableHash } from "./storage";
const company = "11111111-1111-4111-8111-111111111111", entity = "22222222-2222-4222-8222-222222222222";
const pending = { status: "pending", method: "name_candidate", confidence: .35, evidence: { candidatePlausible: true } };
const saved = (status: string, method = pending.method, evidence: Record<string, unknown> = pending.evidence) => ({
  company_id: company, government_entity_id: entity, match_status: status, match_method: method, confidence: .98, evidence,
});
beforeEach(() => vi.clearAllMocks());
describe("atomic federal identity storage receipts", () => {
  it("sends all identifiers together instead of accepting the first matching key", async () => {
    const input = { uei: "ABCDEFGHIJKL", cage_code: "1AB23", usaspending_recipient_id: "recipient-1", legal_name: "Acme", source: "SAM.gov" };
    mocks.rpc.mockResolvedValue({ data: entity, error: null });
    expect(await saveGovernmentEntity(input)).toBe(entity);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("government_identity_save_entity", { p_entity: { ...input, payload_hash: stableHash(input) } });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "conflicting stored government identifiers" } });
    await expect(saveGovernmentEntity(input)).rejects.toThrow("conflicting stored government identifiers");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("returns the actual preserved verified decision, including its native evidence", async () => {
    const native = { provider_result: { answers: { identity: { choice: "same_legal_entity" } } } };
    mocks.rpc.mockResolvedValue({ data: { disposition: "preserved_verified", match: saved("verified", "jev_identity", native) }, error: null });
    expect(await saveCompanyGovernmentMatch(company, entity, pending)).toEqual({ status: "verified", method: "jev_identity", confidence: .98, evidence: native });
  });
  it("refuses an attempted upgrade of an explicitly rejected relationship", async () => {
    mocks.rpc.mockResolvedValue({ data: { disposition: "preserved_rejected", match: saved("rejected", "manual") }, error: null });
    await expect(saveCompanyGovernmentMatch(company, entity, { ...pending, status: "verified", method: "jev_identity" })).rejects.toThrow("explicitly rejected");
    expect((await saveCompanyGovernmentMatch(company, entity, { ...pending, status: "rejected" })).status).toBe("rejected");
  });
  it("retains a new negative native decision without calling it a persistence failure", async () => {
    mocks.rpc.mockResolvedValue({ data: { disposition: "inserted", match: saved("rejected", "jev_different") }, error: null });
    expect((await saveCompanyGovernmentMatch(company, entity, { ...pending, status: "rejected", method: "jev_different" })).status).toBe("rejected");
  });
  it.each([{ company_id: "different" }, { government_entity_id: "different" }, { confidence: null }, { evidence: [] }, { match_status: "other" }])("rejects mismatched or malformed readbacks: %j", async (patch) => {
    mocks.rpc.mockResolvedValue({ data: { disposition: "updated", match: { ...saved("verified"), ...patch } }, error: null });
    await expect(saveCompanyGovernmentMatch(company, entity, pending)).rejects.toThrow("invalid identity receipt");
  });
});
