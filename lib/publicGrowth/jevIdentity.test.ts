import { describe, expect, it, vi } from "vitest";
import { nativeJevFingerprint, type NativeJevInput, type NativeProviderResult } from "@/lib/intelligence/nativeJev";
import { buildJevIdentityRequest, resolveJevIdentityCandidates, type JevIdentityArguments, type JevIdentityCandidate, type JevIdentitySource } from "./jevIdentity";

const company: JevIdentityArguments["company"] = { id: "company-1", name: "Acme Brand", domain: "acme.com", legalNames: [],
  addresses: [{ addressLine1: "1200 North Private Street Suite 200", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US",
    sourceKind: "netsuite_record", sourceId: "private-record-1", capturedAt: "2026-09-19T00:00:00Z" }] };
const candidate: JevIdentityCandidate = { id: "ABCDEFGHIJKL", uei: "ABCDEFGHIJKL", legalName: "Acme Federal LLC", domain: "acme.com",
  addressLine1: "1200 N Private St", addressLine2: "Suite 200", city: "Austin", state: "TX", postalCode: "78701", countryCode: "USA",
  sourceId: "award-a", sourceUrl: "https://usaspending.gov/award/a" };
const source: JevIdentitySource = { id: "observation-a", url: "https://acme.com/legal", subjectName: "Acme Brand", candidateName: "Acme Federal LLC",
  quote: "Acme Brand is the trading name of Acme Federal LLC.", capturedAt: "2026-09-19T00:00:00Z" };
const args: JevIdentityArguments = { company, candidates: [candidate], sources: [source] };
function response(input: NativeJevInput, relationship = "legal_name", support = true) {
  const raw: NativeProviderResult = { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 900, output_tokens: 24 }, provider_extra: "preserve" };
  for (const [id, question] of Object.entries(input.questions)) {
    const choice = id.endsWith("_relation") ? relationship : support ? Object.keys(question.criteria ?? {}).find(key => key.startsWith("s_")) ?? "none" : "none";
    raw.answers[id] = { type: "choice", choice, confidence: .31, probabilities: { [choice]: .31 }, legend: { native: "unchanged" } };
  }
  return { status: "complete" as const, reused: false, evaluation: { ok: true as const, provider_result: raw, usage: { inputTokens: 900, outputTokens: 24 } } };
}
const evaluate = (relationship = "legal_name", support = true) => vi.fn(async (input: NativeJevInput) => response(input, relationship, support));

describe("cost-effective recipient identity input", () => {
  it("reuses identical material after refetch, different award, reordered evidence and new observation IDs", () => {
    const initial = buildJevIdentityRequest(args);
    const later = buildJevIdentityRequest({ ...args, deadline: Date.now() + 5000,
      company: { ...company, addresses: company.addresses!.map(address => ({ ...address, sourceId: "new-private-record", capturedAt: "2026-12-01" })) },
      candidates: [{ ...candidate, id: "another-local-candidate-id", sourceId: "award-b", sourceUrl: "https://usaspending.gov/award/b" }],
      sources: [{ ...source, id: "observation-b", capturedAt: "2026-12-01" }, { ...source, id: "duplicate-copy" }] });
    expect(nativeJevFingerprint(initial.input)).toBe(nativeJevFingerprint(later.input));
    expect(later.sources[0].originalIds).toEqual(["duplicate-copy", "observation-b"]);
    expect(JSON.stringify(initial.input)).not.toMatch(/award-a|observation-a|2026-09-19|private-record-1/);
  });
  it("invalidates reuse for changed CRM identity facts, actual declarations or official UEI", () => {
    const original = nativeJevFingerprint(buildJevIdentityRequest(args).input);
    for (const updated of [
      { ...args, company: { ...company, addresses: [{ ...company.addresses![0], addressLine1: "1200 North Private Street Suite 201" }] } },
      { ...args, sources: [{ ...source, quote: "Acme Brand is a subsidiary of Acme Federal LLC." }] },
      { ...args, candidates: [{ ...candidate, uei: "ZZZZZZZZZZZZ" }] },
    ]) expect(nativeJevFingerprint(buildJevIdentityRequest(updated).input)).not.toBe(original);
  });
  it("reuses unchanged public address facts repeated on another firstparty page", () => {
    const first = { ...company.addresses![0], sourceKind: "company_website" as const, sourceUrl: "https://acme.com/contact" };
    const later = { ...first, sourceId: "new-observation", capturedAt: "2027-01-01", sourceUrl: "https://acme.com/news/new-article" };
    const before = buildJevIdentityRequest({ ...args, company: { ...company, addresses: [first] } });
    const after = buildJevIdentityRequest({ ...args, company: { ...company, addresses: [later, first] } });
    expect(nativeJevFingerprint(before.input)).toBe(nativeJevFingerprint(after.input));
    expect(nativeJevFingerprint(buildJevIdentityRequest({ ...args, company: { ...company, addresses: [{ ...later, addressLine1: "900 Real New Address" }] } }).input))
      .not.toBe(nativeJevFingerprint(before.input));
  });
  it("does not place raw private addresses in cached public requests", () => {
    const request = buildJevIdentityRequest({ ...args, candidates: [{ ...candidate, addressLine1: "900 Government Road", addressLine2: "Unit 4", postalCode: "78799" }] });
    const body = JSON.stringify(request.input);
    expect(body).not.toContain("1200 North Private");
    expect(body).not.toContain("Suite 200");
    expect(body).not.toContain("78701");
    expect(body).toContain("900 Government Road");
    expect(request.input.privacy).toBe("public");
    const state = request.input.state as { candidates: Array<{ crmAddressComparison: unknown[] }> };
    expect(state.candidates[0].crmAddressComparison).toEqual([expect.objectContaining({ street: "different", unit: "different", postalCode: "different", city: "same", state: "same" })]);
  });
  it("preserves normalized split-line unit agreement and treats missing unit as unknown", () => {
    const request = buildJevIdentityRequest(args);
    const state = request.input.state as { candidates: Array<{ crmAddressComparison: unknown[] }> };
    expect(state.candidates[0].crmAddressComparison[0]).toMatchObject({ street: "same", unit: "same" });
    const missing = buildJevIdentityRequest({ ...args, candidates: [{ ...candidate, addressLine2: null }] }).input.state as typeof state;
    expect(missing.candidates[0].crmAddressComparison[0]).toMatchObject({ street: "same", unit: "unknown" });
  });
});

describe("Jev recipient identity decisions", () => {
  it("uses one native request, preserves its answer, and binds only supplied source IDs without a confidence cutoff", async () => {
    const provider = evaluate();
    const result = await resolveJevIdentityCandidates(args, { evaluate: provider });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][0]).toMatchObject({ privacy: "public" });
    expect(result).toMatchObject({ status: "complete", remainingCandidateIds: [], decisions: [{ candidateId: candidate.id,
      outcome: "same_company", relationship: "legal_name", supportingSourceIds: [source.id],
      decision: { status: "verified", method: "jev_identity", confidence: .31 } }] });
    expect(result.decisions[0].nativeJev).toEqual((await provider.mock.results[0].value).evaluation.provider_result);
    expect(JSON.stringify(result.decisions[0].decision.evidence)).not.toContain("1200");
  });
  it.each(["parent", "subsidiary", "joint_venture", "division"])("keeps %s awards separately related instead of a direct match", async relationship => {
    const result = await resolveJevIdentityCandidates(args, { evaluate: evaluate(relationship) });
    expect(result.decisions[0]).toMatchObject({ outcome: "related_company", relationship, decision: { status: "pending", method: "jev_related" } });
  });
  it("keeps positive but ungrounded answers visible and unresolved", async () => {
    const result = await resolveJevIdentityCandidates(args, { evaluate: evaluate("legal_name", false) });
    expect(result.decisions[0]).toMatchObject({ outcome: "insufficient_evidence", relationship: null, supportingSourceIds: [],
      decision: { status: "pending", evidence: { reason: "missing_supporting_identity_declaration" } } });
    expect(Object.values(result.decisions[0].nativeJev!.answers).some(answer => answer.choice === "legal_name")).toBe(true);
  });
  it("distinguishes an affirmative different-company answer from missing information", async () => {
    const different = await resolveJevIdentityCandidates(args, { evaluate: evaluate("different_company", false) });
    const unknown = await resolveJevIdentityCandidates(args, { evaluate: evaluate("insufficient_evidence", false) });
    expect(different.decisions[0].decision.status).toBe("rejected");
    expect(unknown.decisions[0].decision.status).toBe("pending");
  });
  it.each([
    [], [{ ...source, url: "https://namesake.example/legal" }], [{ ...source, quote: "A customer's unrelated company mentioned Acme Brand." }],
    [{ ...source, subjectName: "Another Brand", quote: "Another Brand owns Acme Federal LLC." }],
  ].map(sources => ({ sources })))("does not spend when no supplied declaration can improve ambiguous identity (%j)", async ({ sources }) => {
    const provider = evaluate();
    const result = await resolveJevIdentityCandidates({ ...args, sources }, { evaluate: provider });
    expect(provider).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "complete", remainingCandidateIds: [], decisions: [{ outcome: "insufficient_evidence", nativeJev: null,
      decision: { status: "pending", evidence: { modelCalled: false, reason: "missing_supporting_identity_declaration" } } }] });
  });
  it("reuses the cached answer while mapping renewed observation IDs to current provenance", async () => {
    const provider = vi.fn(async (input: NativeJevInput) => ({ ...response(input), reused: true }));
    const result = await resolveJevIdentityCandidates({ ...args, sources: [{ ...source, id: "current-id" }] }, { evaluate: provider });
    expect(result.decisions[0]).toMatchObject({ reused: true, supportingSourceIds: ["current-id"] });
  });
  it.each(["busy", "budget_deferred"] as const)("preserves every candidate when %s", async status => {
    const provider = vi.fn(async () => ({ status }));
    const result = await resolveJevIdentityCandidates(args, { evaluate: provider });
    expect(result).toEqual({ status: "deferred", decisions: [], remainingCandidateIds: [candidate.id], reason: status });
  });
  it("defers provider failures or uncertain receipt errors without consuming a candidate", async () => {
    const failed = vi.fn(async () => ({ status: "complete" as const, reused: false,
      evaluation: { ok: false as const, error: { code: "typesafe_timeout", retryable: true }, usage: null } }));
    expect(await resolveJevIdentityCandidates(args, { evaluate: failed })).toMatchObject({ status: "deferred", reason: "provider_unavailable", remainingCandidateIds: [candidate.id] });
    const uncertain = vi.fn(async () => { throw new Error("Private provider body must not leak"); });
    expect(await resolveJevIdentityCandidates(args, { evaluate: uncertain })).toEqual({ status: "deferred", reason: "request_unavailable", decisions: [], remainingCandidateIds: [candidate.id] });
    expect(uncertain).toHaveBeenCalledTimes(1);
  });
  it("does not start a provider call when the bounded execution window is ending", async () => {
    const provider = evaluate();
    expect(await resolveJevIdentityCandidates({ ...args, deadline: 35_000 }, { evaluate: provider, now: () => 10_000 }))
      .toMatchObject({ status: "deferred", reason: "deadline", remainingCandidateIds: [candidate.id] });
    expect(provider).not.toHaveBeenCalled();
  });
  it("does not require a paid-call time window to return a free missing-evidence result", async () => {
    const provider = evaluate();
    expect(await resolveJevIdentityCandidates({ ...args, sources: [], deadline: 35_000 }, { evaluate: provider, now: () => 34_000 }))
      .toMatchObject({ status: "complete", remainingCandidateIds: [], decisions: [{ outcome: "insufficient_evidence", nativeJev: null }] });
    expect(provider).not.toHaveBeenCalled();
  });
  it("compares a bounded candidate set together and returns all leftovers for existing cursor continuation", async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ ...candidate, id: `candidate-${i}`, uei: `UEI${i}` }));
    const provider = evaluate();
    const result = await resolveJevIdentityCandidates({ ...args, candidates }, { evaluate: provider });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "partial", remainingCandidateIds: ["candidate-8", "candidate-9"] });
    expect(result.decisions).toHaveLength(8);
    expect(Object.keys(provider.mock.calls[0][0].questions)).toHaveLength(16);
    expect(new Set([...result.decisions.map(d => d.candidateId), ...result.remainingCandidateIds]).size).toBe(10);
  });
  it("defers an oversized declaration without truncating identity evidence or making a paid call", async () => {
    const provider = evaluate();
    expect(await resolveJevIdentityCandidates({ ...args, sources: [{ ...source, quote: source.quote + " Extra material.".repeat(4000) }] }, { evaluate: provider }))
      .toMatchObject({ status: "deferred", reason: "input_too_large", remainingCandidateIds: [candidate.id] });
    expect(provider).not.toHaveBeenCalled();
  });
});
