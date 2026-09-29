import { customerCharacteristicVersion, customerResearchTextHash, type CustomerCharacteristicDefinition,
  type CustomerResearchProof, type CustomerResearchTaxonomy } from "./customerResearchProfiles";

export type CustomerProspectNativeAnswer = {
  definitionVersion: string; evidenceKey: string;
  nativeResult: { questionId: string; answer: { type: "choice"; choice: "supported" | "not_supported" | "unknown" | "conflicting" | "insufficient_evidence";
    [key: string]: unknown }; [key: string]: unknown };
  citations: { sourceId: string; textSha256: string; start: number; end: number }[];
};
export type CustomerProspectResearch = {
  companyId: string; evidenceKey: string;
  /** Exact normalized industry IDs from prior source-backed classification;
   * null means unestablished, not a wildcard claim about the company. */
  industryIds: readonly string[] | null;
  sources: { id: string; url: string; observedAt: string; text: string; textSha256: string }[];
  answers: Record<string, CustomerProspectNativeAnswer | undefined>;
};
type CustomerFact = CustomerResearchProof["facts"][number];
type ComparisonState = Exclude<CustomerProspectNativeAnswer["nativeResult"]["answer"]["choice"], "insufficient_evidence">;
export type CustomerComparisonFact = {
  characteristicId: string; label: string; definitionVersion: string;
  customer: { origin: "codex_research"; author: CustomerResearchProof["author"]; facts: CustomerFact[] };
  prospect: { origin: "jev_native"; nativeResult: CustomerProspectNativeAnswer["nativeResult"];
    citations: { sourceId: string; url: string; observedAt: string; textSha256: string; start: number; end: number; quote: string }[] };
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeUrl = (value: string) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
const accountedFor = (proof: CustomerResearchProof) => ["complete", "complete_with_gaps", "unresolved"].includes(proof.status);

/** Compact proof was already validated against full text at admission. Here we
 * retain that provenance and verify its source manifest/citation relationships. */
export function customerResearchComparisonFacts(proof: CustomerResearchProof): CustomerFact[] {
  if (proof.schema !== "customer-research-proof-v1" || proof.sourceStorage !== "private_local_full_text"
    || proof.author.kind !== "codex" || !/^[a-f0-9]{64}$/.test(proof.fullProfileSha256)) throw new Error("invalid_customer_comparison_proof");
  if (proof.status === "unresolved") return [];
  const sources = new Map(proof.sources.map(source => [source.id, source]));
  return proof.facts.filter(fact => {
    if (fact.origin !== "codex_research" || fact.customerId !== proof.customerId || fact.author.kind !== "codex") return false;
    const support = fact.citations.some(citation => citation.role === "supporting"), contradiction = fact.citations.some(citation => citation.role === "contradicting");
    if ((fact.state === "supported" && (!support || contradiction)) || (fact.state === "not_supported" && (!contradiction || support))
      || (fact.state === "conflicting" && (!support || !contradiction)) || (fact.state === "unknown" && (support || contradiction))) return false;
    return fact.citations.every(citation => {
      const source = sources.get(citation.sourceId);
      return source && source.readAt && safeUrl(source.url) && citation.url === source.url && citation.resolvedUrl === source.resolvedUrl
        && citation.textSha256 === source.textSha256 && Number.isInteger(citation.start) && Number.isInteger(citation.end)
        && citation.start >= 0 && citation.end > citation.start && citation.end <= source.textCharacters
        && citation.quote.length === citation.end - citation.start;
    });
  });
}
function stateFor(facts: readonly CustomerFact[]): ComparisonState {
  const states = new Set(facts.map(fact => fact.state));
  if (states.has("conflicting") || (states.has("supported") && states.has("not_supported"))) return "conflicting";
  if (states.has("supported")) return "supported";
  if (states.has("not_supported")) return "not_supported";
  return "unknown";
}
function relevantFacts(facts: readonly CustomerFact[], definition: CustomerCharacteristicDefinition) {
  return facts.filter(fact => fact.subject.kind === "customer" && fact.characteristic?.id === definition.id
    && fact.characteristic.definitionVersion === definition.definitionVersion);
}
function industryIds(facts: readonly CustomerFact[]): string[] {
  return [...new Set(facts.filter(fact => fact.kind === "industry" && fact.subject.kind === "customer" && fact.state === "supported").map(fact => fact.value))];
}
function intersects(left: readonly string[], right: readonly string[]) { return left.some(value => right.includes(value)); }

/** Future read-side comparison only. Does not classify, schedule, write, pay,
 * promote a library or touch TAM grading. Unknown/stale answers remain visible
 * as unknown; saved native answers are returned without another semantic judge. */
export function compareCustomerResearch(input: {
  taxonomy: CustomerResearchTaxonomy; customerProofs: readonly CustomerResearchProof[]; prospect: CustomerProspectResearch;
  industryId?: string | null; characteristicIds?: readonly string[] | "all";
}) {
  const { taxonomy, prospect } = input;
  if (taxonomy.status !== "approved") throw new Error("customer_taxonomy_not_approved");
  if (!prospect.evidenceKey) throw new Error("missing_prospect_evidence_key");
  const customers = new Map(input.customerProofs.map(proof => [proof.customerId, { proof, facts: customerResearchComparisonFacts(proof) }]));
  if (customers.size !== input.customerProofs.length) throw new Error("duplicate_customer_comparison_proof");
  if (taxonomy.cohort.customerIds.some(id => !customers.has(id) || !accountedFor(customers.get(id)!.proof))) throw new Error("customer_taxonomy_cohort_unfinished");
  for (const definition of taxonomy.definitions) {
    if (definition.definitionVersion !== customerCharacteristicVersion(definition)) throw new Error("customer_definition_changed");
    if (!definition.customerSupport.length || definition.customerSupport.some(support => {
      const customer = customers.get(support.customerId);
      return !taxonomy.cohort.customerIds.includes(support.customerId) || !customer
        || !relevantFacts(customer.facts, definition).some(fact => fact.id === support.factId && fact.state === "supported");
    })) throw new Error("customer_definition_support_invalid");
  }
  const selected = input.characteristicIds ?? "all";
  if (selected !== "all" && selected.some(id => !taxonomy.definitions.some(definition => definition.id === id))) throw new Error("unknown_customer_characteristic");
  const definitions = taxonomy.definitions.filter(definition => (selected === "all" || selected.includes(definition.id))
    && (!input.industryId || definition.applicability.scope === "universal" || definition.applicability.industryIds.includes(input.industryId)));
  const sourceMap = new Map(prospect.sources.map(source => [source.id, source]));
  if (sourceMap.size !== prospect.sources.length) throw new Error("duplicate_prospect_source");
  const sourceValidity = new Map(prospect.sources.map(source => [source.id,
    safeUrl(source.url) && customerResearchTextHash(source.text) === source.textSha256]));
  const assessments = definitions.map(definition => {
    const answer = prospect.answers[definition.id];
    let state: ComparisonState = "unknown";
    let reason = "missing_answer";
    const citations: CustomerComparisonFact["prospect"]["citations"] = [];
    const namedIndustryMatches = !input.industryId || !!prospect.industryIds?.includes(input.industryId);
    const applicability = !namedIndustryMatches ? (prospect.industryIds === null ? "unknown" : "outside")
      : definition.applicability.scope === "universal" ? "applicable"
      : prospect.industryIds === null ? "unknown"
      : intersects(prospect.industryIds, definition.applicability.industryIds) ? "applicable" : "outside";
    if (answer) {
      reason = answer.definitionVersion !== definition.definitionVersion ? "stale_definition"
        : answer.evidenceKey !== prospect.evidenceKey ? "changed_evidence"
        : "native_answer";
      if (reason === "native_answer") {
        const native = answer.nativeResult;
        if (!object(native) || native.questionId !== definition.id || !object(native.answer) || native.answer.type !== "choice"
          || !["supported", "not_supported", "unknown", "conflicting", "insufficient_evidence"].includes(native.answer.choice)) reason = "invalid_native_answer";
        else {
          for (const citation of answer.citations) {
            const source = sourceMap.get(citation.sourceId);
            if (!source || !sourceValidity.get(source.id) || citation.textSha256 !== source.textSha256
              || !Number.isInteger(citation.start) || !Number.isInteger(citation.end) || citation.start < 0
              || citation.end <= citation.start || citation.end > source.text.length) { reason = "invalid_native_citation"; break; }
            citations.push({ ...citation, url: source.url, observedAt: source.observedAt, quote: source.text.slice(citation.start, citation.end) });
          }
          if (reason === "native_answer") {
            // Mechanical legacy choice normalization only; retain the original
            // response object and all its provider fields without alteration.
            const choice = native.answer.choice === "insufficient_evidence" ? "unknown" : native.answer.choice;
            if (choice !== "unknown" && !citations.length) reason = "missing_native_evidence";
            else state = choice;
          }
        }
      }
    }
    return { definition, state, reason, applicability, nativeResult: answer?.nativeResult, citations };
  });
  const matches = taxonomy.cohort.customerIds.flatMap(customerId => {
    const { proof, facts } = customers.get(customerId)!;
    if (proof.status === "unresolved") return [];
    const industries = industryIds(facts);
    if (input.industryId && !industries.includes(input.industryId)) return [];
    const shared: CustomerComparisonFact[] = assessments.flatMap(assessment => {
      if (assessment.state !== "supported" || assessment.applicability !== "applicable" || !assessment.nativeResult) return [];
      const matchingFacts = relevantFacts(facts, assessment.definition);
      if (stateFor(matchingFacts) !== "supported") return [];
      if (assessment.definition.applicability.scope === "industry" && !intersects(industries, assessment.definition.applicability.industryIds)) return [];
      return [{ characteristicId: assessment.definition.id, label: assessment.definition.label, definitionVersion: assessment.definition.definitionVersion,
        customer: { origin: "codex_research" as const, author: proof.author, facts: matchingFacts.filter(fact => fact.state === "supported") },
        prospect: { origin: "jev_native" as const, nativeResult: assessment.nativeResult, citations: assessment.citations } }];
    });
    return shared.length ? [{ customerId, name: proof.name, industryIds: industries, researchStatus: proof.status, sourceGaps: proof.sourceGaps, shared }] : [];
  });
  return { matches, characteristics: assessments.map(({ definition, state, reason, applicability, nativeResult }) => ({ id: definition.id,
    label: definition.label, applicability, prospectState: state, reason, nativeResult,
    matchedCustomers: matches.filter(match => match.shared.some(fact => fact.characteristicId === definition.id)).length })), providerCalls: 0 };
}
