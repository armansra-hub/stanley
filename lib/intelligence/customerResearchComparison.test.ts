import { describe, expect, it } from "vitest";
import { compareCustomerResearch, customerResearchComparisonFacts, type CustomerProspectResearch } from "./customerResearchComparison";
import { customerCharacteristicVersion, customerResearchTextHash, normalizeCustomerResearchProfile, normalizeCustomerResearchTaxonomy,
  projectCustomerResearchProfile, type CustomerResearchFact } from "./customerResearchProfiles";
const timestamp = "2026-09-29T12:00:00Z";
function fixture() {
  const text = "We arrange freight. We do not own trucks. We deliver recurring services.", hash = customerResearchTextHash(text);
  const noFleet = { id: "no_fleet", label: "Non-asset transport", applicability: { scope: "industry" as const, industryIds: ["transportation"] },
    predicate: "The target explicitly does not own trucks.", evidenceRules: ["Explicit ownership evidence required."], exclusions: ["Brokerage alone does not establish this."],
    positiveExamples: [{ kind: "illustrative" as const, scenario: "We do not own trucks.", explanation: "Direct ownership statement." }],
    negativeExamples: [{ kind: "illustrative" as const, scenario: "Our trucks deliver freight.", explanation: "Owned truck fleet." }],
    customerSupport: [{ customerId: "customer", factId: "no-fleet" }] };
  const recurring = { ...noFleet, id: "recurring", label: "Recurring services", applicability: { scope: "universal" as const },
    predicate: "The target provides recurring services.", customerSupport: [{ customerId: "customer", factId: "recurring" }] };
  const citation = (quote: string) => ({ sourceId: "source", textSha256: hash, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote, role: "supporting" as const });
  const baseFact: CustomerResearchFact = { id: "industry", label: "Industry", value: "transportation", kind: "industry", subject: { kind: "customer", name: "Example" },
    state: "supported", explanation: "Freight services establish the transportation industry.", citations: [citation("We arrange freight.")] };
  const profile = normalizeCustomerResearchProfile({ schema: "customer-research-v1", customerId: "customer", name: "Example", website: "https://example.com/",
    announcementIds: ["announcement"], author: { kind: "codex", name: "Codex", authoredAt: timestamp }, observedAt: timestamp, completedAt: timestamp,
    discovery: { status: "complete", methods: [{ id: "navigation", kind: "navigation", url: "https://example.com/", observedAt: timestamp, outcome: "read", note: "Synthetic one-page site." }],
      pages: [{ url: "https://example.com/", discoveredBy: ["navigation"], outcome: "captured", sourceId: "source" }], notes: [] },
    sources: [{ id: "source", url: "https://example.com/", resolvedUrl: "https://example.com/", title: "Example", kind: "company_website", observedAt: timestamp,
      readAt: timestamp, text, textSha256: hash, capture: "full_observed_text" }],
    facts: [baseFact, { ...baseFact, id: "no-fleet", label: noFleet.label, value: "No owned fleet", kind: "characteristic", citations: [citation("We do not own trucks.")],
      characteristic: { id: noFleet.id, definitionVersion: customerCharacteristicVersion(noFleet) } },
    { ...baseFact, id: "recurring", label: recurring.label, value: "Recurring services", kind: "characteristic", citations: [citation("We deliver recurring services.")],
      characteristic: { id: recurring.id, definitionVersion: customerCharacteristicVersion(recurring) } }],
    summary: "A non-asset freight provider with recurring services.", sourceGaps: [] });
  const taxonomy = normalizeCustomerResearchTaxonomy({ schema: "customer-characteristics-v1", id: "library", author: profile.author, status: "approved",
    cohort: { customerIds: ["customer"], registryAsOf: timestamp, announcementThrough: timestamp }, definitions: [noFleet, recurring], researchNotes: [] }, [profile]);
  const prospect: CustomerProspectResearch = { companyId: "prospect", evidenceKey: "exact-current-evidence", industryIds: ["transportation"],
    sources: [{ id: "source", url: "https://prospect.example/", observedAt: timestamp, text, textSha256: hash }], answers: Object.fromEntries(taxonomy.definitions.map(definition => [definition.id, {
      definitionVersion: definition.definitionVersion, evidenceKey: "exact-current-evidence",
      nativeResult: { questionId: definition.id, answer: { type: "choice", choice: "supported", probabilities: { supported: 0.91 } }, requestFingerprint: "unchanged-native-receipt" },
      citations: [{ sourceId: "source", textSha256: hash, start: 0, end: text.length }],
    }])) };
  return { taxonomy, customerProofs: [projectCustomerResearchProfile(profile)], prospect };
}
describe("authored customer facts compared with current native prospect classification", () => {
  it("preserves both authors and exact native receipts without an invented probability or judge", () => {
    const input = fixture(), native = input.prospect.answers.no_fleet!.nativeResult;
    const output = compareCustomerResearch(input), fact = output.matches[0].shared.find(fact => fact.characteristicId === "no_fleet")!;
    expect(output.providerCalls).toBe(0);
    expect(fact.customer).toMatchObject({ origin: "codex_research", author: { kind: "codex" } });
    expect(fact.prospect.nativeResult).toBe(native); expect(fact.customer).not.toHaveProperty("nativeResult");
    expect(fact.prospect.citations[0].quote).toBe(input.prospect.sources[0].text);
  });
  it("includes universal patterns when selecting all patterns in an explicitly known industry", () => {
    const output = compareCustomerResearch({ ...fixture(), industryId: "transportation" });
    expect(output.matches[0].shared.map(fact => fact.characteristicId).sort()).toEqual(["no_fleet", "recurring"]);
    expect(compareCustomerResearch({ ...fixture(), industryId: "software" }).matches).toEqual([]);
  });
  it("does not guess industry, but keeps universal patterns available without an industry filter", () => {
    const input = fixture(); input.prospect.industryIds = null;
    const output = compareCustomerResearch(input);
    expect(output.matches[0].shared.map(fact => fact.characteristicId)).toEqual(["recurring"]);
    expect(output.characteristics.find(item => item.id === "no_fleet")).toMatchObject({ applicability: "unknown", prospectState: "supported" });
    expect(compareCustomerResearch({ ...input, industryId: "transportation" }).matches).toEqual([]);
  });
  it.each(["draft", "unfinished"])("rejects %s reference libraries instead of calling a sample complete", scenario => {
    const input = fixture();
    if (scenario === "draft") input.taxonomy.status = "draft";
    else input.taxonomy.cohort.customerIds.push("not-read");
    expect(() => compareCustomerResearch(input)).toThrow();
  });
  it("accounts for unresolved customers while excluding their partial facts from matches and support", () => {
    const input = fixture(), unresolved = structuredClone(input.customerProofs[0]);
    unresolved.customerId = "unresolved"; unresolved.status = "unresolved";
    unresolved.sourceGaps = ["Exact customer identity could not be established after public search."];
    unresolved.facts.forEach(fact => { fact.customerId = unresolved.customerId; fact.researchStatus = "unresolved"; });
    input.customerProofs.push(unresolved); input.taxonomy.cohort.customerIds.push(unresolved.customerId);
    expect(customerResearchComparisonFacts(unresolved)).toEqual([]);
    expect(compareCustomerResearch(input).matches.map(match => match.customerId)).toEqual(["customer"]);
    input.taxonomy.definitions[0].customerSupport.push({ customerId: "unresolved", factId: "no-fleet" });
    expect(() => compareCustomerResearch(input)).toThrow("customer_definition_support_invalid");
  });
  it.each(["stale_definition", "changed_evidence", "missing_answer", "invalid_native_citation"])("shows %s as unknown, not a negative or a paid retry", reason => {
    const input = fixture();
    if (reason === "stale_definition") input.prospect.answers.no_fleet!.definitionVersion = "old";
    if (reason === "changed_evidence") input.prospect.answers.no_fleet!.evidenceKey = "old";
    if (reason === "missing_answer") delete input.prospect.answers.no_fleet;
    if (reason === "invalid_native_citation") input.prospect.answers.no_fleet!.citations[0].end += 1000;
    const output = compareCustomerResearch(input);
    expect(output.characteristics.find(item => item.id === "no_fleet")).toMatchObject({ prospectState: "unknown", reason, matchedCustomers: 0 });
    expect(output.providerCalls).toBe(0);
  });
  it("keeps conflicting native evidence distinct from a negative decision", () => {
    const input = fixture(); input.prospect.answers.no_fleet!.nativeResult.answer.choice = "conflicting";
    const output = compareCustomerResearch(input);
    expect(output.characteristics.find(item => item.id === "no_fleet")).toMatchObject({ prospectState: "conflicting", matchedCustomers: 0 });
  });
  it("reuses compatible legacy insufficient evidence as unknown without rewriting its native answer", () => {
    const input = fixture(), answer = input.prospect.answers.no_fleet!;
    answer.nativeResult.answer.choice = "insufficient_evidence"; answer.citations = [];
    const raw = structuredClone(answer.nativeResult);
    const output = compareCustomerResearch(input);
    expect(output.characteristics.find(item => item.id === "no_fleet")).toMatchObject({ prospectState: "unknown", reason: "native_answer", matchedCustomers: 0 });
    expect(output.characteristics.find(item => item.id === "no_fleet")?.nativeResult).toBe(answer.nativeResult);
    expect(answer.nativeResult).toEqual(raw);
    expect(answer.nativeResult.answer.choice).toBe("insufficient_evidence");
    answer.evidenceKey = "different-evidence";
    expect(compareCustomerResearch(input).characteristics.find(item => item.id === "no_fleet")?.reason).toBe("changed_evidence");
    expect(output.providerCalls).toBe(0);
  });
  it("does not promote subsidiary facts or a source-less saved statement into customer support", () => {
    const input = fixture(); input.customerProofs[0].facts.find(fact => fact.id === "no-fleet")!.subject.kind = "subsidiary";
    expect(() => compareCustomerResearch(input)).toThrow("customer_definition_support_invalid");
    const second = fixture(); second.customerProofs[0].facts.find(fact => fact.id === "no-fleet")!.citations = [];
    expect(customerResearchComparisonFacts(second.customerProofs[0]).some(fact => fact.id === "no-fleet")).toBe(false);
  });
  it("supports exact characteristic selections, never silently ignores unknown selection IDs", () => {
    const input = fixture();
    expect(compareCustomerResearch({ ...input, characteristicIds: ["no_fleet"] }).matches[0].shared).toHaveLength(1);
    expect(() => compareCustomerResearch({ ...input, characteristicIds: ["not-real"] })).toThrow("unknown_customer_characteristic");
  });
  it("display-only renaming does not invalidate already-paid classification", () => {
    const input = fixture(); input.taxonomy.definitions.find(definition => definition.id === "no_fleet")!.label = "No owned transport fleet";
    const output = compareCustomerResearch(input);
    expect(output.matches[0].shared.find(fact => fact.characteristicId === "no_fleet")!.label).toBe("No owned transport fleet");
  });
});
