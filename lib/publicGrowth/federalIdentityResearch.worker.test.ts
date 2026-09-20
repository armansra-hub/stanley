import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), detail: vi.fn(), saveAward: vi.fn(), bind: vi.fn(), updates: [] as any[], receipts: [] as any[],
  sourceCurrent: true, claim: null as any, prior: null as any }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({
  rpc: (...args: any[]) => mocks.bind(...args),
  from(table: string) {
    let update: any, upsert: any, list = false;
    const result = () => {
      if (update) { mocks.updates.push({ table, payload: structuredClone(update) }); if (table === "company_federal_identity_claims") Object.assign(mocks.claim,structuredClone(update)); }
      if (upsert) mocks.receipts.push(structuredClone(upsert));
      return { error: null, data: table === "intelligence_observations" ? list ? [] : { is_current: mocks.sourceCurrent, feedback_excluded: false, source_url: "https://acme.com/about" }
        : table === "federal_awards" ? mocks.prior : null };
    };
    const q = { select: () => q, eq: () => q, order: () => q, range: () => { list = true; return q; }, single: async () => result(), maybeSingle: async () => result(),
      update: (value: any) => { update = value; return q; }, upsert: (value: any) => { upsert = value; return q; },
      then: (resolve: any) => Promise.resolve(result()).then(resolve) };
    return q;
  },
}) }));
vi.mock("./usaspending", async () => ({ ...await vi.importActual("./usaspending"), searchContractAwardsPage: (...args: any[]) => mocks.search(...args), fetchAwardDetail: (...args: any[]) => mocks.detail(...args) }));
vi.mock("./storage", async () => ({ ...await vi.importActual("./storage"), saveFederalAward: (...args: any[]) => mocks.saveAward(...args) }));
import { advanceIdentityClaim } from "./federalIdentityResearch";
const company = { id: "company", name: "Acme", domain: "acme.com", addresses: [{ addressLine1: "100 Main Street", city: "Austin", state: "TX", postalCode: "78701", sourceKind: "netsuite_record" as const, sourceId: "private", capturedAt: "2026-09-19" }] };
const row = (uei: string) => ({ generatedId: `award-${uei}`, recipientName: "Acme Legal LLC", recipientUei: uei });
describe("identity recipient checkpoint path", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.updates = []; mocks.receipts = []; mocks.sourceCurrent = true; mocks.prior = null;
    mocks.claim = { id: "claim", company_id: "company", observation_id: "obs", candidate_name: "Acme Legal LLC", subject_name: "Acme", relationship: "legal_name",
      source_url: "https://acme.com/about", captured_at: "2026-09-19", evidence: { candidate: { candidateName: "Acme Legal LLC" } }, recipient_cursor: {} };
    mocks.search.mockResolvedValue({ rows: [row("ABCDEFGHIJKL"), row("ZYXWVUTSRQPO")], hasNext: false });
    mocks.bind.mockResolvedValue({ data: "entity", error: null });
    mocks.detail.mockImplementation(async (id: string) => ({ generated_unique_award_id: id, piid: id,
      recipient: { recipient_name: "Acme Legal LLC", recipient_uei: id.replace("award-", ""), recipient_hash: `recipient-${id}`,
        location: { address_line1: "100 Main St", city_name: "Austin", state_code: "TX", zip5: "78701", location_country_code: "USA" } } }));
  });
  it("enrolls two legitimately supported UEIs on separate resumable calls without repeating the source page", async () => {
    expect(await advanceIdentityClaim(company, mocks.claim,"lease",Date.now()+100000)).toMatchObject({ pending: true, status: "direct_recipient_enrolled", historyComplete: false });
    expect(mocks.claim.recipient_cursor.queue.map((r: any) => r.recipientUei)).toEqual(["ZYXWVUTSRQPO"]);
    expect(mocks.claim.recipient_cursor.seenUeis).toEqual(["ABCDEFGHIJKL"]);
    await advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000);
    expect(mocks.search).toHaveBeenCalledTimes(1); expect(mocks.detail).toHaveBeenCalledTimes(2); expect(mocks.bind).toHaveBeenCalledTimes(2);
    expect(mocks.receipts.map(row => row.uei)).toEqual(["ABCDEFGHIJKL","ZYXWVUTSRQPO"]);
    expect(mocks.claim.recipient_cursor.collection).toBe("idvs");
    mocks.search.mockResolvedValue({ rows: [], hasNext: false });
    expect(await advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000)).toMatchObject({ pending: false, completeSearch: true, historyComplete: false });
  });
  it("records unsupported recipient evidence and proceeds to the next distinct candidate", async () => {
    mocks.detail.mockResolvedValueOnce({ generated_unique_award_id: "award-ABCDEFGHIJKL", recipient: { recipient_name: "Acme Legal LLC", recipient_uei: "ABCDEFGHIJKL", recipient_hash: "different", location: { address_line1: "900 Wrong Road", city_name: "Austin", state_code: "TX", zip5: "78701" } } });
    expect(await advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000)).toMatchObject({ status: "recipient_needs_evidence", pending: true });
    expect(mocks.bind).not.toHaveBeenCalled(); expect(mocks.saveAward).not.toHaveBeenCalled();
    await advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000);
    expect(mocks.bind).toHaveBeenCalledTimes(1); expect(mocks.receipts).toHaveLength(2);
  });
  it("refuses a changed recipient before writes and leaves the exact candidate unconsumed", async () => {
    mocks.detail.mockResolvedValue({ generated_unique_award_id: "award-ABCDEFGHIJKL", recipient: { recipient_name: "Acme Legal LLC", recipient_uei: "QQQQQQQQQQQQ" } });
    await expect(advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000)).rejects.toThrow("identity_candidate_changed");
    expect(mocks.bind).not.toHaveBeenCalled(); expect(mocks.updates).toEqual([]);
  });
  it("parks withdrawn source evidence without provider requests or enrollment", async () => {
    mocks.sourceCurrent = false;
    expect(await advanceIdentityClaim(company,mocks.claim,"lease",Date.now()+100000)).toEqual({ pending: false, status: "source_changed" });
    expect(mocks.claim.status).toBe("needs_evidence"); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled();
  });
});
