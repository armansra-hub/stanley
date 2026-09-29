import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildCustomerCharacteristicQuestion, customerCharacteristicVersion, customerResearchCoverage, customerResearchFacts,
  customerResearchTextHash, normalizeCustomerResearchProfile, normalizeCustomerResearchTaxonomy,
  projectCustomerResearchProfile, validateCustomerResearchProfile, type CustomerResearchProfile,
} from "./customerResearchProfiles";

const observedAt = "2026-09-29T12:00:00Z", readAt = "2026-09-29T12:05:00Z", completedAt = "2026-09-29T12:10:00Z";
function inputProfile(customerId = "reference-1") {
  const body = "Example Logistics\nWe arrange freight through independent carriers.\nWe do not own trucks.\n© 2026";
  const quote = "We do not own trucks.", start = body.indexOf(quote);
  return {
    schema: "customer-research-v1", customerId, name: "Example Logistics", website: "https://example.com/",
    announcementIds: ["ring-ring-1"], author: { kind: "codex", name: "Codex", authoredAt: completedAt }, observedAt, completedAt,
    discovery: { status: "complete", methods: [{ id: "navigation", kind: "navigation", url: "https://example.com/", observedAt,
      outcome: "read", note: "Read all discovered company links; this synthetic site has one page." }],
    pages: [{ url: "https://example.com/", discoveredBy: ["navigation"], outcome: "captured", sourceId: "home" }], notes: [] },
    sources: [{ id: "home", url: "https://example.com/", resolvedUrl: "https://example.com/", title: "Example Logistics",
      kind: "company_website", observedAt, text: body, textSha256: customerResearchTextHash(body), readAt, capture: "full_observed_text" }],
    facts: [{ id: "no-fleet", label: "Does not own trucks", value: "No owned trucks", kind: "business_model",
      subject: { kind: "customer", name: "Example Logistics" }, state: "supported", explanation: "The company explicitly describes its fleet ownership.",
      citations: [{ sourceId: "home", textSha256: customerResearchTextHash(body), start, end: start + quote.length, quote, role: "supporting" }] }],
    summary: "Arranges freight through independent carriers and explicitly does not own trucks.", sourceGaps: [],
  };
}
function profile(customerId?: string) { return normalizeCustomerResearchProfile(inputProfile(customerId)); }
function unresolvedProfile(customerId = "reference-2"): CustomerResearchProfile {
  return { ...profile(customerId), status: "unresolved", website: null, sources: [], facts: [],
    discovery: { status: "complete", methods: [{ id: "search", kind: "public_search", url: "https://www.google.com/search?q=Example+Logistics",
      observedAt, outcome: "read", note: "Searched the exact announced name; multiple unrelated businesses remain and no official website can be attributed." }], pages: [], notes: [] },
    summary: "The announced customer cannot yet be identified among similarly named companies.", sourceGaps: ["Official website identity unresolved after exact-name public search."] };
}
function definition() {
  return { id: "no_owned_trucks", label: "No owned trucks", applicability: { scope: "industry" as const, industryIds: ["transportation"] },
    predicate: "The target company explicitly operates without its own trucks.", evidenceRules: ["Require an affirmative statement about the target's own fleet ownership."],
    exclusions: ["Brokerage, carrier partnerships and silence about ownership do not prove non-asset operations."],
    positiveExamples: [{ kind: "illustrative" as const, scenario: "We do not own trucks.", explanation: "Explicit negative ownership statement." }],
    negativeExamples: [{ kind: "illustrative" as const, scenario: "Our company-owned fleet serves customers nationwide.", explanation: "The target owns a fleet." }],
    customerSupport: [{ customerId: "reference-1", factId: "no-fleet" }] };
}
function taxonomy(status = "draft") {
  return { schema: "customer-characteristics-v1", id: "full-customer-library", author: { kind: "codex", name: "Codex", authoredAt: completedAt }, status,
    cohort: { customerIds: ["reference-1"], registryAsOf: observedAt, announcementThrough: observedAt }, definitions: [definition()], researchNotes: [] };
}

describe("customer-authored website research", () => {
  it("validates complete exact source content without converting it to a native Jev result", () => {
    const result = profile();
    expect(result.status).toBe("complete");
    expect(customerResearchTextHash(result.sources[0].text)).toBe(createHash("sha256").update(result.sources[0].text).digest("hex"));
    expect(normalizeCustomerResearchProfile(result)).toEqual(result);
    expect(customerResearchFacts(result)[0]).toMatchObject({ origin: "codex_research", state: "supported", author: { kind: "codex" },
      citations: [{ quote: "We do not own trucks.", url: "https://example.com/", observedAt }] });
    expect(customerResearchFacts(result)[0]).not.toHaveProperty("nativeResult");
  });

  it("does not treat legacy/native completion or import as completed website research", () => {
    const value = inputProfile();
    const draft = { ...value, completedAt: null, discovery: { status: "pending", methods: [], pages: [], notes: [] }, sources: [], facts: [], summary: null,
      legacy: { registrySourceStatus: "ready", nativeStatus: "ready", nativeAnswered: 47, savedResultIds: ["saved-native-1"] } };
    expect(normalizeCustomerResearchProfile(draft).status).toBe("draft");
    expect(() => normalizeCustomerResearchProfile({ ...draft, status: "complete" })).toThrow("status_mismatch");
  });

  it.each(["pending-page", "unread-page", "unfinished-discovery"])("never labels %s a finished site", variant => {
    const value = profile();
    if (variant === "pending-page") value.discovery.pages.push({ url: "https://example.com/services", discoveredBy: ["navigation"], outcome: "pending" });
    if (variant === "unread-page") { value.sources[0].readAt = null; value.facts = []; }
    if (variant === "unfinished-discovery") value.discovery.status = "in_progress";
    expect(() => normalizeCustomerResearchProfile(value)).toThrow();
  });

  it("tracks fallback reading and inaccessible pages as explicit gaps, not complete coverage", () => {
    const { status: _status, ...value } = profile(); void _status;
    value.discovery.pages.push({ url: "https://example.com/services", discoveredBy: ["navigation"], outcome: "unavailable", attemptedAt: observedAt, reason: "Server returns 503." });
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("undocumented_gaps");
    value.sourceGaps.push("Services page was unavailable; operating details may be incomplete.");
    const normalized = normalizeCustomerResearchProfile(value);
    expect(normalized.status).toBe("complete_with_gaps");
    expect(customerResearchCoverage(normalized)).toMatchObject({ read: 1, pending: 0, unavailable: 1 });
  });

  it("accounts for documented unresolved identity without inventing read pages or completed research", () => {
    const value = normalizeCustomerResearchProfile(unresolvedProfile());
    expect(value.status).toBe("unresolved");
    expect(customerResearchCoverage(value)).toMatchObject({ read: 0, pending: 0, unread: 0 });
    expect(projectCustomerResearchProfile(value)).toMatchObject({ status: "unresolved", sources: [], facts: [] });
    expect(normalizeCustomerResearchProfile(value)).toEqual(value);
    expect(() => normalizeCustomerResearchProfile({ ...value, status: "complete_with_gaps" })).toThrow("incomplete_research");
  });

  it.each(["no-attempt", "no-summary", "no-gap", "no-closure", "pending-page", "unread-page", "unfinished-discovery"])("rejects undocumented or unfinished unresolved state: %s", variant => {
    const value = unresolvedProfile();
    if (variant === "no-attempt") value.discovery.methods = [];
    if (variant === "no-summary") value.summary = null;
    if (variant === "no-gap") value.sourceGaps = [];
    if (variant === "no-closure") value.completedAt = null;
    if (variant === "pending-page") value.discovery.pages.push({ url: "https://example.com/services", discoveredBy: ["search"], outcome: "pending" });
    if (variant === "unfinished-discovery") value.discovery.status = "in_progress";
    if (variant === "unread-page") {
      value.sources = [{ ...profile().sources[0], readAt: null }];
      value.discovery.pages = [{ url: "https://example.com/", discoveredBy: ["search"], outcome: "captured", sourceId: "home" }];
    }
    expect(() => normalizeCustomerResearchProfile(value)).toThrow();
  });

  it("requires the attempted known website to be inventoried, with its specific failure", () => {
    const value = unresolvedProfile(); value.website = "https://example.com/";
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("website_not_inventoried");
    value.discovery.pages = [{ url: value.website, discoveredBy: ["search"], outcome: "unavailable", attemptedAt: observedAt, reason: "Domain does not resolve." }];
    expect(normalizeCustomerResearchProfile(value).status).toBe("unresolved");
    value.discovery.pages[0].reason = undefined;
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("unexplained_source_gap");
  });

  it.each(["changed-body", "changed-quote", "changed-hash", "out-of-bounds", "unread-source", "wrong-source"])("rejects citation corruption: %s", variant => {
    const value = profile(), citation = value.facts[0].citations[0];
    if (variant === "changed-body") value.sources[0].text += " revised";
    if (variant === "changed-quote") citation.quote = "We own trucks.";
    if (variant === "changed-hash") citation.textSha256 = "0".repeat(64);
    if (variant === "out-of-bounds") citation.end += 1000;
    if (variant === "unread-source") value.sources[0].readAt = null;
    if (variant === "wrong-source") citation.sourceId = "missing";
    expect(validateCustomerResearchProfile(value).ok).toBe(false);
  });

  it("never interprets missing information as not_supported or an unresolved conflict as supported", () => {
    const value = profile(), fact = value.facts[0];
    fact.state = "not_supported"; fact.citations = [];
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("decision_evidence");
    fact.state = "unknown";
    expect(normalizeCustomerResearchProfile(value).facts[0].state).toBe("unknown");
    fact.state = "conflicting";
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("decision_evidence");
  });

  it("retains subsidiaries as attributed business facts without confusing them with the target", () => {
    const value = profile(); value.facts[0].subject = { kind: "subsidiary", name: "Example Freight", relationship: "Wholly owned operating subsidiary" };
    expect(customerResearchFacts(value)[0].subject.kind).toBe("subsidiary");
    expect(() => normalizeCustomerResearchTaxonomy(taxonomy(), [value])).toThrow("unverified_customer_support");
  });

  it("accepts open-ended facts, preserves announcements, and has no 47-answer or page cap", () => {
    const value = profile();
    value.announcementIds.push("ring-ring-2");
    for (let i = 0; i < 200; i++) {
      const source = { ...value.sources[0], id: `page-${i}`, url: `https://example.com/page-${i}`, resolvedUrl: `https://example.com/page-${i}` };
      value.sources.push(source);
      value.discovery.pages.push({ url: source.url, discoveredBy: ["navigation"], outcome: "captured", sourceId: source.id });
    }
    const result = normalizeCustomerResearchProfile(value);
    expect(result.announcementIds).toHaveLength(2);
    expect(result.facts).toHaveLength(1);
    expect(customerResearchCoverage(result).read).toBe(201);
  });

  it("projects compact verified proof without storing full captured text in the cloud", () => {
    const value = profile(), projection = projectCustomerResearchProfile(value);
    expect(projection.sourceStorage).toBe("private_local_full_text");
    expect(projection.sources[0]).not.toHaveProperty("text");
    expect(projection.sources[0]).toMatchObject({ textSha256: value.sources[0].textSha256, textCharacters: value.sources[0].text.length });
    expect(JSON.stringify(projection)).not.toContain("We arrange freight through independent carriers.");
    expect(projection.facts[0].citations[0].quote).toBe("We do not own trucks.");
    expect(projection.fullProfileSha256).toMatch(/^[a-f0-9]{64}$/);
    value.facts[0].citations[0].quote = "unsupported quote";
    expect(() => projectCustomerResearchProfile(value)).toThrow("citation");
  });

  it("rejects fabricated native responses, grading fields, private URLs and unexplained exclusions", () => {
    const value = profile();
    expect(validateCustomerResearchProfile({ ...value, tamScore: 90 }).ok).toBe(false);
    expect(validateCustomerResearchProfile({ ...value, nativeResult: { answer: true } }).ok).toBe(false);
    expect(validateCustomerResearchProfile({ ...value, website: "https://user:password@example.com/" }).ok).toBe(false);
    value.discovery.pages.push({ url: "https://example.com/operations", discoveredBy: ["navigation"], outcome: "excluded" });
    expect(() => normalizeCustomerResearchProfile(value)).toThrow("unexplained_exclusion");
  });
});

describe("customer-derived characteristic definitions", () => {
  it("keeps unfinished full-cohort research in draft rather than approving the completed sample", () => {
    const value = taxonomy(); value.cohort.customerIds.push("reference-2");
    expect(normalizeCustomerResearchTaxonomy(value, [profile()]).status).toBe("draft");
    expect(() => normalizeCustomerResearchTaxonomy({ ...value, status: "approved" }, [profile()])).toThrow("taxonomy_cohort_unfinished");
  });

  it("requires explicit current-definition customer support and supports universal or industry rules", () => {
    const value = taxonomy("approved"), p = profile();
    expect(() => normalizeCustomerResearchTaxonomy(value, [p])).toThrow("support_definition_mismatch");
    p.facts[0].characteristic = { id: value.definitions[0].id, definitionVersion: customerCharacteristicVersion(value.definitions[0]) };
    const result = normalizeCustomerResearchTaxonomy(value, [p]);
    expect(result.definitions[0].applicability).toEqual({ scope: "industry", industryIds: ["transportation"] });
    expect(normalizeCustomerResearchTaxonomy(result, [p])).toEqual(result);
    const universal = { ...definition(), applicability: { scope: "universal" as const } };
    expect(customerCharacteristicVersion(universal)).not.toBe(result.definitions[0].definitionVersion);
  });

  it("allows accounted-for unresolved customers in the cohort, never as category support or observed examples", () => {
    const value = taxonomy("approved"), researched = profile(), unresolved = unresolvedProfile();
    value.cohort.customerIds.push(unresolved.customerId);
    researched.facts[0].characteristic = { id: value.definitions[0].id, definitionVersion: customerCharacteristicVersion(value.definitions[0]) };
    expect(normalizeCustomerResearchTaxonomy(value, [researched, unresolved]).status).toBe("approved");
    // Even retained, valid partial facts cannot make an unresolved identity a peer example.
    const partial = { ...researched, customerId: unresolved.customerId, status: "unresolved" as const, sourceGaps: ["Customer identity remains unresolved."] };
    const support = structuredClone(value); support.definitions[0].customerSupport.push({ customerId: partial.customerId, factId: "no-fleet" });
    expect(() => normalizeCustomerResearchTaxonomy(support, [researched, partial])).toThrow("unverified_customer_support");
    const example = structuredClone(value);
    Object.assign(example.definitions[0].positiveExamples[0], { kind: "observed_customer", customerId: partial.customerId, factId: "no-fleet" });
    expect(() => normalizeCustomerResearchTaxonomy(example, [researched, partial])).toThrow("unverified_customer_support");
  });

  it("only invalidates changed criteria, not every category when support counts grow", () => {
    const first = definition(), version = customerCharacteristicVersion(first);
    const moreSupport = { ...first, customerSupport: [...first.customerSupport, { customerId: "reference-2", factId: "no-fleet" }] };
    expect(customerCharacteristicVersion(moreSupport)).toBe(version);
    expect(customerCharacteristicVersion({ ...first, label: "Renamed display label" })).toBe(version);
    expect(customerCharacteristicVersion({ ...first, predicate: "The target owns a fleet." })).not.toBe(version);
    expect(() => normalizeCustomerResearchTaxonomy({ ...taxonomy(), definitions: [{ ...first, definitionVersion: "outdated" }] }, [profile()])).toThrow("definition_version");
  });

  it("builds an exact classifier question with explicit exclusions and unknown, with no invented output", () => {
    const definition = normalizeCustomerResearchTaxonomy(taxonomy(), [profile()]).definitions[0];
    const question = buildCustomerCharacteristicQuestion(definition);
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["supported", "not_supported", "unknown", "conflicting"]);
    expect(question.instructions).toContain("Brokerage, carrier partnerships and silence");
    expect(question.instructions).toContain("Never infer financial pain, purchase intent or a TAM grade");
    expect(question).not.toHaveProperty("answer");
  });

  it("does not smuggle unresearched customers into category frequency or illustrative examples", () => {
    const value = taxonomy(); value.definitions[0].customerSupport.push({ customerId: "not-in-cohort", factId: "some-fact" });
    expect(() => normalizeCustomerResearchTaxonomy(value, [profile()])).toThrow("support_outside_cohort");
    const marked = taxonomy(); Object.assign(marked.definitions[0].positiveExamples[0], { customerId: "reference-1" });
    expect(() => normalizeCustomerResearchTaxonomy(marked, [profile()])).toThrow("illustrative_customer_claim");
  });
});
