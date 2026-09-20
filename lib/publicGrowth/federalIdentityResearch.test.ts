import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { accountIdentityCandidates, candidateAccount, isWeakHistoricalMatch, readIdentityRecipientCursor } from "./federalIdentityResearch";
import { decideIdentityMatch } from "./identity";

const company = { id: "a", name: "Acme", domain: "acme.example", addresses: [{ addressLine1: "100 Main Street", city: "Austin", state: "TX", postalCode: "78701", sourceKind: "netsuite_record" as const, sourceId: "private-record", capturedAt: "2026-09-19" }] };
const candidate = { subjectName: "Acme", candidateName: "Acme West LLC", relationshipHint: "subsidiary" as const,
  sourceQuote: "Acme owns Acme West LLC.", sourceFormat: "visible" as const };
const claim = { id: "claim", company_id: "a", observation_id: "obs", candidate_name: "Acme West LLC", subject_name: "Acme", relationship: "subsidiary" as const,
  source_url: "https://acme.example/about", captured_at: "2026-09-19", evidence: { candidate }, recipient_cursor: {} };
describe("sourced federal identity research boundaries", () => {
  it("uses official externally discovered pages while rejecting unrelated publishers and unanchored declarations", () => {
    const observation = { id: "obs", source_url: claim.source_url, observed_at: claim.captured_at, evidence_text: candidate.sourceQuote,
      metadata: { researchPurpose: "identity_company_family", identityClaims: [candidate] } };
    expect(accountIdentityCandidates(company, observation)).toHaveLength(1);
    expect(accountIdentityCandidates(company, { ...observation, source_url: "https://news.example/acme" })).toEqual([]);
    expect(accountIdentityCandidates(company, { ...observation, evidence_text: "Nothing here", metadata: { identityClaims: [{ ...candidate, subjectName: "Customer" }] } })).toEqual([]);
  });
  it("never lends CRM addresses to related entities; own public address can bind a distinct recipient", () => {
    const recipient = { legalName: "Acme West LLC", addressLine1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" };
    expect(candidateAccount(company, claim).addresses).toEqual([]);
    expect(decideIdentityMatch(candidateAccount(company, claim), recipient).status).not.toBe("verified");
    const withAddress = { ...claim, evidence: { candidate: { ...candidate, candidateAddress: { addressLine1: "100 Main Street", city: "Austin", state: "TX", postalCode: "78701" } } } };
    expect(decideIdentityMatch(candidateAccount(company, withAddress), recipient)).toMatchObject({ status: "verified", method: "exact_name_address" });
  });
  it("direct aliases may use authorized identity evidence while match output contains no private address", () => {
    const direct = { ...claim, relationship: "legal_name" as const };
    const decision = decideIdentityMatch(candidateAccount(company, direct), { legalName: "Acme West LLC", addressLine1: "100 Main St", city: "Austin", state: "TX", postalCode: "78701" });
    expect(decision.status).toBe("verified"); expect(JSON.stringify(decision)).not.toContain("100 Main");
    expect(JSON.stringify(decision)).toContain("private-record");
  });
  it("identifies weak legacy methods, preserving identifier matches and modern supported matches", () => {
    for (const method of ["name_only", "exact_name_state", "exact_name_city_state", "exact_name_address", "domain", "domain_only"]) expect(isWeakHistoricalMatch({ match_method: method })).toBe(true);
    expect(isWeakHistoricalMatch({ match_method: "verified_identifier" })).toBe(false);
    expect(isWeakHistoricalMatch({ match_method: "domain", evidence: { nameMatch: true, domainMatch: true } })).toBe(false);
    expect(isWeakHistoricalMatch({ match_method: "exact_name_address", evidence: { nameMatch: true, addressMatch: true, addressEvidence: [{ streetMatch: true, supportsIdentity: true }] } })).toBe(false);
  });
  it("persists distinct UEI candidates without treating multiple recipients as a single ambiguous name", () => {
    const state = readIdentityRecipientCursor({});
    state.queue = ["ABCDEFGHIJKL", "ZYXWVUTSRQPO"].map((uei, i) => ({ generatedId: `award-${i}`, recipientName: "Acme", recipientUei: uei }));
    const saved = readIdentityRecipientCursor(state); expect(saved.queue).toHaveLength(2);
    saved.queue.shift(); expect(state.queue).toHaveLength(2);
    expect(() => readIdentityRecipientCursor({ ...state, queue: [{ generatedId: "a", recipientName: "Acme", recipientUei: null }] })).toThrow("invalid_identity");
  });
});
