import { z } from "zod";
import { catalogSha256 } from "./operatingCatalogHash";

/** Authored research, not a Jev answer, registry import or TAM grade. This module
 * has no provider, database, browser, filesystem or network dependency. */
export const CUSTOMER_RESEARCH_SCHEMA = "customer-research-v1";
export const CUSTOMER_TAXONOMY_SCHEMA = "customer-characteristics-v1";
export const CUSTOMER_RESEARCH_DECISIONS = {
  supported: "Explicit attributable evidence establishes the entire predicate for the named subject.",
  not_supported: "Explicit attributable evidence contradicts the predicate. Absence of a statement is not negative evidence.",
  unknown: "The available evidence does not establish or contradict the entire predicate.",
  conflicting: "Relevant attributable evidence supports and contradicts the predicate, and the conflict remains unresolved.",
} as const;

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,160}$/);
const text = z.string().refine(value => value.trim().length > 0, "empty_text");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const publicUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && url.hostname.includes(".") && !/^\d[\d.]*$/.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname);
  } catch { return false; }
}, "invalid_public_url");
const author = z.object({ kind: z.literal("codex"), name: text, authoredAt: timestamp }).strict();
const citationSchema = z.object({
  sourceId: id, textSha256: hash, start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: text, role: z.enum(["supporting", "contradicting", "context"]),
}).strict();
export const customerResearchSourceSchema = z.object({
  id, url: publicUrl, resolvedUrl: publicUrl, title: text,
  kind: z.enum(["company_website", "linkedin", "public_source"]), observedAt: timestamp,
  text, textSha256: hash, readAt: timestamp.nullable(),
  capture: z.literal("full_observed_text"),
}).strict();
export const customerResearchFactSchema = z.object({
  id, label: text, value: text,
  kind: z.enum(["industry", "business_model", "service", "customer", "operations", "subsidiary", "characteristic"]),
  subject: z.object({ kind: z.enum(["customer", "subsidiary", "parent", "partner", "other"]), name: text,
    relationship: text.optional() }).strict(),
  state: z.enum(["supported", "not_supported", "unknown", "conflicting"]),
  explanation: text, citations: z.array(citationSchema),
  characteristic: z.object({ id, definitionVersion: text }).strict().optional(),
}).strict();
const pageSchema = z.object({
  url: publicUrl, discoveredBy: z.array(id).min(1),
  outcome: z.enum(["pending", "captured", "unavailable", "excluded"]),
  sourceId: id.optional(), attemptedAt: timestamp.optional(), reason: text.optional(),
  // Exclusion is about a document, never permission to omit an inconvenient business fact.
  exclusion: z.enum(["duplicate", "non_content", "not_company_related"]).optional(),
  duplicateOf: publicUrl.optional(),
}).strict();
const profileSchema = z.object({
  schema: z.literal(CUSTOMER_RESEARCH_SCHEMA), customerId: id, name: text, website: publicUrl.nullable(),
  announcementIds: z.array(text), author,
  observedAt: timestamp, completedAt: timestamp.nullable(),
  discovery: z.object({
    status: z.enum(["pending", "in_progress", "complete"]),
    methods: z.array(z.object({ id, kind: z.enum(["sitemap", "navigation", "page_links", "public_search", "manual"]),
      url: publicUrl, observedAt: timestamp, outcome: z.enum(["read", "unavailable"]), note: text }).strict()),
    pages: z.array(pageSchema), notes: z.array(text),
  }).strict(),
  sources: z.array(customerResearchSourceSchema), facts: z.array(customerResearchFactSchema),
  summary: text.nullable(), sourceGaps: z.array(text),
  legacy: z.object({ registrySourceStatus: text.optional(), nativeStatus: text.optional(),
    nativeAnswered: z.number().int().nonnegative().optional(), savedResultIds: z.array(text) }).strict().optional(),
  status: z.enum(["draft", "in_progress", "complete", "complete_with_gaps", "unresolved"]).optional(),
}).strict();

export type CustomerResearchSource = z.infer<typeof customerResearchSourceSchema>;
export type CustomerResearchCitation = z.infer<typeof citationSchema>;
export type CustomerResearchFact = z.infer<typeof customerResearchFactSchema>;
export type CustomerResearchProfile = Omit<z.infer<typeof profileSchema>, "status"> & {
  status: "draft" | "in_progress" | "complete" | "complete_with_gaps" | "unresolved";
};
export type CustomerResearchCoverage = {
  discovered: number; captured: number; read: number; pending: number; unread: number;
  unavailable: number; excluded: number; discoveryComplete: boolean;
};
const fail = (reason: string): never => { throw new Error(`invalid_customer_research:${reason}`); };
const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) fail(`duplicate_${label}`); };
const sorted = <T>(values: T[], key: (value: T) => string): T[] => [...values].sort((a, b) => key(a).localeCompare(key(b), "en"));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
    .filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",") + "}";
  return JSON.stringify(value);
};

/** Exact SHA-256 of captured text, not a whitespace-normalized excerpt. */
export const customerResearchTextHash = catalogSha256;

export function customerResearchCoverage(profile: Pick<CustomerResearchProfile, "discovery" | "sources">): CustomerResearchCoverage {
  const sources = new Map(profile.sources.map(source => [source.id, source]));
  const pages = profile.discovery.pages;
  const captured = pages.filter(page => page.outcome === "captured");
  const read = captured.filter(page => !!sources.get(page.sourceId ?? "")?.readAt).length;
  return { discovered: pages.length, captured: captured.length, read, pending: pages.filter(page => page.outcome === "pending").length,
    unread: captured.length - read, unavailable: pages.filter(page => page.outcome === "unavailable").length,
    excluded: pages.filter(page => page.outcome === "excluded").length, discoveryComplete: profile.discovery.status === "complete" };
}

/** Strict, idempotent admission. Content, URLs and citation offsets are never
 * rewritten. Sorting is only for deterministic identity and comparison. */
export function normalizeCustomerResearchProfile(input: unknown): CustomerResearchProfile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return fail(`schema:${parsed.error.issues.map(issue => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  unique(value.announcementIds, "announcement"); unique(value.sources.map(source => source.id), "source");
  unique(value.discovery.methods.map(method => method.id), "discovery_method");
  unique(value.discovery.pages.map(page => page.url), "page"); unique(value.facts.map(fact => fact.id), "fact");
  const sources = new Map(value.sources.map(source => [source.id, source]));
  const methods = new Set(value.discovery.methods.map(method => method.id));
  const pages = new Map(value.discovery.pages.map(page => [page.url, page]));
  for (const source of value.sources) {
    if (customerResearchTextHash(source.text) !== source.textSha256) fail(`source_hash:${source.id}`);
    if (source.readAt && Date.parse(source.readAt) < Date.parse(source.observedAt)) fail(`read_before_capture:${source.id}`);
    if (!value.discovery.pages.some(page => page.outcome === "captured" && page.sourceId === source.id)) fail(`untracked_source:${source.id}`);
  }
  for (const page of value.discovery.pages) {
    if (page.discoveredBy.some(method => !methods.has(method))) fail(`discovery_method:${page.url}`);
    const source = sources.get(page.sourceId ?? "");
    if (page.outcome === "captured" && (!source || ![source.url, source.resolvedUrl].includes(page.url))) fail(`page_capture:${page.url}`);
    if (page.outcome !== "captured" && page.sourceId) fail(`unexpected_page_source:${page.url}`);
    if (page.outcome === "unavailable" && (!page.attemptedAt || !page.reason)) fail(`unexplained_source_gap:${page.url}`);
    if (page.outcome === "excluded" && (!page.exclusion || !page.reason)) fail(`unexplained_exclusion:${page.url}`);
    if (page.exclusion === "duplicate" && (!page.duplicateOf || page.duplicateOf === page.url || pages.get(page.duplicateOf)?.outcome !== "captured")) fail(`duplicate_target:${page.url}`);
    if (page.outcome !== "excluded" && (page.exclusion || page.duplicateOf)) fail(`unexpected_exclusion:${page.url}`);
  }
  for (const fact of value.facts) {
    for (const citation of fact.citations) {
      const source = sources.get(citation.sourceId);
      if (!source?.readAt || source.textSha256 !== citation.textSha256 || citation.end <= citation.start
        || source.text.slice(citation.start, citation.end) !== citation.quote || citation.end > source.text.length) fail(`citation:${fact.id}`);
    }
    const supports = fact.citations.some(citation => citation.role === "supporting");
    const contradicts = fact.citations.some(citation => citation.role === "contradicting");
    if ((fact.state === "supported" && (!supports || contradicts))
      || (fact.state === "not_supported" && (!contradicts || supports))
      || (fact.state === "conflicting" && (!supports || !contradicts))
      || (fact.state === "unknown" && (supports || contradicts))) fail(`decision_evidence:${fact.id}`);
  }
  const coverage = customerResearchCoverage(value);
  let status: CustomerResearchProfile["status"] = value.sources.length || value.discovery.status !== "pending" ? "in_progress" : "draft";
  if (value.completedAt) {
    const finishedAt = Date.parse(value.completedAt);
    const unresolved = value.status === "unresolved";
    if (!coverage.discoveryComplete || coverage.pending || coverage.unread || !value.discovery.methods.length || !value.summary
      || (!unresolved && (!coverage.read || !value.facts.length))) fail("incomplete_research");
    // Closing a documented source/identity attempt is not completed research.
    // It accounts for the customer without inventing facts or read pages.
    if (unresolved && !value.sourceGaps.length) fail("undocumented_unresolved");
    if (finishedAt < Date.parse(value.observedAt)
      || value.sources.some(source => source.readAt && Date.parse(source.readAt) > finishedAt)
      || value.discovery.methods.some(method => Date.parse(method.observedAt) > finishedAt)
      || value.discovery.pages.some(page => page.attemptedAt && Date.parse(page.attemptedAt) > finishedAt)) fail("completion_before_read");
    if (coverage.unavailable && !value.sourceGaps.length) fail("undocumented_gaps");
    if (value.website && !value.discovery.pages.some(page => page.url === value.website)) fail("website_not_inventoried");
    if (!value.website && !value.sourceGaps.length) fail("unknown_website_gap");
    status = unresolved ? "unresolved" : coverage.unavailable || value.sourceGaps.length ? "complete_with_gaps" : "complete";
  }
  if (value.status && value.status !== status) fail("status_mismatch");
  return { ...value, status, announcementIds: sorted(value.announcementIds, id => id),
    discovery: { ...value.discovery, methods: sorted(value.discovery.methods, method => method.id), pages: sorted(value.discovery.pages, page => page.url) },
    sources: sorted(value.sources, source => source.id), facts: sorted(value.facts, fact => fact.id) };
}

export function validateCustomerResearchProfile(value: unknown): { ok: true; profile: CustomerResearchProfile } | { ok: false; error: string } {
  try { return { ok: true, profile: normalizeCustomerResearchProfile(value) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "invalid_customer_research" }; }
}

/** Common facts retain explicit authorship, subject and dated exact sources.
 * Nothing here creates a native Jev probability or maps unknown to false. */
export function customerResearchFacts(input: CustomerResearchProfile) {
  const profile = normalizeCustomerResearchProfile(input), sources = new Map(profile.sources.map(source => [source.id, source]));
  return profile.facts.map(fact => ({ ...fact, author: profile.author, origin: "codex_research" as const,
    customerId: profile.customerId, researchStatus: profile.status,
    citations: fact.citations.map(citation => { const source = sources.get(citation.sourceId)!;
      return { ...citation, url: source.url, resolvedUrl: source.resolvedUrl, title: source.title, observedAt: source.observedAt, readAt: source.readAt }; }) }));
}

/** Only this compact projection belongs in hosted storage. Keep the full input
 * archive private and local. Consumers can show an exact quote without fetching
 * every captured page body or pretending a quote is the complete source. */
export function projectCustomerResearchProfile(input: CustomerResearchProfile) {
  const profile = normalizeCustomerResearchProfile(input);
  const { sources, schema: _schema, ...metadata } = profile;
  void _schema;
  return { ...metadata, schema: "customer-research-proof-v1" as const,
    sourceStorage: "private_local_full_text" as const, fullProfileSha256: catalogSha256(canonical(profile)),
    coverage: customerResearchCoverage(profile),
    sources: sources.map(({ text: body, ...manifest }) => ({ ...manifest, textCharacters: body.length })),
    facts: customerResearchFacts(profile),
  };
}
export type CustomerResearchProof = ReturnType<typeof projectCustomerResearchProfile>;

const exampleSchema = z.object({ scenario: text, explanation: text, kind: z.enum(["illustrative", "observed_customer"]),
  customerId: id.optional(), factId: id.optional() }).strict();
const definitionSchema = z.object({
  id, label: text, definitionVersion: text.optional(),
  applicability: z.discriminatedUnion("scope", [z.object({ scope: z.literal("universal") }).strict(),
    z.object({ scope: z.literal("industry"), industryIds: z.array(id).min(1) }).strict()]),
  predicate: text, evidenceRules: z.array(text).min(1), exclusions: z.array(text).min(1),
  positiveExamples: z.array(exampleSchema).min(1), negativeExamples: z.array(exampleSchema).min(1),
  customerSupport: z.array(z.object({ customerId: id, factId: id }).strict()),
}).strict();
export type CustomerCharacteristicDefinition = Omit<z.infer<typeof definitionSchema>, "definitionVersion"> & { definitionVersion: string };
const taxonomySchema = z.object({
  schema: z.literal(CUSTOMER_TAXONOMY_SCHEMA), id, author, status: z.enum(["draft", "approved"]),
  cohort: z.object({ customerIds: z.array(id).min(1), registryAsOf: timestamp, announcementThrough: timestamp }).strict(),
  definitions: z.array(definitionSchema), researchNotes: z.array(text),
}).strict();
export type CustomerResearchTaxonomy = Omit<z.infer<typeof taxonomySchema>, "definitions"> & { definitions: CustomerCharacteristicDefinition[] };

/** Support counts can grow without invalidating paid answers. Only the actual
 * predicate, decision policy, applicability and interpretive guidance bind reuse. */
export function customerCharacteristicVersion(input: z.input<typeof definitionSchema>): string {
  const definition = definitionSchema.parse(input);
  return "customer-fact-v1-" + catalogSha256(canonical({
    id: definition.id, applicability: definition.applicability, predicate: definition.predicate,
    evidenceRules: definition.evidenceRules, exclusions: definition.exclusions,
    positiveExamples: definition.positiveExamples.map(({ scenario, explanation }) => ({ scenario, explanation })),
    negativeExamples: definition.negativeExamples.map(({ scenario, explanation }) => ({ scenario, explanation })),
    decisions: CUSTOMER_RESEARCH_DECISIONS,
  }));
}

export function normalizeCustomerResearchTaxonomy(input: unknown, researchedProfiles: readonly CustomerResearchProfile[] = []): CustomerResearchTaxonomy {
  const parsed = taxonomySchema.safeParse(input);
  if (!parsed.success) return fail(`taxonomy_schema:${parsed.error.issues.map(issue => issue.path.join(".")).join(",")}`);
  const value = parsed.data;
  unique(value.cohort.customerIds, "cohort_customer"); unique(value.definitions.map(definition => definition.id), "definition");
  const profiles = researchedProfiles.map(normalizeCustomerResearchProfile);
  unique(profiles.map(profile => profile.customerId), "profile_customer");
  const byCustomer = new Map(profiles.map(profile => [profile.customerId, profile]));
  const cohort = new Set(value.cohort.customerIds);
  if (value.status === "approved" && (!value.definitions.length || value.cohort.customerIds.some(customerId => {
    const profile = byCustomer.get(customerId); return !profile || !["complete", "complete_with_gaps", "unresolved"].includes(profile.status);
  }))) fail("taxonomy_cohort_unfinished");
  const definitions = value.definitions.map(definition => {
    const version = customerCharacteristicVersion(definition);
    if (definition.definitionVersion && definition.definitionVersion !== version) fail(`definition_version:${definition.id}`);
    if (definition.applicability.scope === "industry") unique(definition.applicability.industryIds, "applicability_industry");
    unique(definition.customerSupport.map(support => `${support.customerId}:${support.factId}`), "customer_support");
    const validateReference = (customerId: string, factId: string, state: string) => {
      if (!cohort.has(customerId)) fail(`support_outside_cohort:${definition.id}`);
      const profile = byCustomer.get(customerId), fact = profile?.facts.find(fact => fact.id === factId);
      if (profile?.status === "unresolved" || !fact || fact.state !== state || fact.subject.kind !== "customer") return fail(`unverified_customer_support:${definition.id}`);
      if ((value.status === "approved" && !fact.characteristic)
        || (fact.characteristic && (fact.characteristic.id !== definition.id || fact.characteristic.definitionVersion !== version))) fail(`support_definition_mismatch:${definition.id}`);
    };
    for (const support of definition.customerSupport) validateReference(support.customerId, support.factId, "supported");
    if (value.status === "approved" && !definition.customerSupport.length) fail(`unsupported_definition:${definition.id}`);
    for (const [examples, state] of [[definition.positiveExamples, "supported"], [definition.negativeExamples, "not_supported"]] as const) {
      for (const example of examples) {
        if (example.kind === "observed_customer") {
          if (!example.customerId || !example.factId) fail(`example_reference:${definition.id}`);
          validateReference(example.customerId!, example.factId!, state);
        } else if (example.customerId || example.factId) fail(`illustrative_customer_claim:${definition.id}`);
      }
    }
    return { ...definition, definitionVersion: version };
  });
  return { ...value, cohort: { ...value.cohort, customerIds: sorted(value.cohort.customerIds, id => id) }, definitions: sorted(definitions, definition => definition.id) };
}

/** Question construction is free. A paid caller must separately require an
 * approved taxonomy and the application's paid-call policy. */
export function buildCustomerCharacteristicQuestion(definition: CustomerCharacteristicDefinition) {
  if (definition.definitionVersion !== customerCharacteristicVersion(definition)) fail(`definition_version:${definition.id}`);
  return { type: "choice" as const, instructions: JSON.stringify({
    predicate: definition.predicate, applicability: definition.applicability, evidenceRules: definition.evidenceRules,
    exclusions: definition.exclusions,
    positiveExamples: definition.positiveExamples.map(({ scenario, explanation }) => ({ scenario, explanation })),
    negativeExamples: definition.negativeExamples.map(({ scenario, explanation }) => ({ scenario, explanation })),
    policy: "Classify only the target company from the supplied evidence. Examples describe the rule, not this target. Respect ownership, entity role, date and all required conditions. Missing evidence is unknown. Never infer financial pain, purchase intent or a TAM grade.",
  }), criteria: { ...CUSTOMER_RESEARCH_DECISIONS } };
}
