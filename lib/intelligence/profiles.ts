import type { SemanticCriterion } from "./evaluation";
import { operatingTopicPriority } from "./businessServices";
import { DEFAULT_VISIBILITY_POLICY, type VisibilityPolicy } from "./visibility";

export const OPERATING_TOPICS = {
  multi_entity: ["Multiple operating entities", "Does this evidence explicitly establish that the specified company operates multiple legal entities, subsidiaries or business units? A customer or supplier's entities do not count."],
  project_billing: ["Project and contract accounting", "Does the specified company's own business explicitly involve project costing, milestone billing, time-and-material billing, retainage or contract revenue accounting?"],
  recurring_revenue: ["Recurring revenue", "Does the evidence establish the specified company's own subscriptions, recurring service agreements, maintenance contracts or usage-based recurring billing?"],
  inventory: ["Operating inventory and supplies", "Does this service or transportation company explicitly manage its own operating supplies, parts, document stock or physical inventory? Client inventory or a generic service capability is insufficient."],
  multi_location: ["Multiple operating locations", "Does the evidence establish multiple operating branches, offices, facilities or geographic operating units belonging to the specified company? A list of customer locations does not count."],
  systems_project: ["Systems change", "Does the source explicitly describe an actual planned or underway accounting/ERP/business-systems implementation, replacement or integration at the specified company? A job mentioning software experience alone is insufficient."],
  acquisition_integration: ["Acquisition integration", "Does the source describe integration or consolidation work after an acquisition made by this company, rather than merely the company being acquired?"],
  government_work: ["Government-related operations", "Does the evidence explicitly establish the specified company performing government-funded work, as a prime or subcontractor? Registration, eligibility, solicitation or willingness to work for government is insufficient. This is context, not an authoritative award match."],
  project_delivery: ["Project-based service delivery", "Does this company itself deliver defined client projects, engagements, campaigns, assignments or matters? Explicit project delivery counts without assuming project accounting, utilization measurement or a billing method."],
  project_financials: ["Project margin and utilization", "Does the company's own evidence explicitly describe project/job profitability, engagement margins, billable utilization, work-in-progress accounting or resource-to-project financial reporting? Merely delivering projects is insufficient."],
  unbilled_work: ["Unbilled work and billing leakage", "Does this company's evidence explicitly describe unbilled time/work, billing backlog, revenue leakage, delayed timesheets or difficulty turning delivered services into invoices? Do not infer a problem from its industry."],
  close_reporting: ["Close and reporting", "Does the company explicitly describe a finance close/reporting process, manual reconciliations or an initiative to improve financial reporting? Distinguish routine responsibilities from an actual improvement mandate; do not invent pain."],
  financial_controls: ["Financial controls and audit", "Does this company explicitly describe financial audit readiness, transaction approval controls, finance-control remediation or public-company financial reporting preparation? General cybersecurity certification alone does not count."],
  cash_working_capital: ["Cash and working capital", "Does the company explicitly describe cash forecasting, collections, AR/AP automation, cash application or working-capital process requirements? A financing announcement alone does not establish these processes."],
  finance_leadership: ["Finance leadership mandate", "Does the evidence give this company's finance leader or finance role an explicit mandate to change systems, reporting, controls, close or finance operations? A generic hire, routine duties or prior-employer experience alone is insufficient."],
  workforce_billing: ["Workforce and service billing", "Does this company explicitly coordinate employee or contractor time, shifts, pay/bill rates, payroll-to-billing handoffs or service time billed to clients? A staffing label alone does not prove the workflow."],
  subcontractor_costs: ["Subcontractor cost coordination", "Does this company's own service delivery explicitly involve external contractors, linguists, freelancers or subcontractors whose costs must be associated with client work? Do not confuse subcontractors with customers."],
  client_profitability: ["Client and engagement profitability", "Does the evidence explicitly discuss this company's client/account/engagement profitability, cost-to-serve, pass-through expenses or margin reporting? Offering financial advice to customers does not count."],
  media_rights: ["Media rights and royalties", "Does this company's business explicitly involve licensing content or intellectual property, rights management, royalties or creator/publisher revenue sharing? Ordinary marketing services alone are insufficient."],
  fleet_costs: ["Fleet and transportation costs", "Does this company's own transport operations explicitly involve fleet maintenance costs, driver/carrier settlements, trip/lane costs or dispatch/TMS-to-finance handoffs? Customer logistics or an excluded third-party fulfillment business is not the target."],
  investor_reporting: ["Investor and lender reporting", "Does this company explicitly describe board/investor/lender reporting, a sponsor's finance modernization agenda, standalone carve-out finance or a TSA systems-exit deadline? Funding/PE ownership alone is insufficient."],
} as const;

export type OperatingTopic = keyof typeof OPERATING_TOPICS;
// Retain the original bounded pack for partially completed, already-paid jobs.
export const OPERATING_CRITERIA: SemanticCriterion[] = Object.entries(OPERATING_TOPICS).slice(0, 8).map(([id, [, instructions]]) => ({ id,
  instructions: id === "inventory" ? "Does the evidence establish that this company manages physical inventory, manufacturing, warehousing or distribution in its own operations?" : instructions }));
export function operatingCriteria(subindustry: string | null, sourceKind: string, researchTopics?: unknown): SemanticCriterion[] {
  const requested = Array.isArray(researchTopics) ? researchTopics.filter((id): id is OperatingTopic => typeof id === "string" && Object.hasOwn(OPERATING_TOPICS, id)).slice(0, 21) : [];
  return [...new Set(["project_delivery", "multi_entity", "multi_location", ...requested, ...operatingTopicPriority(subindustry, sourceKind)])]
    .filter((id): id is OperatingTopic => Object.hasOwn(OPERATING_TOPICS, id)).slice(0, 10)
    .map(id => ({ id, instructions: OPERATING_TOPICS[id][1] }));
}
export type TopicEvidence = { topic: OperatingTopic; probability: number; start: number; end: number;
  companyRelationship?: string; companyRelevance?: number };
const supportedProbability = (value: unknown, minimum = DEFAULT_VISIBILITY_POLICY.topicProbability) => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= 1;
/** New references carry their own packet attribution. Legacy references fall
 * back to the old observation attribution until the saved-packet backfill runs. */
export function topicReferenceSupported(reference: TopicEvidence, attributes: Record<string, unknown>, text: string, policy: VisibilityPolicy = DEFAULT_VISIBILITY_POLICY): boolean {
  const hasOwnAttribution = Object.hasOwn(reference, "companyRelationship") || Object.hasOwn(reference, "companyRelevance");
  const relationship = hasOwnAttribution ? reference.companyRelationship : attributes.companyRelationship;
  const relevance = hasOwnAttribution ? reference.companyRelevance : attributes.companyRelevance;
  return relationship === "direct" && supportedProbability(relevance, policy.companyRelevance) && supportedProbability(reference.probability, policy.topicProbability)
    && Number.isInteger(reference.start) && Number.isInteger(reference.end)
    && reference.start >= 0 && reference.end > reference.start && reference.end <= text.length;
}
export type ProfileObservation = {
  id: string; source_url: string; title: string; source_kind: string; event_date: string | null; observed_at: string;
  evidence_text: string; attributes: Record<string, unknown> | null;
  feedback_excluded?: boolean;
};

/** Exploration reads already-paid packet answers, including values omitted from
 * the supported-topic cache. It never changes those answers or their attribution. */
export function topicReferences(attributes: Record<string, unknown>, includeAllNative = false): TopicEvidence[] {
  const stored = Array.isArray(attributes.topicEvidence) ? attributes.topicEvidence as TopicEvidence[] : [];
  if (!includeAllNative || !Array.isArray(attributes.packetFindings)) return stored;
  const packets = attributes.packetFindings as Record<string, unknown>[];
  return [...stored, ...packets.flatMap(packet => {
    if (!packet || !packet.attributes || typeof packet.attributes !== "object" || !packet.criteria || typeof packet.criteria !== "object") return [];
    const a = packet.attributes as Record<string, unknown>;
    return Object.entries(packet.criteria).filter(([topic, value]) => Object.hasOwn(OPERATING_TOPICS, topic) && typeof value === "number" && Number.isFinite(value))
      .map(([topic, probability]) => ({ topic: topic as OperatingTopic, probability: probability as number, start: packet.start as number, end: packet.end as number,
        companyRelationship: a.companyRelationship as string, companyRelevance: a.companyRelevance as number }));
  })];
}

/** Evidence-backed public context. It never writes a qualification grade. */
export function buildOperatingProfile(rows: ProfileObservation[], now = Date.now(), policy: VisibilityPolicy = DEFAULT_VISIBILITY_POLICY) {
  rows = rows.filter(row => !row.feedback_excluded);
  const topics = Object.entries(OPERATING_TOPICS).map(([id, [label]]) => {
    const sources = rows.flatMap(row => {
      const attributes = row.attributes;
      if (!attributes) return [];
      const references = topicReferences(attributes, policy.topicProbability < DEFAULT_VISIBILITY_POLICY.topicProbability);
      const match = references.filter(reference => reference && reference.topic === id && topicReferenceSupported(reference, attributes, row.evidence_text, policy))
        .sort((a, b) => b.probability - a.probability)[0];
      if (!match) return [];
      const context = row.evidence_text.slice(match.start, match.end);
      return [{ observationId: row.id, url: row.source_url, title: row.title, eventDate: row.event_date,
        observedAt: row.observed_at, sourceKind: row.source_kind, probability: match.probability,
        contextPreview: context.slice(0, 900), previewTruncated: context.length > 900,
        start: match.start, end: match.end, companyRelevance: match.companyRelevance ?? attributes.companyRelevance }];
    });
    // A feed and a site crawl can discover the same page; do not imply corroboration.
    const distinct = [...new Map(sources.map(source => [source.url, source])).values()].slice(0, 5);
    const supported = distinct.some(source => source.probability >= DEFAULT_VISIBILITY_POLICY.topicProbability && Number(source.companyRelevance) >= DEFAULT_VISIBILITY_POLICY.companyRelevance);
    return { id, label, state: distinct.length ? supported ? "supported" : "exploratory" : "unknown", sources: distinct };
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
  const findings = rows.flatMap(row => {
    const packets = Array.isArray(row.attributes?.packetFindings) ? row.attributes.packetFindings as Record<string, unknown>[] : row.attributes ? [row.attributes] : [];
    return packets.map((packet, index) => {
      const attributes = (packet.attributes && typeof packet.attributes === "object" ? packet.attributes : packet) as Record<string, unknown>;
      return { id: `${row.id}:${index}`, observationId: row.id, title: row.title, url: row.source_url, eventDate: row.event_date,
        observedAt: row.observed_at, sourceKind: row.source_kind,
        dateState: !row.event_date ? "unknown" : Date.parse(row.event_date) > now ? "future" : now - Date.parse(row.event_date) > DEFAULT_VISIBILITY_POLICY.eventMaxAgeDays * 86400000 ? "historical" : "dated",
        historical: row.event_date ? now - Date.parse(row.event_date) > DEFAULT_VISIBILITY_POLICY.eventMaxAgeDays * 86400000 : null,
        signalType: attributes.signalType, attributes, criteria: packet.criteria ?? {}, rawAnswers: packet.rawAnswers ?? null,
        model: packet.model, questionVersion: packet.questionVersion, publication: packet.publication ?? null,
        excerpt: packet.evidenceExcerpt ?? null, start: packet.excerptStart ?? null, end: packet.excerptEnd ?? null };
    });
  });
  const developments = findings.filter(finding => finding.attributes.companyRelationship === "direct"
    && supportedProbability(finding.attributes.companyRelevance, DEFAULT_VISIBILITY_POLICY.companyRelevance) && Number(finding.attributes.concreteEvent) >= DEFAULT_VISIBILITY_POLICY.concreteEvent);
  return { topics, hypotheses, developments, findings, unknowns: topics.filter(topic => topic.state === "unknown").map(topic => topic.label),
    coverage: { observations: rows.length, interpreted: rows.filter(row => row.attributes).length },
    note: "Public operating context; hypotheses remain unverified and do not change the TAM grade." };
}
