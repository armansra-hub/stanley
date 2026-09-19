import type { SemanticCriterion } from "./evaluation";

export const OPERATING_TOPICS = {
  multi_entity: ["Multiple operating entities", "Does this evidence explicitly establish that the specified company operates multiple legal entities, subsidiaries or business units? A customer or supplier's entities do not count."],
  project_billing: ["Project and contract accounting", "Does the specified company's own business explicitly involve project costing, milestone billing, time-and-material billing, retainage or contract revenue accounting?"],
  recurring_revenue: ["Recurring revenue", "Does the evidence establish the specified company's own subscriptions, recurring service agreements, maintenance contracts or usage-based recurring billing?"],
  inventory: ["Inventory and fulfillment", "Does the evidence establish that this company manages physical inventory, manufacturing, warehousing or distribution in its own operations?"],
  multi_location: ["Multiple operating locations", "Does the evidence establish multiple operating branches, offices, facilities or geographic operating units belonging to the specified company? A list of customer locations does not count."],
  systems_project: ["Systems change", "Does the source explicitly describe an actual planned or underway accounting/ERP/business-systems implementation, replacement or integration at the specified company? A job mentioning software experience alone is insufficient."],
  acquisition_integration: ["Acquisition integration", "Does the source describe integration or consolidation work after an acquisition made by this company, rather than merely the company being acquired?"],
  government_work: ["Government-related operations", "Does the evidence explicitly establish the specified company performing government-funded work, as a prime or subcontractor? Registration, eligibility, solicitation or willingness to work for government is insufficient. This is context, not an authoritative award match."],
} as const;

export type OperatingTopic = keyof typeof OPERATING_TOPICS;
export const OPERATING_CRITERIA: SemanticCriterion[] = Object.entries(OPERATING_TOPICS).map(([id, [, instructions]]) => ({ id, instructions }));
export type TopicEvidence = { topic: OperatingTopic; probability: number; start: number; end: number };
export type ProfileObservation = {
  id: string; source_url: string; title: string; source_kind: string; event_date: string | null; observed_at: string;
  evidence_text: string; attributes: Record<string, unknown> | null;
  feedback_excluded?: boolean;
};

/** Evidence-backed public context. It never writes a qualification grade. */
export function buildOperatingProfile(rows: ProfileObservation[], now = Date.now()) {
  rows = rows.filter(row => !row.feedback_excluded);
  const topics = Object.entries(OPERATING_TOPICS).map(([id, [label]]) => {
    const sources = rows.flatMap(row => {
      const attributes = row.attributes;
      if (attributes?.companyRelationship !== "direct" || Number(attributes.companyRelevance) < .8) return [];
      const references = Array.isArray(attributes.topicEvidence) ? attributes.topicEvidence as TopicEvidence[] : [];
      const match = references.filter(reference => reference.topic === id && reference.probability >= .8
        && Number.isInteger(reference.start) && Number.isInteger(reference.end)
        && reference.start >= 0 && reference.end > reference.start && reference.end <= row.evidence_text.length)
        .sort((a, b) => b.probability - a.probability)[0];
      if (!match) return [];
      const context = row.evidence_text.slice(match.start, match.end);
      return [{ observationId: row.id, url: row.source_url, title: row.title, eventDate: row.event_date,
        observedAt: row.observed_at, sourceKind: row.source_kind, probability: match.probability,
        contextPreview: context.slice(0, 900), previewTruncated: context.length > 900,
        start: match.start, end: match.end }];
    });
    // A feed and a site crawl can discover the same page; do not imply corroboration.
    const distinct = [...new Map(sources.map(source => [source.url, source])).values()].slice(0, 5);
    return { id, label, state: distinct.length ? "supported" : "unknown", sources: distinct };
  });
  const present = new Set(topics.filter(topic => topic.state === "supported").map(topic => topic.id));
  const hypotheses: { text: string; topics: string[]; status: "unverified" }[] = [];
  if (present.has("acquisition_integration") && present.has("multi_entity")) hypotheses.push({
    text: "Acquisition integration across operating entities may increase reconciliation and consolidated-reporting work. The current systems, actual friction and business impact remain unverified.",
    topics: ["acquisition_integration", "multi_entity"], status: "unverified" });
  if (present.has("project_billing") && present.has("multi_location")) hypotheses.push({
    text: "Project billing across locations may make project profitability and billing coordination more demanding. Whether current processes create delays or extra work remains unverified.",
    topics: ["project_billing", "multi_location"], status: "unverified" });
  if (present.has("recurring_revenue") && present.has("inventory")) hypotheses.push({
    text: "Recurring agreements alongside physical products may require coordination between fulfillment, billing and revenue reporting. No systems limitation or buying intent has been established.",
    topics: ["recurring_revenue", "inventory"], status: "unverified" });
  const developments = rows.filter(row => Number(row.attributes?.companyRelevance) >= .8 && Number(row.attributes?.concreteEvent) >= .75)
    .map(row => ({ id: row.id, title: row.title, url: row.source_url, eventDate: row.event_date,
      historical: row.event_date ? now - Date.parse(row.event_date) > 90 * 86400000 : null,
      signalType: row.attributes?.signalType, excerpt: row.attributes?.evidenceExcerpt ?? null }));
  return { topics, hypotheses, developments, unknowns: topics.filter(topic => topic.state === "unknown").map(topic => topic.label),
    coverage: { observations: rows.length, interpreted: rows.filter(row => row.attributes).length },
    note: "Public operating context; hypotheses remain unverified and do not change the TAM grade." };
}
