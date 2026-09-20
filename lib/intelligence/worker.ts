import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { evaluateEvidence, estimateEvidenceInputTokens, evidenceRequestFingerprint, JEV_QUESTION_VERSION, JEV_PUBLIC_SCALE_QUESTION_VERSION, JEV_BUSINESS_SERVICES_QUESTION_VERSION, JEV_BUSINESS_SERVICES_V2_QUESTION_VERSION, JEV_BUSINESS_SERVICES_V3_QUESTION_VERSION } from "./jev";
import { loadCompanyIdentityContext } from "@/lib/companyIdentity";
import { publishJevFinding, jevSignalType, type JevPublicationReceipt } from "./publish";
import type { EvaluateEvidenceInput, EvaluateEvidenceResult } from "./evaluation";
import { intelligenceEnabled, INTELLIGENCE_VERSION } from "./observations";
import { secondsUntilNextMonth } from "./budget";
import { durableJevRequest, reconcileJevReceipts, type JevWorkload } from "./jevRequests";
import { OPERATING_CRITERIA, OPERATING_TOPICS, operatingCriteria, type OperatingTopic } from "./profiles";
import { businessServicesResearchContext } from "./businessServices";
import { loadFeedbackExamples } from "./feedback";
import { reconcileObservationEvent, EventReconciliationDeferred, bindEventTrigger } from "./events";
import { queueAccountStory } from "./narratives";
import { buildPublicScaleContext, loadPublicScaleObservations, type PublicScaleContext, type PublicContextObservation } from "./publicContext";
import { DEFAULT_VISIBILITY_POLICY } from "./visibility";

type Evaluation = Extract<EvaluateEvidenceResult, { ok: true }>;
export type PartResult = { start: number; end: number; evaluation: Evaluation };
type PacketPublication = { start: number; end: number; questionVersion: string; attemptedAt: string; outcome: JevPublicationReceipt };
type PendingRequest = { start: number; end: number; input: EvaluateEvidenceInput; fingerprint: string };
type Job = { id: string; observation_id: string; view_id: string | null; kind: "interpret" | "view"; lease_token: string; attempts: number;
  result: { parts?: PartResult[]; publications?: PacketPublication[]; publicScaleContext?: PublicScaleContext; companyIdentityContext?: string;
    pendingRequest?: PendingRequest; routingBackfill?: string } | null };
type Observation = { id: string; company_id: string; source_kind: string; source_url: string; title: string; evidence_text: string;
  event_date: string | null; observed_at: string; is_current: boolean; feedback_excluded?: boolean; metadata: Record<string, unknown> };

/** Cover all retained evidence using bounded packets, preserving exact offsets.
 * Splitting by UTF-8 bytes also bounds non-ASCII input and never bisects a pair. */
export function evidencePackets(text: string, bytes = 8000): { start: number; end: number; text: string }[] {
  if (bytes < 4) throw new Error("Packet capacity too small");
  const out = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + bytes);
    while (Buffer.byteLength(text.slice(start, end), "utf8") > bytes) end = start + Math.max(1, Math.floor((end - start) * 0.85));
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const boundary = text.lastIndexOf("\n", end - 1);
    if (boundary > start + (end - start) / 2) end = boundary + 1;
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

export function nextRetrySeconds(attempt: number): number {
  return Math.min(86_400, 60 * 2 ** Math.min(Math.max(attempt, 1), 10));
}

/** Only explicit collector provenance identifies a baseline. */
export function observationWorkload(metadata: Record<string, unknown>): JevWorkload {
  if (metadata.collectionMode === "baseline") return "initial_coverage";
  if (metadata.focusedResearch === true && metadata.automaticResearch === false) return "manual";
  return "monitoring";
}

/** Assemble the actual worker request before reserving any paid-call budget. */
export function workerEvidenceInput(
  observation: Pick<Observation, "evidence_text" | "source_kind" | "source_url" | "title" | "event_date" | "observed_at"> & { metadata?: Record<string, unknown> },
  company: { name: string; domain?: string | null; subindustry?: string | null; ns_industry?: string | null },
  packet: { start: number; end: number; text: string }, question: string | null,
  feedback: EvaluateEvidenceInput["feedbackExamples"],
  publicScaleContext?: PublicScaleContext,
  businessServices: boolean | "business-services-v1" | "business-services-v2" | "business-services-v3" = "business-services-v3",
  companyIdentityContext?: string,
): EvaluateEvidenceInput {
  const questionPack = businessServices === true ? "business-services-v3" : businessServices || undefined;
  const sourceDates = (Array.isArray(observation.metadata?.sourceDates) ? observation.metadata.sourceDates : [])
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value))
    .slice(0, 12).map(value => Object.fromEntries(["kind", "value", "source"].flatMap(key =>
      typeof value[key] === "string" && Buffer.byteLength(value[key], "utf8") <= 160 ? [[key, value[key]]] : [])));
  while (Buffer.byteLength(JSON.stringify(sourceDates), "utf8") > 1600) sourceDates.pop();
  const surroundingContext = [
    packet.start > 0 ? `Source introduction: ${evidencePackets(observation.evidence_text, 800)[0]?.text ?? ""}` : "",
    packet.start > 0 ? `Immediately before this packet: ${evidencePackets(observation.evidence_text.slice(Math.max(0, packet.start - 200), packet.start), 800)[0]?.text ?? ""}` : "",
    packet.end < observation.evidence_text.length ? `Immediately after this packet: ${evidencePackets(observation.evidence_text.slice(packet.end, packet.end + 200), 800)[0]?.text ?? ""}` : "",
  ].filter(Boolean).join("\n");
  const companyContext = evidencePackets([company.subindustry, company.ns_industry,
    businessServices && company.subindustry?.trim() ? businessServicesResearchContext(company.subindustry) : ""].filter(value => typeof value === "string" && value.trim()).join("; "), 2400)[0]?.text;
  return {
    text: packet.text, companyName: String(company.name), companyDomain: company.domain ?? undefined,
    sourceKind: observation.source_kind, sourceUrl: observation.source_url, title: observation.title,
    eventDate: observation.event_date ?? undefined, observedAt: observation.observed_at,
    ...(companyContext?.trim() ? { companyContext } : {}),
    ...(publicScaleContext ? { publicScaleContext: publicScaleContext.text } : {}),
    ...(surroundingContext ? { surroundingContext } : {}),
    sections: evidencePackets(packet.text, 1200).map(({ text }, i) => ({ id: `s${i + 1}`, text })),
    ...(questionPack ? { questionPack } : {}),
    ...(["business-services-v2", "business-services-v3"].includes(questionPack || "") ? {
      ...(companyIdentityContext ? { companyIdentityContext } : {}),
      eventDateBasis: typeof observation.metadata?.eventDateBasis === "string" && Buffer.byteLength(observation.metadata.eventDateBasis, "utf8") <= 128 ? observation.metadata.eventDateBasis : "unknown",
      ...(sourceDates.length ? { sourceDateContext: JSON.stringify(sourceDates) } : {}),
    } : {}),
    ...(typeof observation.metadata?.evidenceKind === "string" ? { evidenceKind: observation.metadata.evidenceKind } : {}),
    criteria: question ? [{ id: "view_match", instructions: question }] : businessServices ? operatingCriteria(company.subindustry ?? null, observation.source_kind, observation.metadata?.researchTopics) : OPERATING_CRITERIA,
    feedbackExamples: feedback, privacy: "public",
  };
}

/** Selection is an interpretation aid, not an alternate trigger publisher. */
export const candidateType = jevSignalType;

/** Every paid packet remains available. A representative answer is only a UI
 * summary; it is never the sole source of operating traits or event routing. */
export function packetFinding(observation: Pick<Observation, "evidence_text">, part: PartResult, publication?: JevPublicationReceipt) {
  const section = evidencePackets(observation.evidence_text.slice(part.start, part.end), 1200)
    .map((value, index) => ({ ...value, id: `s${index + 1}` })).find(value => value.id === part.evaluation.attributes.evidenceSectionId);
  const excerptStart = section ? part.start + section.start : null;
  const excerptEnd = section ? part.start + section.end : null;
  return { start: part.start, end: part.end, attributes: part.evaluation.attributes, criteria: part.evaluation.criteria,
    model: part.evaluation.model, questionVersion: part.evaluation.questionVersion, rawAnswers: part.evaluation.metadata.rawAnswers ?? null,
    evidenceExcerpt: excerptStart !== null && excerptEnd !== null ? observation.evidence_text.slice(excerptStart, excerptEnd) : null,
    excerptStart, excerptEnd, ...(publication ? { publication } : {}) };
}

export function aggregatePacketFindings(observation: Pick<Observation, "evidence_text">, parts: PartResult[], publications: PacketPublication[] = []) {
  return {
    packetFindings: parts.map(part => packetFinding(observation, part, publications.find(p => p.start === part.start && p.end === part.end && p.questionVersion === part.evaluation.questionVersion)?.outcome)),
    topicEvidence: parts.filter(p => p.evaluation.attributes.companyRelationship === "direct" && p.evaluation.attributes.companyRelevance >= DEFAULT_VISIBILITY_POLICY.companyRelevance)
      .flatMap(p => Object.entries(p.evaluation.criteria).filter(([topic, probability]) => Object.hasOwn(OPERATING_TOPICS, topic) && probability >= DEFAULT_VISIBILITY_POLICY.topicProbability)
        .map(([topic, probability]) => ({ topic: topic as OperatingTopic, probability, start: p.start, end: p.end,
          companyRelationship: p.evaluation.attributes.companyRelationship, companyRelevance: p.evaluation.attributes.companyRelevance }))),
  };
}

async function finish(job: Job, status: string, result: unknown, extra: Record<string, unknown> = {}) {
  const { data, error } = await serviceClient().rpc("intelligence_finish", {
    p_id: job.id, p_lease: job.lease_token, p_status: status, p_result: result, ...extra,
  });
  if (error || data !== true) throw new Error("Intelligence lease completion was not confirmed");
}

async function runJob(job: Job, deadline: number, publicContexts: Map<string, Promise<PublicContextObservation[]>>, identityContexts: Map<string, Promise<string>>): Promise<string> {
  const db = serviceClient();
  const { data: raw, error } = await db.from("intelligence_observations").select("*").eq("id", job.observation_id).single();
  if (error || !raw) throw new Error("Observation unavailable");
  const observation = raw as Observation;
  if (!observation.is_current || observation.feedback_excluded) { await finish(job, "superseded", {}); return "superseded"; }
  const { data: company, error: companyError } = await db.from("companies")
    .select("id,name,domain,website_raw,city,state,netsuite_internal_id,status,record_dead,description,subindustry,ns_industry")
    .eq("id", observation.company_id).single();
  if (companyError) throw new Error("Account unavailable");
  if (!company || company.status === "removed_from_tam") { await finish(job, "superseded", {}); return "superseded"; }
  let question: string | null = null;
  if (job.kind === "view") {
    const { data: view, error: viewError } = await db.from("intelligence_views").select("question,active").eq("id", job.view_id).single();
    if (viewError) throw new Error("Saved view unavailable");
    if (!view?.active) { await finish(job, "superseded", {}); return "superseded"; }
    question = view.question;
  }
  const feedback = await loadFeedbackExamples(observation.company_id);
  const priorParts = (job.result?.parts ?? []).filter(part => [JEV_QUESTION_VERSION, JEV_PUBLIC_SCALE_QUESTION_VERSION, JEV_BUSINESS_SERVICES_QUESTION_VERSION, JEV_BUSINESS_SERVICES_V2_QUESTION_VERSION, JEV_BUSINESS_SERVICES_V3_QUESTION_VERSION].includes(part.evaluation.questionVersion));
  // Preserve already-paid v2 work under its original contract. New jobs receive
  // public baseline context; no completed Jev finding is reviewed again.
  const pendingPack = job.result?.pendingRequest?.input.questionPack;
  const contract = priorParts[0]?.evaluation.questionVersion
    ?? (pendingPack === "business-services-v2" ? JEV_BUSINESS_SERVICES_V2_QUESTION_VERSION
      : pendingPack === "business-services-v1" ? JEV_BUSINESS_SERVICES_QUESTION_VERSION : JEV_BUSINESS_SERVICES_V3_QUESTION_VERSION);
  const usePublicScale = contract !== JEV_QUESTION_VERSION;
  const businessServices = contract === JEV_BUSINESS_SERVICES_V3_QUESTION_VERSION ? "business-services-v3" : contract === JEV_BUSINESS_SERVICES_V2_QUESTION_VERSION ? "business-services-v2" : contract === JEV_BUSINESS_SERVICES_QUESTION_VERSION ? "business-services-v1" : false;
  const parts = priorParts.filter(part => part.evaluation.questionVersion === contract);
  const publications = job.result?.publications ?? [];
  let publicScaleContext: PublicScaleContext | undefined;
  if (usePublicScale) {
    if (job.result?.publicScaleContext) publicScaleContext = job.result.publicScaleContext;
    else {
      if (!publicContexts.has(observation.company_id)) publicContexts.set(observation.company_id,
        loadPublicScaleObservations(observation.company_id).catch(() => []));
      publicScaleContext = buildPublicScaleContext(observation.company_id, await publicContexts.get(observation.company_id)!, observation.id);
    }
  }
  let companyIdentityContext: string | undefined;
  if (businessServices === "business-services-v2" || businessServices === "business-services-v3") {
    companyIdentityContext = job.result?.companyIdentityContext;
    if (!companyIdentityContext) {
      if (!identityContexts.has(observation.company_id)) identityContexts.set(observation.company_id,
        loadCompanyIdentityContext(company).then(identity => {
          if (!identity.context?.trim() || Buffer.byteLength(identity.context, "utf8") > 4000) throw new Error("Identity context unavailable");
          return identity.context;
        }).catch(() => "Authorized business identity context unavailable; do not assume addresses, aliases or other missing identity facts."));
      companyIdentityContext = await identityContexts.get(observation.company_id)!;
    }
  }
  let pendingRequest = job.result?.pendingRequest;
  const checkpoint = () => ({ parts, publications, ...(publicScaleContext ? { publicScaleContext } : {}),
    ...(companyIdentityContext ? { companyIdentityContext } : {}),
    ...(pendingRequest ? { pendingRequest } : {}),
    ...(job.result?.routingBackfill ? { routingBackfill: job.result.routingBackfill } : {}) });
  const persistCheckpoint = async () => {
    const { data: saved, error: saveError } = await db.from("intelligence_jobs").update({ result: checkpoint() })
      .eq("id", job.id).eq("lease_token", job.lease_token).eq("status", "running")
      .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
    if (saveError || !saved) throw new Error("Intelligence result checkpoint failed");
  };
  for (const packet of evidencePackets(observation.evidence_text, 6000)) {
    if (parts.some((p) => p.start === packet.start && p.end === packet.end)) continue;
    if (job.result?.routingBackfill) {
      await finish(job, "failed", checkpoint(), { p_error: "saved_packet_coverage_gap" });
      return "saved_packet_coverage_gap";
    }
    if (Date.now() > deadline - 25_000) {
      await finish(job, "queued", checkpoint(), { p_error: "continuation", p_retry_seconds: 30 });
      return "continued";
    }
    if (pendingRequest && (pendingRequest.start !== packet.start || pendingRequest.end !== packet.end || pendingRequest.input.text !== packet.text))
      throw new Error("Pending Jev evidence does not match the exact packet");
    const input = pendingRequest?.input ?? workerEvidenceInput(observation, company, packet, question, feedback, publicScaleContext, businessServices, companyIdentityContext);
    if (estimateEvidenceInputTokens(input) === null) {
      await finish(job, "failed", checkpoint(), { p_error: "invalid_input" });
      return "invalid_input";
    }
    const fingerprint = pendingRequest?.fingerprint ?? evidenceRequestFingerprint(input);
    if (!fingerprint) {
      await finish(job, "failed", checkpoint(), { p_error: "invalid_request" });
      return "invalid_request";
    }
    if (!pendingRequest) {
      pendingRequest = { start: packet.start, end: packet.end, input, fingerprint };
      // Preserve the exact request before dispatch. A later identity/feedback/
      // baseline update must not turn checkpoint recovery into another paid call.
      await persistCheckpoint();
    }
    const response = await durableJevRequest({ fingerprint,
      context: { purpose: job.kind === "view" ? "saved_view" : "public_interpretation", companyId: observation.company_id,
        observationId: observation.id, sourceKind: observation.source_kind, workload: observationWorkload(observation.metadata) },
      execute: () => {
        if (evidenceRequestFingerprint(input) !== fingerprint) throw new Error("Pending Jev request contract changed");
        return evaluateEvidence({ ...input,
          abortSignal: AbortSignal.timeout(Math.min(20_000, Math.max(1, deadline - Date.now()))),
        });
      },
    });
    if (response.status === "budget_deferred") {
      await finish(job, "queued", checkpoint(), { p_error: "budget_deferred", p_retry_seconds: secondsUntilNextMonth() });
      return "budget_deferred";
    }
    if (response.status === "busy") {
      await finish(job, "queued", checkpoint(), { p_error: "continuation", p_retry_seconds: 30 });
      return "request_in_progress";
    }
    const evaluation = response.evaluation;
    if (!evaluation.ok) {
      await finish(job, evaluation.error.retryable ? "queued" : "failed", checkpoint(), {
        p_error: evaluation.error.kind, p_retry_seconds: Math.max(nextRetrySeconds(job.attempts), Math.ceil((evaluation.error.retryAfterMs ?? 0) / 1000)),
      });
      return evaluation.error.kind;
    }
    parts.push({ start: packet.start, end: packet.end, evaluation });
    pendingRequest = undefined;
    // Persist each paid result under its exact live lease before another call.
    await persistCheckpoint();
  }
  const ranked = [...parts].sort((a, b) => {
    const score = (p: PartResult) => job.kind === "view" ? (p.evaluation.criteria.view_match ?? 0) :
      p.evaluation.attributes.companyRelevance * (0.5 + p.evaluation.attributes.concreteEvent) * (0.5 + p.evaluation.attributes.operationalComplexity);
    return score(b) - score(a);
  });
  const best = ranked[0];
  if (!best) throw new Error("No interpretation returned");
  const { excerptStart, excerptEnd } = packetFinding(observation, best);
  if (job.kind === "interpret") {
    // One source owns one feed card; every additional packet can append its raw
    // context. Choose an eligible packet for event grouping before any UI winner.
    const ordered = [...ranked].sort((a, b) => Number(Boolean(jevSignalType(b.evaluation, observation.event_date))) - Number(Boolean(jevSignalType(a.evaluation, observation.event_date))));
    let grouped = publications.some(publication => publication.outcome.status !== "not_eligible");
    for (const part of ordered) {
      if (publications.some(p => p.start === part.start && p.end === part.end && p.questionVersion === part.evaluation.questionVersion)) continue;
      if (Date.now() > deadline - 8_000) {
        await finish(job, "queued", checkpoint(), { p_error: "publication_continuation", p_retry_seconds: 30 });
        return "continued";
      }
      const finding = packetFinding(observation, part);
      let event = null;
      try {
        event = !grouped && finding.evidenceExcerpt && observation.metadata.structuredAward !== true && jevSignalType(part.evaluation, observation.event_date)
          ? await reconcileObservationEvent(observation.id, observation.company_id,
            { ...part.evaluation.attributes, eventRoutingType: jevSignalType(part.evaluation, observation.event_date), evidenceExcerpt: finding.evidenceExcerpt }, deadline) : null;
      } catch (error) {
        if (!(error instanceof EventReconciliationDeferred)) throw error;
        await finish(job, "queued", checkpoint(), { p_error: `event_match_${error.reason}`,
          p_retry_seconds: error.reason === "budget_deferred" ? secondsUntilNextMonth() : 90 });
        return `event_match_${error.reason}`;
      }
      if (event) grouped = true;
      const publication = await publishJevFinding({ company, observation, evaluation: part.evaluation, event,
        passage: finding.excerptStart !== null && finding.excerptEnd !== null ? {
          text: observation.evidence_text.slice(finding.excerptStart, finding.excerptEnd), start: finding.excerptStart, end: finding.excerptEnd,
        } : null });
      if (event && "triggerId" in publication && publication.triggerId) await bindEventTrigger(event.id, publication.triggerId);
      publications.push({ start: part.start, end: part.end, questionVersion: part.evaluation.questionVersion, attemptedAt: new Date().toISOString(), outcome: publication });
      await persistCheckpoint();
    }
  }
  const attributes = { ...best.evaluation.attributes,
    evidenceExcerpt: excerptStart !== null && excerptEnd !== null ? observation.evidence_text.slice(excerptStart, excerptEnd) : null, excerptStart, excerptEnd,
    model: best.evaluation.model, questionVersion: best.evaluation.questionVersion,
    rawAnswers: best.evaluation.metadata.rawAnswers ?? null,
    ...(publicScaleContext ? { publicScaleContext } : {}),
    analyzedCharacters: parts.reduce((n, p) => n + p.end - p.start, 0), retainedCharacters: observation.evidence_text.length,
    sourceTruncated: observation.metadata.textTruncated === true,
    // Retain distinct supported categories across sections for reusable profiles.
    signalTypes: [...new Set(parts.filter((p) => p.evaluation.attributes.companyRelevance >= 0.8).map((p) => p.evaluation.attributes.signalType))],
    ...aggregatePacketFindings(observation, parts, publications),
  };
  await finish(job, "complete", { ...checkpoint(), excerptStart, excerptEnd }, job.kind === "view"
    ? { p_probability: best.evaluation.criteria.view_match ?? 0 }
    : { p_attributes: attributes, p_version: INTELLIGENCE_VERSION });
  if (job.kind === "interpret") await queueAccountStory(company.id);
  return "complete";
}

export async function runIntelligenceWorker(limit = 96, deadlineMs = Date.now() + 210_000) {
  if (!intelligenceEnabled()) return { enabled: false, processed: 0, outcomes: {} as Record<string, number> };
  return withServiceDeadline(deadlineMs, async () => {
    const db = serviceClient();
    const { data: config, error: configError } = await db.from("intelligence_config").select("enabled").eq("id", 1).single();
    if (configError) throw new Error("Intelligence schema/configuration unavailable");
    if (!config.enabled) return { enabled: false, processed: 0, outcomes: {} as Record<string, number> };
    await reconcileJevReceipts().catch(() => {});
    const { data: views, error: viewsError } = await db.from("intelligence_views").select("id").eq("active", true).eq("backfill_complete", false).limit(3);
    if (viewsError) throw new Error("Saved view queue unavailable");
    for (const view of views ?? []) {
      const { error: backfillError } = await db.rpc("intelligence_backfill_view", { p_view: view.id, p_limit: 100 });
      if (backfillError) throw new Error("Saved view backfill failed");
    }
    const outcomes: Record<string, number> = {};
    const publicContexts = new Map<string, Promise<PublicContextObservation[]>>();
    const identityContexts = new Map<string, Promise<string>>();
    let processed = 0;
    // Capacity follows the time budget. Claim at most three immediately runnable
    // jobs at once, but keep consuming while there is capacity for fresh evidence.
    const bound = Number.isFinite(limit) ? Math.max(1, Math.min(192, Math.floor(limit))) : 96;
    while (processed < bound && Date.now() < deadlineMs - 30_000) {
      // Claim only immediately runnable concurrency, not an entire batch that can expire while waiting.
      const { data: claimed, error: claimError } = await db.rpc("intelligence_claim", { p_limit: Math.min(3, bound - processed) });
      if (claimError) throw new Error("Intelligence claim failed");
      const jobs = (claimed ?? []) as Job[];
      if (!jobs.length) break;
      await Promise.all(jobs.map(async (job) => {
        let outcome: string;
        try { outcome = await runJob(job, deadlineMs, publicContexts, identityContexts); }
        catch {
          // Uncertain work remains leased for recovery; never fake a completed receipt.
          outcome = "checkpoint_or_service_error";
        }
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        processed++;
      }));
      if (outcomes.budget_deferred) break;
    }
    return { enabled: true, processed, outcomes, stoppedBy: processed >= bound ? "batch_limit" : Date.now() >= deadlineMs - 30_000 ? "deadline" : outcomes.budget_deferred ? "budget" : "queue_empty" };
  });
}
