import { buildOperatingProfile, OPERATING_TOPICS, type OperatingTopic, type ProfileObservation } from "./profiles";

export function operatingTopicFilter(values: readonly string[]): OperatingTopic[] | null {
  if (!values.length || values.length > 8 || values.some(value => !Object.hasOwn(OPERATING_TOPICS, value))) return null;
  return [...new Set(values)] as OperatingTopic[];
}

export type TopicSearchAccountRow = {
  companyId: string; name: string; domain: string | null; subindustry: string | null; internalId: string;
  observations: ProfileObservation[];
  coverage: { observations: number; interpreted: number };
};
export type TopicSearchRaw = {
  enabled: boolean; topics: OperatingTopic[]; accounts: TopicSearchAccountRow[];
  hasMore: boolean; nextCursor: string | null;
  coverage?: { tamAccounts: number; accountsWithTopicEvidence: number; currentObservations: number;
    interpretedObservations: number; matchingAccounts: number; asOf: string; cacheOnly: true };
};

function evidenceIsUsable(row: ProfileObservation): boolean {
  if (typeof row.evidence_text !== "string" || !row.attributes) return false;
  const relevance = row.attributes.companyRelevance;
  if (typeof relevance !== "number" || !Number.isFinite(relevance) || relevance < .8 || relevance > 1) return false;
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
  const accounts = raw.accounts.flatMap(account => {
    const rows = account.observations.filter(evidenceIsUsable).map(row => ({ ...row, attributes: {
      ...row.attributes,
      topicEvidence: (Array.isArray(row.attributes?.topicEvidence) ? row.attributes.topicEvidence : []).filter(reference => {
        if (!reference || typeof reference !== "object") return false;
        const p = (reference as Record<string, unknown>).probability;
        return typeof p === "number" && Number.isFinite(p) && p >= .8 && p <= 1;
      }),
    } }));
    const profile = buildOperatingProfile(rows);
    const topics = selected.map(id => profile.topics.find(topic => topic.id === id)!);
    if (topics.some(topic => topic.state !== "supported")) return [];
    return [{ companyId: account.companyId, name: account.name, domain: account.domain,
      subindustry: account.subindustry, internalId: account.internalId, topics,
      coverage: { ...account.coverage, citedObservations: new Set(topics.flatMap(topic => topic.sources.map(source => source.observationId))).size } }];
  });
  return { enabled: raw.enabled, topics: selected, accounts, hasMore: raw.hasMore, nextCursor: raw.nextCursor,
    coverage: raw.coverage ?? null, coverageLimited: true,
    note: "Matches use current cached public evidence. Coverage grows as sources are collected and interpreted; an unmatched trait may still be unknown. These operating traits do not change TAM grades." };
}

export type TopicSearchResult = ReturnType<typeof buildTopicSearchResult>;
