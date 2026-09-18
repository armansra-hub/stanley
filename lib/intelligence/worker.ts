import "server-only";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { queueCandidate } from "@/lib/db/triggers";
import { evaluateEvidence } from "./jev";
import type { EvaluateEvidenceResult } from "./evaluation";
import { intelligenceEnabled, INTELLIGENCE_VERSION } from "./observations";
import { reserveJev, settleJev, secondsUntilNextMonth } from "./budget";
import { OPERATING_CRITERIA, OPERATING_TOPICS, type OperatingTopic } from "./profiles";

type Evaluation = Extract<EvaluateEvidenceResult, { ok: true }>;
type PartResult = { start: number; end: number; evaluation: Evaluation };
type Job = { id: string; observation_id: string; view_id: string | null; kind: "interpret" | "view"; lease_token: string; attempts: number; result: { parts?: PartResult[] } | null };
type Observation = { id: string; company_id: string; source_kind: string; source_url: string; title: string; evidence_text: string;
  event_date: string | null; is_current: boolean; metadata: Record<string, unknown> };

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

/** Selection is an interpretation aid, not an alternate trigger publisher. */
export function candidateType(result: Evaluation, eventDate: string | null, now = Date.now()): string | null {
  const a = result.attributes;
  const allowed = new Set(["funding", "ma", "new_entity", "finance_hire", "press", "operating_change"]);
  if (!allowed.has(a.signalType) || a.companyRelationship !== "direct" || a.companyRelevance < 0.8 || a.concreteEvent < 0.75) return null;
  if (a.signalType === "ma" && a.isAcquirer < 0.8) return null;
  const age = eventDate ? now - Date.parse(eventDate) : NaN;
  if (!Number.isFinite(age) || age < 0 || age > 180 * 86_400_000) return null;
  // Government records continue through the existing verified-entity publisher.
  return a.signalType;
}

async function finish(job: Job, status: string, result: unknown, extra: Record<string, unknown> = {}) {
  const { data, error } = await serviceClient().rpc("intelligence_finish", {
    p_id: job.id, p_lease: job.lease_token, p_status: status, p_result: result, ...extra,
  });
  if (error || data !== true) throw new Error("Intelligence lease completion was not confirmed");
}

async function runJob(job: Job, deadline: number): Promise<string> {
  const db = serviceClient();
  const { data: raw, error } = await db.from("intelligence_observations").select("*").eq("id", job.observation_id).single();
  if (error || !raw) throw new Error("Observation unavailable");
  const observation = raw as Observation;
  if (!observation.is_current) { await finish(job, "superseded", {}); return "superseded"; }
  const { data: company, error: companyError } = await db.from("companies")
    .select("id,name,domain,netsuite_internal_id,status,record_dead,description,subindustry,ns_industry")
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
  const { data: feedback } = await db.from("intelligence_feedback").select("reason,note")
    .eq("company_id", observation.company_id).order("updated_at", { ascending: false }).limit(3);
  const parts = [...(job.result?.parts ?? [])];
  for (const packet of evidencePackets(observation.evidence_text)) {
    if (parts.some((p) => p.start === packet.start && p.end === packet.end)) continue;
    if (Date.now() > deadline - 25_000) {
      await finish(job, "queued", { parts }, { p_error: "continuation", p_retry_seconds: 30 });
      return "continued";
    }
    const reservation = await reserveJev();
    if (!reservation) {
      await finish(job, "queued", { parts }, { p_error: "budget_deferred", p_retry_seconds: secondsUntilNextMonth() });
      return "budget_deferred";
    }
    const evaluation = await evaluateEvidence({
      text: packet.text, companyName: String(company.name), companyDomain: company.domain ?? undefined,
      sourceKind: observation.source_kind, sourceUrl: observation.source_url, title: observation.title,
      sections: evidencePackets(packet.text, 1200).map(({ text }, i) => ({ id: `s${i + 1}`, text })),
      criteria: question ? [{ id: "view_match", instructions: question }] : OPERATING_CRITERIA,
      feedbackExamples: (feedback ?? []).filter((f) => f.note).map((f) => ({ text: evidencePackets(String(f.note), 900)[0].text, correction: f.reason })),
      privacy: "public", abortSignal: AbortSignal.timeout(Math.min(20_000, Math.max(1, deadline - Date.now()))),
    });
    await settleJev(reservation, evaluation.usage?.inputTokens ?? null);
    if (!evaluation.ok) {
      await finish(job, evaluation.error.retryable ? "queued" : "failed", { parts }, {
        p_error: evaluation.error.kind, p_retry_seconds: Math.max(nextRetrySeconds(job.attempts), Math.ceil((evaluation.error.retryAfterMs ?? 0) / 1000)),
      });
      return evaluation.error.kind;
    }
    parts.push({ start: packet.start, end: packet.end, evaluation });
    // Persist each paid result under its exact live lease before another call.
    const { data: saved, error: saveError } = await db.from("intelligence_jobs").update({ result: { parts } })
      .eq("id", job.id).eq("lease_token", job.lease_token).eq("status", "running")
      .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
    if (saveError || !saved) throw new Error("Intelligence result checkpoint failed");
  }
  const ranked = [...parts].sort((a, b) => {
    const score = (p: PartResult) => job.kind === "view" ? (p.evaluation.criteria.view_match ?? 0) :
      p.evaluation.attributes.companyRelevance * (0.5 + p.evaluation.attributes.concreteEvent) * (0.5 + p.evaluation.attributes.operationalComplexity);
    return score(b) - score(a);
  });
  const best = ranked[0];
  if (!best) throw new Error("No interpretation returned");
  const packetText = observation.evidence_text.slice(best.start, best.end);
  const selectedSection = evidencePackets(packetText, 1200).map((s, i) => ({ ...s, id: `s${i + 1}` }))
    .find((s) => s.id === best.evaluation.attributes.evidenceSectionId);
  const excerptStart = selectedSection ? best.start + selectedSection.start : null;
  const excerptEnd = selectedSection ? best.start + selectedSection.end : null;
  const attributes = { ...best.evaluation.attributes,
    evidenceExcerpt: excerptStart !== null && excerptEnd !== null ? observation.evidence_text.slice(excerptStart, excerptEnd) : null, excerptStart, excerptEnd,
    model: best.evaluation.model, questionVersion: best.evaluation.questionVersion,
    analyzedCharacters: parts.reduce((n, p) => n + p.end - p.start, 0), retainedCharacters: observation.evidence_text.length,
    sourceTruncated: observation.metadata.textTruncated === true,
    // Retain distinct supported categories across sections for reusable profiles.
    signalTypes: [...new Set(parts.filter((p) => p.evaluation.attributes.companyRelevance >= 0.8).map((p) => p.evaluation.attributes.signalType))],
    topicEvidence: parts.filter(p => p.evaluation.attributes.companyRelationship === "direct" && p.evaluation.attributes.companyRelevance >= .8)
      .flatMap(p => Object.entries(p.evaluation.criteria).filter(([topic, probability]) => topic in OPERATING_TOPICS && probability >= .8)
        .map(([topic, probability]) => ({ topic: topic as OperatingTopic, probability, start: p.start, end: p.end }))),
  };
  if (job.kind === "interpret") {
    const type = candidateType(best.evaluation, observation.event_date);
    if (type) await queueCandidate(company, { type, summary: observation.title, source_name: observation.source_kind === "news" ? String(observation.metadata.sourceName ?? "Public news") : "Company website",
      source_url: observation.source_url, signal_date: observation.event_date }, { requireReceipt: true });
  }
  await finish(job, "complete", { parts, excerptStart, excerptEnd }, job.kind === "view"
    ? { p_probability: best.evaluation.criteria.view_match ?? 0 }
    : { p_attributes: attributes, p_version: INTELLIGENCE_VERSION });
  return "complete";
}

export async function runIntelligenceWorker(limit = 9, deadlineMs = Date.now() + 210_000) {
  if (!intelligenceEnabled()) return { enabled: false, processed: 0, outcomes: {} as Record<string, number> };
  return withServiceDeadline(deadlineMs, async () => {
    const db = serviceClient();
    const { data: config, error: configError } = await db.from("intelligence_config").select("enabled").eq("id", 1).single();
    if (configError) throw new Error("Intelligence schema/configuration unavailable");
    if (!config.enabled) return { enabled: false, processed: 0, outcomes: {} as Record<string, number> };
    const { data: views, error: viewsError } = await db.from("intelligence_views").select("id").eq("active", true).eq("backfill_complete", false).limit(3);
    if (viewsError) throw new Error("Saved view queue unavailable");
    for (const view of views ?? []) {
      const { error: backfillError } = await db.rpc("intelligence_backfill_view", { p_view: view.id, p_limit: 100 });
      if (backfillError) throw new Error("Saved view backfill failed");
    }
    const outcomes: Record<string, number> = {};
    let processed = 0;
    const bound = Math.max(1, Math.min(24, Math.floor(limit)));
    while (processed < bound && Date.now() < deadlineMs - 30_000) {
      // Claim only immediately runnable concurrency, not an entire batch that can expire while waiting.
      const { data: claimed, error: claimError } = await db.rpc("intelligence_claim", { p_limit: Math.min(3, bound - processed) });
      if (claimError) throw new Error("Intelligence claim failed");
      const jobs = (claimed ?? []) as Job[];
      if (!jobs.length) break;
      await Promise.all(jobs.map(async (job) => {
        let outcome: string;
        try { outcome = await runJob(job, deadlineMs); }
        catch {
          // Uncertain work remains leased for recovery; never fake a completed receipt.
          outcome = "checkpoint_or_service_error";
        }
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        processed++;
      }));
      if (outcomes.budget_deferred) break;
    }
    return { enabled: true, processed, outcomes };
  });
}
