import { describe, it, expect, vi } from "vitest";
import { normalizeRegionalRow, regionalCandidateIndex, confirmRegionalCandidate, fetchRegionalPage } from "./sources";
vi.mock("server-only", () => ({}));
const account = { id: "account", name: "Example Services Inc.", domain: "example.com" };
const sf = { source_row_id: "row-1", contract_no: "SFO-2026-00123", prime_contractor: "Example Services LLC", department: "Airport", agreed_amt: "1,000,000", pmt_amt: "2500", term_start_date: "2026-01-01" };
describe("regional disclosures", () => {
  it("keeps prime and project-team roles distinct, with shared amounts explicitly unsummed", () => {
    const facts = normalizeRegionalRow("sf_supplier_contracts", { ...sf, project_team_supplier: "Second Services", project_team_constituent: "Joint Venture Partner" });
    expect(facts).toHaveLength(2); expect(facts[0].reportedAmount).toBe(1000000);
    expect(facts[1].supplierRole).toBe("Joint Venture Partner"); expect(facts[1].amountBasis).toContain("not an allocation");
    expect(facts[0].sourceUrl).toContain("data.sf.gov/resource/");
  });
  it("preserves historical amendment scope, missing dates, and nonnumeric amounts", () => {
    const fact = normalizeRegionalRow("wa_fy2025_contracts", { source_row_id: "row-2", contractor_name_search_for: "Example Services", agency_contract_no: "C-2025-12345", agency_contract_amendment: "2", cost_of_contract: "N/A", contract_effective_end_date: "none" })[0];
    expect(fact.amendment).toBe("2"); expect(fact.reportedAmount).toBeNull(); expect(fact.endDate).toBeNull(); expect(fact.scope).toContain("Historical");
  });
  it("retrieves exact legal-name candidates without conflating subsidiaries or proving identity", () => {
    const match = regionalCandidateIndex([account, { ...account, id: "other", name: "Example Services Holdings" }]);
    const rows = match(normalizeRegionalRow("sf_supplier_contracts", sf));
    expect(rows).toHaveLength(1); expect(rows[0].companyId).toBe(account.id); expect(rows[0].identityEvidence).toBeUndefined();
  });
  it("automatically confirms only same-site exact meaningful contract, supplier and jurisdiction together", () => {
    const candidate = regionalCandidateIndex([account])(normalizeRegionalRow("sf_supplier_contracts", sf))[0];
    const row = { id: "obs", company_id: account.id, source_url: "https://www.example.com/contracts", evidence_text: "Example Services was awarded San Francisco contract SFO-2026-00123 for consulting services." };
    expect(confirmRegionalCandidate(candidate, account, [row]).identityEvidence?.observationId).toBe("obs");
    for (const changed of [{ source_url: "https://news.example.org/article" }, { company_id: "other" }, { evidence_text: row.evidence_text.replace("San Francisco", "a public") }, { evidence_text: row.evidence_text.replace("00123", "001234") }, { evidence_text: row.evidence_text.replace("Example Services", "Another Vendor") }]) {
      expect(confirmRegionalCandidate(candidate, account, [{ ...row, ...changed }]).identityEvidence).toBeUndefined();
    }
    expect(confirmRegionalCandidate({ ...candidate, fact: { ...candidate.fact, contractNumber: "7104" } }, account, [{ ...row, evidence_text: row.evidence_text.replace("SFO-2026-00123", "7104") }]).identityEvidence).toBeUndefined();
  });
  it("checkpoints stable snapshot offsets and restarts changed snapshots", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ status: 200, body: '{"rowsUpdatedAt":123}' }).mockResolvedValueOnce({ status: 200, body: JSON.stringify([{ source_row_id: "row-1" }]) });
    expect(await fetchRegionalPage("sf_supplier_contracts", { offset: 500, version: "123", complete: false }, fetch)).toMatchObject({ offset: 501, complete: true });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("$offset")).toBe("500");
    fetch.mockResolvedValueOnce({ status: 200, body: '{"rowsUpdatedAt":124}' }).mockResolvedValueOnce({ status: 200, body: "[]" });
    await fetchRegionalPage("sf_supplier_contracts", { offset: 500, version: "123", complete: false }, fetch);
    expect(new URL(fetch.mock.calls[3][0]).searchParams.get("$offset")).toBe("0");
  });
  it("does not reread unchanged completed snapshots or treat malformed transport as empty", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, body: '{"rowsUpdatedAt":123}' });
    expect(await fetchRegionalPage("sf_supplier_contracts", { offset: 0, version: "123", complete: true }, fetch)).toMatchObject({ unchanged: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce({ status: 200, body: '{"rowsUpdatedAt":123}' }).mockResolvedValueOnce({ status: 200, body: "{}" });
    await expect(fetchRegionalPage("sf_supplier_contracts", { offset: 0, version: null, complete: false }, fetch)).rejects.toThrow("invalid_response");
  });
});
