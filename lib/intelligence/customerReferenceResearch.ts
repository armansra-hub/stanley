import "server-only";
import { randomUUID } from "node:crypto";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS } from "./operatingCatalog";
import { catalogAnswerPlans, catalogFacetVersion, catalogMappingPlans, catalogNativeResult, catalogPackets } from "./operatingCoverage";
import { evaluateNativeCached, nativeJevFingerprint, type NativeJevInput } from "./nativeJev";
import { scopedJevFingerprint } from "./jevRequests";
import { customerReferenceCatalogSources, customerReferenceCompany, customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
import type { CustomerReference } from "./customerMatches";
import seedData from "./customerReferenceData.json";
import { customerReferencePackedAnswerPlans } from "./customerReferencePacking";

type Plan = ReturnType<typeof catalogAnswerPlans>["plans"][number];
export type ReferenceCheckpoint = {
  version: 1; evidenceKey: string; phase: "direct" | "mapping" | "answer";
  mapped: Record<string, { scanned: string[]; candidates: string[] }>;
  answers: CustomerReference["answers"]; pending?: Plan;
  requests: number; reused: number; inputTokens: number; outputTokens: number;
  lastError?: string | null;
};
type ReferenceRow = { id: string; catalog_version: string; evidence_key: string; status: string;
  result: CustomerReference | null; checkpoint: ReferenceCheckpoint | null; updated_at: string;
  lease_token?: string | null; lease_until?: string | null };
const seeds = () => seedData.references as CustomerReferenceSeed[];
const context = { purpose: "operating_catalog" as const, sourceKind: "customer_reference", workload: "manual" as const };
const decision = (value: unknown) => value && typeof value === "object" && "choice" in value ? String(value.choice) : "";

/** Resume only the known transport-size hold when every remaining answer now
 * fits without losing source text. Completed answers and evidence stay intact. */
export function customerReferenceCanResumePacked(seed: CustomerReferenceSeed, checkpoint: ReferenceCheckpoint | null): boolean {
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.lastError !== "evidence_exceeds_native_request_limit" || checkpoint.phase !== "answer"
    || checkpoint.pending || checkpoint.evidenceKey !== customerReferenceEvidenceKey(seed)) return false;
  const missing = OPERATING_FACETS.filter(facet => !checkpoint.answers[facet.id]);
  if (!missing.length) return false;
  const packets = catalogPackets(customerReferenceCatalogSources(seed));
  if (packets.some(packet => missing.some(facet => !checkpoint.mapped[packet.id]?.scanned.includes(facet.id)))) return false;
  const candidates = Object.fromEntries(missing.map(facet => [facet.id,
    packets.filter(packet => checkpoint.mapped[packet.id]?.candidates.includes(facet.id)).map(packet => packet.id)]));
  const plans = customerReferencePackedAnswerPlans(customerReferenceCompany(seed), missing, packets, candidates);
  return !plans.blocked.length && new Set(plans.plans.flatMap(plan => plan.facetIds)).size === missing.length;
}

/** Same source packets, definitions, industry guidance, mapping and native
 * decisions as TAM operating coverage. No sales narrative or second judge. */
export async function classifyCustomerReference(seed: CustomerReferenceSeed, previous: ReferenceCheckpoint | null, deadline: number, deps: {
  evaluate?: typeof evaluateNativeCached;
  save: (checkpoint: ReferenceCheckpoint, status: "running" | "pending" | "blocked" | "complete", result: CustomerReference | null, error: string | null) => Promise<boolean>;
}) {
  const sources = customerReferenceCatalogSources(seed), key = customerReferenceEvidenceKey(seed);
  const packets = catalogPackets(sources), company = customerReferenceCompany(seed);
  const checkpoint: ReferenceCheckpoint = previous?.version === 1 && previous.evidenceKey === key ? previous : {
    version: 1, evidenceKey: key, phase: "direct", mapped: {}, answers: {}, requests: 0, reused: 0, inputTokens: 0, outputTokens: 0,
  };
  const save = (status: "running" | "pending" | "blocked" | "complete", result: CustomerReference | null = null, error: string | null = null) => deps.save(checkpoint, status, result, error);
  const missing = () => OPERATING_FACETS.filter(f => !checkpoint.answers[f.id]);
  if (!packets.length) { await save("blocked", null, "official_website_source_unavailable"); return "source_blocked"; }
  if (checkpoint.phase === "direct" && catalogAnswerPlans(company, missing(), packets).blocked.length) checkpoint.phase = "mapping";
  while (Date.now() < deadline - 35_000) {
    let plan = checkpoint.pending;
    if (!plan && checkpoint.phase === "mapping") {
      for (const packet of packets) {
        const unscanned = missing().filter(f => !checkpoint.mapped[packet.id]?.scanned.includes(f.id));
        if (unscanned.length) { plan = catalogMappingPlans(company, unscanned, packet, [])[0]; break; }
      }
      if (!plan) checkpoint.phase = "answer";
    }
    if (!plan) {
      const candidates = checkpoint.phase === "answer" ? Object.fromEntries(missing().map(f => [f.id,
        packets.filter(p => checkpoint.mapped[p.id]?.candidates.includes(f.id)).map(p => p.id)])) : undefined;
      let next = catalogAnswerPlans(company, missing(), packets, candidates);
      if (!next.plans.length && next.blocked.length) next = customerReferencePackedAnswerPlans(company, missing(), packets, candidates);
      plan = next.plans[0];
      if (!plan) {
        if (next.blocked.length) { await save("blocked", null, "evidence_exceeds_native_request_limit"); return "source_blocked"; }
        const result: CustomerReference = {
          id: seed.id, name: seed.name, domain: seed.domain, website: seed.website,
          announcementDate: seed.announcementDate, announcementType: seed.announcementType,
          ...(seed.buyingProgramId ? { buyingProgramId: seed.buyingProgramId } : {}),
          ...(seed.comparisonIndustry ? { subindustry: seed.comparisonIndustry } : {}),
          catalogVersion: OPERATING_CATALOG_VERSION, completedAt: new Date().toISOString(), status: "verified",
          identityNotes: seed.identityNotes ?? [],
          sources: seed.sources.map(s => ({ url: s.url, title: s.title, contentHash: s.contentHash })), answers: checkpoint.answers,
        };
        if (Object.keys(result.answers).length !== 47) throw new Error("customer_reference_incomplete_answers");
        return await save("complete", result) ? "complete" : "lease_changed";
      }
    }
    checkpoint.pending = plan;
    if (!await save("running")) return "lease_changed";
    const receipt = await (deps.evaluate ?? evaluateNativeCached)(plan.input as NativeJevInput, context);
    if (receipt.status !== "complete") {
      await save("pending", null, receipt.status === "budget_deferred" ? receipt.reason : "native_request_busy");
      return receipt.status === "budget_deferred" ? "provider_hold" : "native_busy";
    }
    if (!receipt.evaluation.ok) {
      // Leave transient provider failures resumable, with the exact pending
      // request intact for receipt reconciliation. This pass never retries it.
      await save(receipt.evaluation.error.retryable ? "pending" : "blocked", null, receipt.evaluation.error.code);
      return "provider_error";
    }
    const native = receipt.evaluation.provider_result;
    const fingerprint = nativeJevFingerprint(plan.input), receiptFingerprint = scopedJevFingerprint(fingerprint, context);
    if (plan.phase === "mapping") {
      const mapped = checkpoint.mapped[plan.packetId!] ?? { scanned: [], candidates: [] };
      for (const id of plan.facetIds) {
        const answer = decision(native.answers[id]);
        if (!["candidate", "no_evidence"].includes(answer)) throw new Error("invalid_reference_mapping_answer");
        if (!mapped.scanned.includes(id)) mapped.scanned.push(id);
        if (answer === "candidate" && !mapped.candidates.includes(id)) mapped.candidates.push(id);
      }
      checkpoint.mapped[plan.packetId!] = mapped;
    } else for (const id of plan.facetIds) {
      const facet = OPERATING_FACETS.find(f => f.id === id)!;
      const result = catalogNativeResult(facet, native.answers[id], packets.filter(p => plan!.packetIds.includes(p.id)), native.model, fingerprint, receiptFingerprint);
      checkpoint.answers[id] = { decision: result.decision as CustomerReference["answers"][string]["decision"],
        nativeResult: result.nativeResult, facetVersion: catalogFacetVersion(facet),
        sourceUrls: [...new Set(result.citations!.map(c => c.url))] };
    }
    checkpoint.requests++; checkpoint.reused += receipt.reused ? 1 : 0;
    if (!receipt.reused) {
      checkpoint.inputTokens += receipt.evaluation.usage?.inputTokens ?? 0;
      checkpoint.outputTokens += receipt.evaluation.usage?.outputTokens ?? 0;
    }
    delete checkpoint.pending;
    if (!await save("running")) return "lease_changed";
  }
  await save("pending", null, "reference_continuation");
  return "continued";
}

async function readRows(db = serviceClient()): Promise<ReferenceRow[]> {
  const { data, error } = await db.from("intelligence_customer_references").select("*").in("id", seeds().map(s => s.id));
  if (error) throw new Error("customer_reference_storage_unavailable");
  return (data ?? []) as ReferenceRow[];
}
export async function customerReferenceProgress() {
  const rows = new Map((await readRows()).map(row => [row.id, row]));
  const references = seeds().map(seed => {
    const row = rows.get(seed.id), compatible = row?.catalog_version === OPERATING_CATALOG_VERSION && row.evidence_key === customerReferenceEvidenceKey(seed);
    const status = compatible && row?.status === "complete" ? "complete"
      : compatible && row?.status === "blocked" && !customerReferenceCanResumePacked(seed, row.checkpoint) ? "blocked"
      : compatible && row?.status === "running" && Date.parse(row.lease_until ?? "") > Date.now() ? "running" : "pending";
    return { id: seed.id, name: seed.name, website: seed.website, status, answered: compatible ? Object.keys(row?.checkpoint?.answers ?? {}).length : 0,
      totalQuestions: 47, lastError: compatible && row?.checkpoint && "lastError" in row.checkpoint ? String(row.checkpoint.lastError) : undefined };
  });
  const count = (status: string) => references.filter(ref => ref.status === status).length;
  return { asOf: seedData.asOf, total: references.length, complete: count("complete"), pending: count("pending"), blocked: count("blocked"), running: count("running"), references };
}

/** User-started foreground reference pass. It does not create a scheduler,
 * touch prospect leases, or reclassify completed unchanged reference websites. */
export async function runCustomerReferenceReading(deadline: number) {
  return withServiceDeadline(deadline, async () => {
    const db = serviceClient(), existing = new Map((await readRows(db)).map(row => [row.id, row]));
    let processed = 0, completed = 0, stoppedBy = "references_exhausted";
    for (const seed of seeds()) {
      if (Date.now() >= deadline - 40_000) { stoppedBy = "deadline"; break; }
      const evidenceKey = customerReferenceEvidenceKey(seed), old = existing.get(seed.id);
      const compatible = old?.catalog_version === OPERATING_CATALOG_VERSION && old.evidence_key === evidenceKey;
      if (compatible && old.status === "complete") continue;
      // A source/provider rejection is explicit. Do not blind-replay the same
      // rejected input; changed source/version earns a new first pass.
      if (compatible && old.status === "blocked" && !customerReferenceCanResumePacked(seed, old.checkpoint)) continue;
      const initial = await db.from("intelligence_customer_references").upsert({ id: seed.id, catalog_version: OPERATING_CATALOG_VERSION,
        evidence_key: evidenceKey, status: "pending", checkpoint: null, result: null }, { onConflict: "id", ignoreDuplicates: true });
      if (initial.error) throw new Error("customer_reference_admission_failed");
      const lease = randomUUID(), now = new Date().toISOString();
      const claimed = await db.from("intelligence_customer_references").update({ lease_token: lease,
        lease_until: new Date(deadline + 10_000).toISOString(), status: "running", catalog_version: OPERATING_CATALOG_VERSION,
        evidence_key: evidenceKey, ...(compatible ? {} : { checkpoint: null, result: null }) })
        .eq("id", seed.id).or(`lease_until.is.null,lease_until.lt.${now}`).select("checkpoint").maybeSingle();
      if (claimed.error) throw new Error("customer_reference_claim_failed");
      if (!claimed.data) continue;
      const save = async (checkpoint: ReferenceCheckpoint, status: "running" | "pending" | "blocked" | "complete", result: CustomerReference | null, error: string | null) => {
        const saved = await db.from("intelligence_customer_references").update({ status, result,
          checkpoint: { ...checkpoint, lastError: error }, updated_at: new Date().toISOString(),
          ...(status !== "running" ? { lease_token: null, lease_until: null } : {}) })
          .eq("id", seed.id).eq("lease_token", lease).eq("evidence_key", evidenceKey).gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
        if (saved.error) throw new Error("customer_reference_checkpoint_failed");
        return !!saved.data;
      };
      const outcome = await classifyCustomerReference(seed, claimed.data.checkpoint as ReferenceCheckpoint | null, deadline, { save });
      processed++; if (outcome === "complete") completed++;
      if (["provider_hold", "native_busy", "provider_error", "lease_changed", "continued"].includes(outcome)) { stoppedBy = outcome; break; }
    }
    return { processed, completed, stoppedBy };
  });
}
