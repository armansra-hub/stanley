import { buildOperatingProfile, OPERATING_TOPICS, type OperatingTopic, type ProfileObservation } from "./profiles";
import { visibilityPolicy, type VisibilityMode } from "./visibility";
import { isOperatingFacetId, operatingFacet, OPERATING_CATALOG_VERSION, type OperatingFacetId } from "./operatingCatalog";

export type SearchOperatingTopic = OperatingTopic | OperatingFacetId;
export function operatingTopicFilter(values: readonly string[]): SearchOperatingTopic[] | null {
  if (values.length > 8 || values.some(value => !Object.hasOwn(OPERATING_TOPICS, value) && !isOperatingFacetId(value))) return null;
  return [...new Set(values)] as SearchOperatingTopic[];
}

export type CatalogCitation = {
  observationId: string; url: string; title: string; sourceKind: string; eventDate: string | null; observedAt: string;
  start: number; end: number; contentHash: string;
};
export type CatalogFacetRow = {
  id: string; catalogVersion: string; decision: string; status: string;
  probability: number | null; nativeResult: unknown; citations: CatalogCitation[];
};
export type OperatingMatchSource = {
  observationId: string; url: string; title: string; sourceKind: string; eventDate: string | null; observedAt: string;
  probability: number | null; companyRelevance: unknown; contextPreview: string; previewTruncated: boolean; start: number; end: number;
};
export type OperatingMatchTopic = { id: string; label: string; state: string; sources: OperatingMatchSource[];
  nativeResult?: unknown; discoveryHypothesis?: string; boundary?: string; classification?: string };

export type TopicSearchAccountRow = {
  companyId: string; name: string; domain: string | null; subindustry: string | null; internalId: string;
  status?: string;
  observations: (ProfileObservation & { content_hash?: string })[];
  catalogFacets?: CatalogFacetRow[];
  coverage: { observations: number; interpreted: number };
};
export type TopicSearchRaw = {
  enabled: boolean; topics: SearchOperatingTopic[]; accounts: TopicSearchAccountRow[];
  mode?: "all" | "any";
  visibility?: VisibilityMode;
  combinations?: string[][];
  recipeId?: string | null;
  topicCounts?: Partial<Record<SearchOperatingTopic, number>>;
  catalogCoverage?: { version: string; total: number; publicFacets: number; complete: number; partial: number;
    pending: number; blocked: number; contextOnlyFacets: number };
  hasMore: boolean; nextCursor: string | null;
  coverage?: { tamAccounts: number; accountsWithTopicEvidence: number; currentObservations: number;
    interpretedObservations: number; matchingAccounts: number; asOf: string; cacheOnly: true;
    accountsWithNoInterpretedEvidence?: number; accountsWithoutSelectedEvidence?: number };
};

function catalogTopic(row: CatalogFacetRow, observations: TopicSearchAccountRow["observations"]): OperatingMatchTopic | null {
  const facet = operatingFacet(row.id);
  if (!facet || row.catalogVersion !== OPERATING_CATALOG_VERSION || row.status !== "answered" || row.decision !== "supported") return null;
  const sources = row.citations.flatMap(citation => {
    const observation = observations.find(source => source.id === citation.observationId && !source.feedback_excluded && source.content_hash === citation.contentHash);
    let safe = false;
    try { const url = new URL(citation.url); safe = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { /* Invalid source cannot be rendered as evidence. */ }
    if (!safe || !observation || !Number.isInteger(citation.start)
      || !Number.isInteger(citation.end) || citation.start < 0 || citation.end <= citation.start || citation.end > observation.evidence_text.length) return [];
    const context = observation.evidence_text.slice(citation.start, citation.end);
    if (!context.trim()) return [];
    return [{ observationId: citation.observationId, url: citation.url, title: citation.title, sourceKind: citation.sourceKind,
      eventDate: citation.eventDate, observedAt: citation.observedAt, start: citation.start, end: citation.end,
      probability: row.probability, companyRelevance: null, contextPreview: context.slice(0, 900), previewTruncated: context.length > 900 }];
  });
  if (!sources.length) return null;
  return { id: facet.id, label: facet.label, state: "supported", classification: "native_choice", sources,
    nativeResult: row.nativeResult, discoveryHypothesis: facet.discoveryHypothesis, boundary: facet.boundary };
}

function evidenceIsUsable(row: ProfileObservation): boolean {
  if (typeof row.evidence_text !== "string" || !row.attributes) return false;
  try {
    const url = new URL(row.source_url);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** A compound match is an intersection of supported account topics across sources.
 * No prose generation or assumed link between separate companies is involved. */
export function buildTopicSearchResult(raw: TopicSearchRaw) {
  const selected = operatingTopicFilter(raw.topics);
  if (!selected) throw new Error("Invalid cached topic response");
  const mode = raw.mode ?? "all";
  const visibility = raw.visibility ?? "supported";
  if (!["supported", "explore"].includes(visibility)) throw new Error("Invalid visibility mode");
  const policy = visibilityPolicy(visibility);
  if (mode !== "all" && mode !== "any") throw new Error("Invalid cached topic mode");
  const combinations = raw.combinations;
  if (combinations && (!combinations.length || combinations.length > 16 || combinations.some(branch => !branch.length || branch.some(id => !selected.includes(id as SearchOperatingTopic))))) throw new Error("Invalid cached recipe");
  const accounts = (selected.length ? raw.accounts : []).flatMap(account => {
    const rows = account.observations.filter(evidenceIsUsable).map(row => ({ ...row, attributes: {
      ...row.attributes,
      topicEvidence: (Array.isArray(row.attributes?.topicEvidence) ? row.attributes.topicEvidence : []).filter(reference => {
        if (!reference || typeof reference !== "object") return false;
        const p = (reference as Record<string, unknown>).probability;
        return typeof p === "number" && Number.isFinite(p) && p >= policy.topicProbability && p <= 1;
      }),
    } }));
    const profile = buildOperatingProfile(rows, Date.now(), policy);
    const catalog = new Map((account.catalogFacets ?? []).flatMap(row => { const topic = catalogTopic(row, account.observations); return topic ? [[topic.id, topic] as const] : []; }));
    const matches: (OperatingMatchTopic | undefined)[] = selected.map(id => isOperatingFacetId(id) ? catalog.get(id) : profile.topics.find(topic => topic.id === id));
    if (combinations ? !combinations.some(branch => branch.every(id => matches.some(topic => topic?.id === id && topic.state !== "unknown")))
      : mode === "all" && matches.some(topic => !topic || topic.state === "unknown")) return [];
    const topics = matches.filter((topic): topic is OperatingMatchTopic => !!topic && topic.state !== "unknown");
    if (!topics.length) return [];
    return [{ companyId: account.companyId, name: account.name, domain: account.domain,
      subindustry: account.subindustry, internalId: account.internalId, status: account.status ?? "new", topics,
      coverage: { ...account.coverage, citedObservations: new Set(topics.flatMap(topic => topic.sources.map(source => source.observationId))).size } }];
  });
  return { enabled: raw.enabled, topics: selected, mode, visibility, policy, recipeId: raw.recipeId ?? null, topicCounts: raw.topicCounts ?? {}, accounts, hasMore: raw.hasMore, nextCursor: raw.nextCursor,
    coverage: raw.coverage ?? null, catalogCoverage: raw.catalogCoverage ?? null, coverageLimited: true,
    note: "New categories use Jev's native supported classification across the account's evidence, without an additional semantic judge. Legacy traits use the selected probability threshold. An unmatched trait may be unknown or not yet evaluated. Business-model matches do not establish finance pain, buying intent or a TAM grade." };
}

export type TopicSearchResult = ReturnType<typeof buildTopicSearchResult>;
