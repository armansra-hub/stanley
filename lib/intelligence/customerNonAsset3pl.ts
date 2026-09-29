import { buildOperatingProfile, topicReferenceSupported, type ProfileObservation, type TopicEvidence } from "./profiles";
import type { OperatingMatchTopic } from "./topicSearch";

export const NON_ASSET_3PL_TOPIC = "non_asset_based_3pl";
export type NonAssetObservation = ProfileObservation & { company_id: string; is_current: boolean };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function safeUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

/** Reuses existing Jev answers only. Brokerage, missing fleet facts and website
 * keywords never manufacture a non-asset classification. No provider call. */
export function savedNonAsset3plProof(rows: NonAssetObservation[]): Map<string, OperatingMatchTopic> {
  const companies = new Map<string, NonAssetObservation[]>();
  for (const row of rows) {
    if (!row.is_current || row.feedback_excluded || !safeUrl(row.source_url) || typeof row.evidence_text !== "string") continue;
    const group = companies.get(row.company_id) ?? [];
    group.push(row); companies.set(row.company_id, group);
  }
  const result = new Map<string, OperatingMatchTopic>();
  for (const [companyId, observations] of companies) {
    const topic = buildOperatingProfile(observations).topics.find(item => item.id === NON_ASSET_3PL_TOPIC);
    if (topic?.state !== "supported" || !topic.sources.length) continue;
    // Keep the original stored objects for the exact displayed observations.
    // Older receipts may contain accepted topicEvidence without packet rawAnswers.
    const receipts = topic.sources.flatMap(source => {
      const row = observations.find(item => item.id === source.observationId)!;
      const attributes = row.attributes!;
      const accepted = (Array.isArray(attributes.topicEvidence) ? attributes.topicEvidence : []).filter((reference: TopicEvidence) =>
        reference && reference.topic === NON_ASSET_3PL_TOPIC && reference.start === source.start && reference.end === source.end
        && topicReferenceSupported(reference, attributes, row.evidence_text));
      const packets = (Array.isArray(attributes.packetFindings) ? attributes.packetFindings : []).filter(packet =>
        object(packet) && object(packet.criteria) && packet.start === source.start && packet.end === source.end
        && packet.criteria[NON_ASSET_3PL_TOPIC] === source.probability);
      return [{ observationId: row.id, topicEvidence: accepted, packetFindings: packets }];
    });
    result.set(companyId, { ...topic, nativeResult: { savedObservationReceipts: receipts } });
  }
  return result;
}
