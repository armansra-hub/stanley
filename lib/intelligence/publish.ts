import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordTrigger, recomputePriority, type TriggerInput } from "@/lib/db/triggers";
import { reheatCompanyForFreshSignal } from "@/lib/db/reheat";
import { serviceClient } from "@/lib/supabase/server";
import { isPublishableTriggerForCompany } from "@/lib/triggers/signalIntegrity";
import { canonicalEvidenceUrl } from "./observations";
import type { EvaluateEvidenceResult, EvidenceAttributes, RawEvaluationAnswer } from "./evaluation";
import { readTriggerSourceEvidence, type TriggerSourceEvidence } from "./triggerEvidence";
import type { IntelligenceEvent } from "./events";

type Evaluation = Extract<EvaluateEvidenceResult, { ok: true }>;
export type JevPublicationCompany = { id: string; name: string; status?: string; record_dead?: boolean | null; description?: string | null; subindustry?: string | null; ns_industry?: string | null };
export type JevPublicationObservation = { id: string; company_id: string; source_kind: string; source_url: string; title: string; evidence_text: string;
  event_date: string | null; observed_at: string; is_current: boolean; metadata: Record<string, unknown> };
export type JevFindingReceipt = {
  version: "jev-finding-v1"; operationKey: string; observationId: string; interpretation: "jev"; independentlyVerified: false;
  model: string; questionVersion: string; attributes: EvidenceAttributes; criteria: Record<string, number>;
  provider: "typesafe-direct"; responseModel?: string; confidence: Record<string, number>;
  rawAnswers?: Record<string, RawEvaluationAnswer>;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  eventId?: string;
};
export type JevPublicationReceipt = { status: "published" | "already_published" | "context_attached"; triggerId: string; operationKey: string } |
  { status: "not_eligible"; reason: string; triggerId?: string };

/** Existing feed-routing rules; these do not alter Jev output or add a second opinion. */
export function jevPublicationRoute(result: Evaluation, eventDate: string | null, now = Date.now()): { type: string | null; reason: string } {
  const a = result.attributes;
  const classified = ["stanley-business-services-v2", "stanley-business-services-v3"].includes(result.questionVersion);
  if (classified) {
    // These are Jev's choices from the original evidence request, not another
    // interpretation or a headline/keyword filter. Old paid contracts are unchanged.
    if (a.contractActivity === "government_award") return { type: null, reason: "government_publisher_required" };
    if (a.contentClass !== "actual_company_development") return { type: null, reason: `content_${a.contentClass ?? "unknown"}` };
    if (!["subject", "service_provider", "customer", "partner"].includes(a.companyRole ?? "unknown"))
      return { type: null, reason: `company_role_${a.companyRole ?? "unknown"}` };
    if (a.operatingChangeType === "contract_award" && a.contractActivity !== "commercial_award")
      return { type: null, reason: "contract_award_not_established" };
  }
  const allowed = new Set(["funding", "ma", "new_entity", "finance_hire", "press", "operating_change", "erp_tech", "hiring_velocity", "employee_growth"]);
  const relevantChange = ["systems_project", "finance_leadership", "close_reporting", "financial_controls", "cash_working_capital", "investor_reporting", "project_financials", "unbilled_work"].some(id => (result.criteria[id] ?? 0) >= .8);
  // Keep Jev's news label intact; this only selects an existing worklist category.
  const type = a.signalType === "news" && (relevantChange || (classified && a.contractActivity === "commercial_award")) ? "operating_change" : a.signalType;
  if (!allowed.has(type)) return { type: null, reason: "operating_context_only" };
  if (a.companyRelationship !== "direct") return { type: null, reason: "not_direct_company" };
  if (a.companyRelevance < .8) return { type: null, reason: "company_relevance" };
  if (a.concreteEvent < .75) return { type: null, reason: "no_concrete_development" };
  if (a.signalType === "ma" && a.isAcquirer < .8) return { type: null, reason: "not_acquirer" };
  const age = eventDate ? now - Date.parse(eventDate) : NaN;
  if (!Number.isFinite(age)) return { type: null, reason: "unknown_event_date" };
  if (age < 0) return { type: null, reason: "future_event_date" };
  if (age > 180 * 86_400_000) return { type: null, reason: "historical_event" };
  return { type, reason: "dated_development" };
}
export const jevSignalType = (result: Evaluation, eventDate: string | null, now = Date.now()) => jevPublicationRoute(result, eventDate, now).type;

const SCORES = ["companyRelevance", "concreteEvent", "isAcquirer", "operationalComplexity", "growthRelevance", "evidenceStrength", "requiresResearch"] as const;
function probabilityMap(value: Record<string, number> | undefined, limit: number): Record<string, number> {
  const entries = Object.entries(value ?? {});
  if (entries.length > limit || entries.some(([key, score]) => !/^[a-zA-Z0-9_-]{1,80}$/.test(key) || !Number.isFinite(score) || score < 0 || score > 1)) throw new Error("Invalid Jev probability metadata");
  return Object.fromEntries(entries);
}

function findingReceipt(input: { observation: JevPublicationObservation; evaluation: Evaluation; passage: { start: number; end: number; text: string }; eventId?: string }): JevFindingReceipt {
  const { observation, evaluation, passage } = input;
  if (!evaluation.model || evaluation.model.length > 120 || !evaluation.questionVersion || evaluation.questionVersion.length > 120
    || SCORES.some((key) => !Number.isFinite(evaluation.attributes[key]) || evaluation.attributes[key] < 0 || evaluation.attributes[key] > 1)) throw new Error("Invalid Jev publication result");
  const attributes = { signalType: evaluation.attributes.signalType, companyRelationship: evaluation.attributes.companyRelationship,
    evidenceSectionId: evaluation.attributes.evidenceSectionId,
    ...(evaluation.attributes.contentClass !== undefined ? { contentClass: evaluation.attributes.contentClass } : {}),
    ...(evaluation.attributes.companyRole !== undefined ? { companyRole: evaluation.attributes.companyRole } : {}),
    ...(evaluation.attributes.contractActivity !== undefined ? { contractActivity: evaluation.attributes.contractActivity } : {}),
    ...(evaluation.attributes.operatingChangeType !== undefined ? { operatingChangeType: evaluation.attributes.operatingChangeType } : {}),
    ...Object.fromEntries(SCORES.map((key) => [key, evaluation.attributes[key]])) } as EvidenceAttributes;
  if (attributes.evidenceSectionId !== null && (!/^[a-zA-Z0-9_-]{1,80}$/.test(attributes.evidenceSectionId))) throw new Error("Invalid Jev section identity");
  const criteria = probabilityMap(evaluation.criteria, 32);
  const confidence = probabilityMap(evaluation.metadata.confidence, 64);
  // Native answers already passed the provider adapter's schema. Copy their known wire fields
  // exactly; do not normalize, rescore, demand agreement, or call another model.
  const rawAnswers = evaluation.metadata.rawAnswers && Object.fromEntries(Object.entries(evaluation.metadata.rawAnswers).map(([key, answer]) => [key, {
    type: answer.type,
    ...(answer.type === "noul" ? { noul: answer.noul } : answer.type === "choice" ? { choice: answer.choice } : { score: answer.score }),
    ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
    ...(answer.type !== "noul" && answer.probabilities !== undefined ? { probabilities: { ...answer.probabilities } } : {}),
    ...(answer.type === "score" && answer.legend !== undefined ? { legend: { ...answer.legend } } : {}),
  }])) as Record<string, RawEvaluationAnswer> | undefined;
  const usage = evaluation.usage && Object.values(evaluation.usage).every((n) => n === null || (Number.isSafeInteger(n) && n >= 0))
    ? { inputTokens: evaluation.usage.inputTokens, outputTokens: evaluation.usage.outputTokens } : null;
  const operationKey = createHash("sha256").update(JSON.stringify([observation.id, evaluation.model, evaluation.questionVersion, attributes, criteria, rawAnswers, confidence, evaluation.metadata.responseModel, passage.start, passage.end])).digest("hex");
  const receipt: JevFindingReceipt = { version: "jev-finding-v1", operationKey, observationId: observation.id, interpretation: "jev", independentlyVerified: false,
    model: evaluation.model, questionVersion: evaluation.questionVersion, attributes, criteria, confidence, provider: "typesafe-direct", usage,
    ...(rawAnswers ? { rawAnswers } : {}),
    ...(evaluation.metadata.responseModel ? { responseModel: evaluation.metadata.responseModel.slice(0, 120) } : {}) };
  if (input.eventId) receipt.eventId = input.eventId;
  // Allow the adapter's 32 KB native answers plus bounded routing/receipt fields.
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 48_000) throw new Error("Jev publication metadata exceeds bound");
  return receipt;
}

type TriggerReceipt = { id: string; company_id: string; type: string; source_url: string; signal_date: string | null; summary: string;
  source_name: string | null; metadata: Record<string, unknown> | null };
type Dependencies = {
  record?: (companyId: string, trigger: TriggerInput & { jevFinding: JevFindingReceipt }) => Promise<boolean>;
  find?: (companyId: string, url: string) => Promise<TriggerReceipt | null>;
  findEvent?: (companyId: string, eventId: string) => Promise<TriggerReceipt | null>;
  reheat?: (companyId: string, type: string, url: string, date: string | null) => Promise<unknown>;
  priority?: (companyId: string) => Promise<unknown>;
  now?: () => number;
  attach?: (triggerId: string, companyId: string, sourceUrl: string, finding: JevFindingReceipt, evidence: TriggerSourceEvidence) => Promise<boolean>;
};

async function attachFinding(triggerId: string, companyId: string, sourceUrl: string, finding: JevFindingReceipt, evidence: TriggerSourceEvidence): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("intelligence_attach_trigger_finding", {
    p_trigger: triggerId, p_company: companyId, p_source_url: sourceUrl, p_finding: finding, p_evidence: evidence,
  });
  if (error || data !== true) throw new Error("Jev source context attachment was not confirmed");
  return true;
}

async function readReceipt(companyId: string, url: string): Promise<TriggerReceipt | null> {
  const { data, error } = await serviceClient().from("triggers").select("id,company_id,type,source_url,signal_date,summary,source_name,metadata")
    .eq("company_id", companyId).eq("source_url", url).maybeSingle();
  if (error) throw new Error("Jev publication readback failed");
  return data;
}

async function readEventReceipt(companyId: string, eventId: string): Promise<TriggerReceipt | null> {
  const { data, error } = await serviceClient().from("triggers").select("id,company_id,type,source_url,signal_date,summary,source_name,metadata")
    .eq("company_id", companyId).eq("metadata->jevFinding->>eventId", eventId).maybeSingle();
  if (error) throw new Error("Jev event publication readback failed");
  return data;
}

/** Direct publication of Jev's interpretation. No candidate queue, generative model, or independent review. */
export async function publishJevFinding(input: { company: JevPublicationCompany; observation: JevPublicationObservation; evaluation: Evaluation;
  passage: { start: number; end: number; text: string } | null; event?: IntelligenceEvent | null }, deps: Dependencies = {}): Promise<JevPublicationReceipt> {
  const { company, observation, evaluation, passage } = input;
  if (company.id !== observation.company_id) throw new Error("Jev publication account mismatch");
  if (input.event && input.event.company_id !== company.id) throw new Error("Jev event account mismatch");
  if (!observation.is_current || company.status === "removed_from_tam") return { status: "not_eligible", reason: "superseded" };
  // Any government capture continues through the verified entity pipeline, including a model mislabel.
  if (observation.source_kind === "government") return { status: "not_eligible", reason: "government_publisher_required" };
  const route = jevPublicationRoute(evaluation, observation.event_date, (deps.now ?? Date.now)());
  const type = route.type;
  if (!type) return { status: "not_eligible", reason: route.reason };
  if (!passage || !evaluation.attributes.evidenceSectionId) return { status: "not_eligible", reason: "no_selected_source_passage" };
  const evidence: TriggerSourceEvidence = { observationId: observation.id, excerpt: passage.text, start: passage.start, end: passage.end, observedAt: observation.observed_at };
  if (!readTriggerSourceEvidence({ intelligenceEvidence: evidence }) || observation.evidence_text.slice(passage.start, passage.end) !== passage.text) throw new Error("Jev publication source passage mismatch");
  const url = canonicalEvidenceUrl(observation.source_url);
  const sourceName = observation.source_kind === "job" ? "Jev · ATS job posting" : observation.source_kind === "website" ? "Jev · Company website" : "Jev · Public news";
  const finding = findingReceipt({ observation, evaluation, passage, eventId: input.event?.id });
  const trigger = { type, summary: observation.title.slice(0, 280), source_name: sourceName, source_url: url,
    signal_date: observation.event_date, intelligenceEvidence: evidence, jevFinding: finding };
  if (!isPublishableTriggerForCompany(trigger, company)) return { status: "not_eligible", reason: "source_or_company_policy" };
  const find = deps.find ?? readReceipt;
  const findEvent = deps.findEvent ?? readEventReceipt;
  const existing = (input.event ? await findEvent(company.id, input.event.id) : null) ?? await find(company.id, url);
  let inserted = false;
  if (!existing) inserted = await (deps.record ?? recordTrigger)(company.id, trigger);
  // recordTrigger's false means either dedupe or failure. Only exact persisted state resolves that ambiguity.
  const saved = existing ?? (input.event ? await findEvent(company.id, input.event.id) : null) ?? await find(company.id, url);
  if (!saved || saved.company_id !== company.id) throw new Error("Jev publication has no exact source receipt");
  const savedFinding = saved.metadata?.jevFinding as Partial<JevFindingReceipt> | undefined;
  // The database's unique account/event key resolves simultaneous syndicated
  // reports. Keep the first published report, source and raw interpretation;
  // the event binding adds all later reports as additional source context.
  if (input.event && savedFinding?.eventId === input.event.id && savedFinding.operationKey !== finding.operationKey) {
    if (!isPublishableTriggerForCompany(saved, company)) return { status: "not_eligible", reason: "source_or_company_policy", triggerId: saved.id };
    if (!await (deps.attach ?? attachFinding)(saved.id, company.id, url, finding, evidence)) throw new Error("Jev source context attachment was not confirmed");
    await (deps.priority ?? recomputePriority)(company.id);
    return { status: "already_published", triggerId: saved.id, operationKey: savedFinding.operationKey ?? finding.operationKey };
  }
  if (saved.source_url !== url) throw new Error("Jev publication has no exact source receipt");
  if (savedFinding?.operationKey !== finding.operationKey) {
    // Append context atomically without overwriting the source owner's original
    // interpretation, summary, date, provenance or native Jev answer.
    if (existing || !inserted) {
      if (!isPublishableTriggerForCompany(saved, company)) return { status: "not_eligible", reason: "source_or_company_policy", triggerId: saved.id };
      if (!await (deps.attach ?? attachFinding)(saved.id, company.id, url, finding, evidence)) throw new Error("Jev source context attachment was not confirmed");
      await (deps.priority ?? recomputePriority)(company.id);
      return { status: "context_attached", triggerId: saved.id, operationKey: finding.operationKey };
    }
    throw new Error("Jev publication metadata was not retained");
  }
  const savedEvidence = readTriggerSourceEvidence(saved.metadata);
  if (saved.type !== type || Date.parse(saved.signal_date ?? "") !== Date.parse(observation.event_date ?? "")
    || !isDeepStrictEqual(savedFinding, finding)
    || !savedEvidence || !isDeepStrictEqual(savedEvidence, evidence)) throw new Error("Jev publication receipt mismatch");
  if (!isPublishableTriggerForCompany(saved, company)) return { status: "not_eligible", reason: "source_or_company_policy", triggerId: saved.id };
  // Retry side effects even after an earlier insert succeeded and its response/checkpoint was lost.
  await (deps.reheat ?? ((id, kind, source, date) => reheatCompanyForFreshSignal(id, kind, source, date, { strict: true })))(company.id, type, url, observation.event_date);
  await (deps.priority ?? recomputePriority)(company.id);
  return { status: inserted ? "published" : "already_published", triggerId: saved.id, operationKey: finding.operationKey };
}
