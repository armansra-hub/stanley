import { buildOperatingProfile, OPERATING_TOPICS, type OperatingTopic, type ProfileObservation } from "./profiles";
import { visibilityPolicy, type VisibilityMode } from "./visibility";

export function operatingTopicFilter(values: readonly string[]): OperatingTopic[] | null {
  if (values.length > 8 || values.some(value => !Object.hasOwn(OPERATING_TOPICS, value))) return null;
  return [...new Set(values)] as OperatingTopic[];
}

export type TopicSearchAccountRow = {
  companyId: string; name: string; domain: string | null; subindustry: string | null; internalId: string;
  status?: string;
  observations: ProfileObservation[];
  coverage: { observations: number; interpreted: number };
};
export type TopicSearchRaw = {
  enabled: boolean; topics: OperatingTopic[]; accounts: TopicSearchAccountRow[];
  mode?: "all" | "any";
  visibility?: VisibilityMode;
  topicCounts?: Partial<Record<OperatingTopic, number>>;
  hasMore: boolean; nextCursor: string | null;
  coverage?: { tamAccounts: number; accountsWithTopicEvidence: number; currentObservations: number;
    interpretedObservations: number; matchingAccounts: number; asOf: string; cacheOnly: true;
    accountsWithNoInterpretedEvidence?: number; accountsWithoutSelectedEvidence?: number };
};

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
    const matches = selected.map(id => profile.topics.find(topic => topic.id === id)!);
    if (mode === "all" && matches.some(topic => topic.state === "unknown")) return [];
    const topics = matches.filter(topic => topic.state !== "unknown");
    if (!topics.length) return [];
    return [{ companyId: account.companyId, name: account.name, domain: account.domain,
      subindustry: account.subindustry, internalId: account.internalId, status: account.status ?? "new", topics,
      coverage: { ...account.coverage, citedObservations: new Set(topics.flatMap(topic => topic.sources.map(source => source.observationId))).size } }];
  });
  return { enabled: raw.enabled, topics: selected, mode, visibility, policy, topicCounts: raw.topicCounts ?? {}, accounts, hasMore: raw.hasMore, nextCursor: raw.nextCursor,
    coverage: raw.coverage ?? null, coverageLimited: true,
    note: visibility === "explore" ? "Exploration includes direct-company native answers at 50% or above. Lower-probability traits are possibilities for research, not established support. Stored answers, Triggers and TAM grades are unchanged." : "Matches use current cached public evidence. Coverage grows as sources are collected and interpreted; an unmatched trait may still be unknown. These operating traits do not change TAM grades." };
}

export type TopicSearchResult = ReturnType<typeof buildTopicSearchResult>;
