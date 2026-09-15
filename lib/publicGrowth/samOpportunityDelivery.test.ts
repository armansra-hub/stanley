import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: h.from }) }));
import { verifySamDeliveryRelationship } from "./samOpportunityDelivery";
import type { SamQueuedNotice } from "./samOpportunitySource";
const company = "11111111-1111-4111-8111-111111111111", matchId = "22222222-2222-4222-8222-222222222222", entityId = "33333333-3333-4333-8333-333333333333", awardId = "44444444-4444-4444-8444-444444444444";
const award = () => ({ id: awardId, government_entity_id: entityId, awarding_agency: "Agency", awarding_office: "Office", naics_code: "123456", psc_code: "AA" });
type Candidate = SamQueuedNotice["candidates"][number][1];
const incumbent = (): Candidate => ({ relationship: "incumbent_recompete", confidence: 0.92, evidence: { method: "verified_incumbent_agency_naics_plus_office_or_psc", verifiedMatchId: matchId, governmentEntityId: entityId, incumbentAward: award() } });
let linkResult: unknown, awardResult: unknown, filters: Array<[string, string, unknown]>;
beforeEach(() => {
  h.from.mockReset(); filters = [];
  linkResult = { data: { id: matchId, company_id: company, government_entity_id: entityId, government_entities: { uei: "UEI", legal_name: "Example", dba_name: null, city: "Denver", state: "CO" } }, error: null };
  awardResult = { data: award(), error: null };
  h.from.mockImplementation((table: string) => {
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([table, key, value]); return query; }, maybeSingle: async () => table === "company_government_matches" ? linkResult : awardResult };
    return query;
  });
});
describe("frozen SAM candidate relationship verification", () => {
  it("reads only its exact verified relationship and matching award, allowing unrelated index changes", async () => {
    await expect(verifySamDeliveryRelationship(company, incumbent())).resolves.toBeUndefined();
    expect(filters).toEqual(expect.arrayContaining([["company_government_matches", "id", matchId], ["company_government_matches", "company_id", company],
      ["company_government_matches", "government_entity_id", entityId], ["company_government_matches", "match_status", "verified"], ["federal_awards", "id", awardId]]));
    expect(h.from).toHaveBeenCalledTimes(2);
  });
  it("rejects missing/unverified relationships and database read failures before checking awards", async () => {
    for (const result of [{ data: null, error: null }, { data: null, error: { message: "aborted" } }]) {
      h.from.mockClear(); linkResult = result;
      await expect(verifySamDeliveryRelationship(company, incumbent())).rejects.toThrow(/no longer verified/); expect(h.from).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects changed incumbent matching facts but accepts unchanged JSONB key reordering", async () => {
    awardResult = { data: { ...award(), awarding_office: "Changed" }, error: null };
    await expect(verifySamDeliveryRelationship(company, incumbent())).rejects.toThrow(/matching facts changed/);
    awardResult = { data: Object.fromEntries(Object.entries(award()).reverse()), error: null };
    await expect(verifySamDeliveryRelationship(company, incumbent())).resolves.toBeUndefined();
  });
  it("keeps exact UEI identity binding without requiring unrelated legal-name equality", async () => {
    const candidate: Candidate = { relationship: "awardee", confidence: 1, evidence: { method: "exact_awardee_uei", verifiedMatchId: matchId, governmentEntityId: entityId, uei: "UEI" } };
    await expect(verifySamDeliveryRelationship(company, candidate)).resolves.toBeUndefined();
    candidate.evidence.uei = "OTHER"; await expect(verifySamDeliveryRelationship(company, candidate)).rejects.toThrow(/UEI changed/);
  });
  it("keeps all name-and-location matching facts bound for name-based awardees", async () => {
    const candidate: Candidate = { relationship: "awardee", confidence: 0.97, evidence: { method: "verified_legal_name_and_location", verifiedMatchId: matchId, governmentEntityId: entityId,
      sourceIdentity: { legal_name: "Example", dba_name: null, city: "Denver", state: "CO" } } };
    await expect(verifySamDeliveryRelationship(company, candidate)).resolves.toBeUndefined();
    candidate.evidence.sourceIdentity = { legal_name: "Example", dba_name: null, city: "Dallas", state: "TX" };
    await expect(verifySamDeliveryRelationship(company, candidate)).rejects.toThrow(/name or location changed/);
  });
  it("rejects missing exact IDs, mismatched returned identities and unsupported relationship methods", async () => {
    const missing = incumbent(); delete missing.evidence.verifiedMatchId;
    await expect(verifySamDeliveryRelationship(company, missing)).rejects.toThrow(/lacks its exact/); expect(h.from).not.toHaveBeenCalled();
    const wrong = incumbent(); wrong.evidence.method = "name-only";
    await expect(verifySamDeliveryRelationship(company, wrong)).rejects.toThrow(/Unsupported/);
    linkResult = { data: { id: matchId, company_id: "other", government_entity_id: entityId }, error: null };
    await expect(verifySamDeliveryRelationship(company, incumbent())).rejects.toThrow(/no longer verified/);
  });
});
