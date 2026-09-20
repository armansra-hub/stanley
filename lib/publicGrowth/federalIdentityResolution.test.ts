import { describe, expect, it, vi } from "vitest";
import { nativeJevFingerprint, type NativeJevInput } from "@/lib/intelligence/nativeJev";
import { buildJevIdentityRequest, resolveJevIdentityCandidates, type JevIdentityArguments } from "./jevIdentity";
import { federalIdentitySourcesFromObservation, FederalIdentityDeferredError, resolveFederalIdentity, type FederalIdentityObservation } from "./federalIdentityResolution";

const company = { id: "account", name: "Acme", domain: "acme.com", addresses: [] };
const candidate = { legalName: "Acme LLC", uei: "ABCDEFGHIJKL", addressLine1: "100 Main Street", addressLine2: "Suite 100", city: "Austin", state: "TX", postalCode: "78701" };
const observation: FederalIdentityObservation = { id: "obs-a", source_url: "https://acme.com/contact", evidence_text: "Contact Acme LLC. Our headquarters is 100 Main Street, Suite 100, Austin, TX 78701." };

describe("stored federal identity source coverage", () => {
  it("admits verbatim named contact evidence without inventing legal-name relationships", () => {
    const sources = federalIdentitySourcesFromObservation(company, observation);
    expect(sources).toEqual([expect.objectContaining({ id: "obs-a", subjectName: "Acme", candidateName: "Acme", quote: observation.evidence_text })]);
    const exact = buildJevIdentityRequest({ company, candidates: [{ ...candidate, id: "candidate" }], sources });
    expect(exact.sources).toHaveLength(1);
    const anotherLegalName = buildJevIdentityRequest({ company, candidates: [{ ...candidate, id: "candidate", legalName: "Acme Holding LLC" }], sources });
    expect(anotherLegalName.sources).toEqual([]);
  });
  it("keeps already captured firstparty structured addresses with their real observed names", () => {
    const source = { ...observation, evidence_text: "About Acme", metadata: { companyIdentity: { names: ["Acme LLC"],
      addresses: [{ addressLine1: "100 Main Street", addressLine2: "Suite 100", city: "Austin", state: "TX", postalCode: "78701", capturedAt: "not material" }] } } };
    const sources = federalIdentitySourcesFromObservation(company, source);
    expect(sources).toHaveLength(1);
    expect(JSON.parse(sources[0].quote)).toEqual({ observedCompanyIdentity: { names: ["Acme LLC"], address: {
      addressLine1: "100 Main Street", addressLine2: "Suite 100", city: "Austin", state: "TX", postalCode: "78701" } } });
    expect(sources[0].quote).not.toContain("not material");
  });
  it("reuses identical named metadata repeated on another same-site page while retaining every source receipt", () => {
    const identity = { names: ["Acme LLC"], addresses: [{ addressLine1: "100 Main Street", city: "Austin" }] };
    const first = federalIdentitySourcesFromObservation(company, { ...observation, evidence_text: "About Acme", metadata: { companyIdentity: identity } });
    const later = federalIdentitySourcesFromObservation(company, { ...observation, id: "obs-b", source_url: "https://acme.com/news/unrelated-new-story",
      evidence_text: "A new article.", metadata: { companyIdentity: identity } });
    const initialPacket = buildJevIdentityRequest({ company, candidates: [{ ...candidate, id: "candidate" }], sources: first });
    const repeatedPacket = buildJevIdentityRequest({ company, candidates: [{ ...candidate, id: "candidate" }], sources: [...first, ...later] });
    expect(nativeJevFingerprint(initialPacket.input)).toBe(nativeJevFingerprint(repeatedPacket.input));
    expect(repeatedPacket.sources).toHaveLength(1);
    expect(repeatedPacket.sources[0].originalIds).toEqual(["obs-a", "obs-b"]);
    expect(repeatedPacket.sources[0].originalUrls).toEqual([observation.source_url, "https://acme.com/news/unrelated-new-story"]);
  });
  it("uses a real account-anchored UEI or CAGE passage without requiring an address", () => {
    expect(federalIdentitySourcesFromObservation(company, { ...observation, source_url: "https://acme.com/capabilities-statement",
      evidence_text: "Acme LLC Federal Capabilities. UEI ABCDEFGHIJKL. CAGE 12345." })).toEqual([
      expect.objectContaining({ quote: "Acme LLC Federal Capabilities. UEI ABCDEFGHIJKL. CAGE 12345." }),
    ]);
  });
  it.each([
    { ...observation, source_url: "https://another.example/contact" },
    { ...observation, evidence_text: "Contact Another Company LLC. 100 Main Street, Austin TX." },
    { ...observation, evidence_text: "Acme provides professional business services." },
    { ...observation, source_url: "https://acme.com/news/customer-project" },
    { ...observation, evidence_text: "About Acme", metadata: { companyIdentity: { names: ["A Client LLC"], addresses: [{ addressLine1: "100 Main Street" }] } } },
  ])("does not turn irrelevant publisher/name/marketing content into usable identity evidence (%j)", input => {
    expect(federalIdentitySourcesFromObservation(company, input)).toEqual([]);
  });
  it("retains separately located identity passages rather than replacing the whole page with the first match", () => {
    const content = "Acme LLC UEI ABCDEFGHIJKL." + " filler ".repeat(400) + "Acme LLC headquarters moved to 900 West Road in 2026.";
    const sources = federalIdentitySourcesFromObservation(company, { ...observation, evidence_text: content });
    expect(sources).toHaveLength(2);
    expect(sources.every(source => source.quote.length <= 1800 && content.includes(source.quote))).toBe(true);
    expect(sources.some(source => source.quote.includes("headquarters moved"))).toBe(true);
  });
});

describe("federal identity resolver integration", () => {
  it("bypasses source loading and Jev for an established exact name and domain match", async () => {
    const loadSources = vi.fn(), resolve = vi.fn();
    const result = await resolveFederalIdentity(company, { ...candidate, domain: "acme.com" }, {}, { loadSources, resolve });
    expect(result).toMatchObject({ status: "verified", method: "domain" });
    expect(loadSources).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  });
  it("preserves a free unresolved decision when no useful source exists", async () => {
    const provider = vi.fn();
    const resolve = vi.fn((input: JevIdentityArguments) => resolveJevIdentityCandidates(input, { evaluate: provider }));
    const loadSources = vi.fn(async () => []);
    const result = await resolveFederalIdentity(company, candidate, {}, { loadSources, resolve });
    expect(loadSources).toHaveBeenCalledTimes(1); expect(provider).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "pending", method: "jev_insufficient", evidence: { jevIdentity: {
      candidateId: "uei:ABCDEFGHIJKL", outcome: "insufficient_evidence", nativeJev: null } } });
  });
  it("uses caller-loaded evidence and stable official IDs regardless of the award that discovered the recipient", async () => {
    const inputs: JevIdentityArguments[] = [], sources = federalIdentitySourcesFromObservation(company, observation);
    const resolve = vi.fn(async (input: JevIdentityArguments) => {
      inputs.push(input);
      return resolveJevIdentityCandidates({ ...input, sources: [] });
    });
    const loadSources = vi.fn();
    for (const award of ["award-a", "award-b"]) await resolveFederalIdentity(company, { ...candidate, id: award, sourceUrl: `https://usaspending.gov/${award}` }, { sources }, { loadSources, resolve });
    expect(loadSources).not.toHaveBeenCalled();
    expect(inputs.map(input => input.candidates[0].id)).toEqual(["uei:ABCDEFGHIJKL", "uei:ABCDEFGHIJKL"]);
    expect(nativeJevFingerprint(buildJevIdentityRequest(inputs[0]).input)).toBe(nativeJevFingerprint(buildJevIdentityRequest(inputs[1]).input));
  });
  it("returns the exact native proof nesting required by the existing SQL binding contract", async () => {
    const evaluate = vi.fn(async (input: NativeJevInput) => ({ status: "complete" as const, reused: false,
      evaluation: { ok: true as const, usage: { inputTokens: 100, outputTokens: 10 }, provider_result: { model: "jev-1.13.0",
        answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => [id, { type: "choice" as const,
          choice: id.endsWith("_relation") ? "same_company" : Object.keys(question.criteria ?? {}).find(key => key.startsWith("s_"))! }])) } } }));
    const result = await resolveFederalIdentity(company, candidate, { sources: federalIdentitySourcesFromObservation(company, observation) },
      { resolve: input => resolveJevIdentityCandidates(input, { evaluate }) });
    expect(result).toMatchObject({ status: "verified", method: "jev_identity", confidence: 0, evidence: { jevIdentity: {
      outcome: "same_company", decision: { evidence: { sourceGrounded: true } }, nativeJev: { answers: expect.any(Object) },
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), supportingSourceIds: ["obs-a"],
    } } });
  });
  it.each(["busy", "budget_deferred", "deadline", "provider_unavailable"] as const)("throws a resumable %s outcome without manufacturing a rejection", async reason => {
    const resolve = vi.fn(async (input: JevIdentityArguments) => ({ status: "deferred" as const, decisions: [], reason,
      remainingCandidateIds: input.candidates.map(candidate => candidate.id) }));
    await expect(resolveFederalIdentity(company, candidate, { sources: [] }, { resolve })).rejects.toEqual(new FederalIdentityDeferredError(reason));
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("preserves source loading failures so the caller cannot consume an unexamined candidate", async () => {
    const resolve = vi.fn(), loadSources = vi.fn(async () => { throw new FederalIdentityDeferredError("source_read_unavailable"); });
    await expect(resolveFederalIdentity(company, candidate, {}, { loadSources, resolve })).rejects.toThrow("source_read_unavailable");
    expect(resolve).not.toHaveBeenCalled();
  });
});
