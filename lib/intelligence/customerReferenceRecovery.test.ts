import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn(), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { catalogAnswerPlans, catalogFacetVersion, catalogPackets } from "./operatingCoverage";
import { OPERATING_FACETS, operatingFacetQuestion } from "./operatingCatalog";
import { nativeJevBody, nativeJevFingerprint, type NativeJevInput } from "./nativeJev";
import { customerReferenceCatalogSources, customerReferenceCompany, customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
import { customerReferenceCanResumeContext, classifyCustomerReference, type ReferenceCheckpoint } from "./customerReferenceResearch";
import { CUSTOMER_REFERENCE_RECOVERY_VERSION, customerReferencePassages, customerReferencePassagePlans, customerReferenceRecoveryNext,
  customerReferenceRetainedPassages, type CustomerReferenceRecovery } from "./customerReferenceRecovery";

afterEach(() => vi.restoreAllMocks());
const facet = OPERATING_FACETS.find(f => f.id === "rr_c11")!;
const text = Array.from({ length: 1100 }, (_, i) => i === 507
  ? "LICENSE_GRANT: We license proprietary datasets to customers for annual fees.\n"
  : `Paragraph ${i}: Ordinary unrelated website terms about account preferences, contact methods, display settings and browser sessions.\n`).join("");
const seed: CustomerReferenceSeed = { id: "synthetic-overflow", name: "Synthetic Customer", domain: "example.test", website: "https://example.test/",
  announcementDate: "2026-09-01", announcementType: "new_customer", sources: [{ id: "terms", title: "Terms", url: "https://example.test/terms",
    text, contentHash: createHash("sha256").update(text).digest("hex"), observedAt: "2026-09-29T00:00:00Z" }] };
const packets = catalogPackets(customerReferenceCatalogSources(seed)), company = customerReferenceCompany(seed);
function held(): ReferenceCheckpoint {
  const template = catalogAnswerPlans(company, [facet], []).plans[0];
  const input: NativeJevInput = { ...template.input, requestProfile: "customer-reference-full-source-v1", state: {
    ...template.input.state as Record<string, unknown>, sources: packets.map(p => ({ id: p.id, ...p.citation, text: p.text })),
  } };
  return { version: 1, evidenceKey: customerReferenceEvidenceKey(seed), phase: "answer",
    mapped: Object.fromEntries(packets.map(p => [p.id, { scanned: [facet.id], candidates: [facet.id] }])),
    answers: Object.fromEntries(OPERATING_FACETS.filter(f => f.id !== facet.id).map(f => [f.id, { decision: "insufficient_evidence",
      facetVersion: catalogFacetVersion(f), sourceUrls: [], nativeResult: { paidOriginalAnswer: f.id } }])),
    pending: { ...template, packetIds: packets.map(p => p.id), input }, requests: 49, reused: 2, inputTokens: 12345, outputTokens: 678,
    lastError: "typesafe_http_400" };
}
type Saved = { checkpoint: ReferenceCheckpoint; status: string; result: unknown; error: string | null };
function harness() {
  const writes: Saved[] = [];
  const save = vi.fn(async (checkpoint: ReferenceCheckpoint, status: string, result: unknown, error: string | null) => {
    writes.push(structuredClone({ checkpoint, status, result, error })); return true;
  });
  const evaluate = vi.fn(async (input: NativeJevInput) => {
    const state = input.state as { passages?: { id: string; questionId: string; parentPacketId: string; relativeStart: number; relativeEnd: number }[];
      sources: { id: string; text: string; literalPassages?: { id: string; text: string }[] }[] };
    const answers = Object.fromEntries(Object.keys(input.questions).map(id => {
      const span = state.passages?.find(p => p.questionId === id);
      const choice = span ? state.sources.find(p => p.id === span.parentPacketId)!.literalPassages!.find(p => p.id === span.id)!.text.includes("LICENSE_GRANT") ? "candidate" : "no_evidence" : "supported";
      return [id, { type: "choice" as const, choice, probabilities: { [choice]: .96 } }];
    }));
    return { status: "complete" as const, reused: false, evaluation: { ok: true as const, usage: { inputTokens: 100, outputTokens: 20 },
      provider_result: { model: "jev-1.13.0", answers } } };
  });
  return { writes, save, evaluate };
}

describe("bounded exact-passage customer recovery", () => {
  it("scans every selected Unicode character and batches many marked passages with full original context", () => {
    const unicode = { ...seed, sources: [{ ...seed.sources[0], text: "Boundary 😀 text\r\n".repeat(1700) }] };
    unicode.sources[0].contentHash = createHash("sha256").update(unicode.sources[0].text).digest("hex");
    const sourcePackets = catalogPackets(customerReferenceCatalogSources(unicode));
    const passages = customerReferencePassages(sourcePackets), plans = customerReferencePassagePlans(company, facet, sourcePackets);
    expect(passages.map(p => p.text).join("")).toBe(unicode.sources[0].text);
    expect(plans.flatMap(p => p.passageIds)).toEqual(passages.map(p => p.id));
    expect(plans.length).toBeLessThan(passages.length / 4);
    for (const passage of passages) expect(unicode.sources[0].text.slice(passage.citation.start, passage.citation.end)).toBe(passage.text);
    for (const plan of plans) {
      expect(Buffer.byteLength(JSON.stringify(nativeJevBody(plan.input)))).toBeLessThanOrEqual(48_000);
      expect(Object.keys(plan.input.questions).length).toBeLessThanOrEqual(32);
      const state = plan.input.state as { sources: { id: string; literalPassages: { text: string }[] }[]; routingPolicy: string };
      expect(state.routingPolicy).toContain("Retain uncertain relevance");
      for (const source of state.sources) expect(source.literalPassages.map(p => p.text).join("")).toBe(sourcePackets.find(p => p.id === source.id)!.text);
    }
  });

  it("preserves all46 paid answers and original unknown400 while replacing only rr_c11 with an exact smaller request", async () => {
    const checkpoint = held(), original = structuredClone(checkpoint), h = harness();
    expect(customerReferenceCanResumeContext(seed, checkpoint)).toBe(true);
    expect(await classifyCustomerReference(seed, checkpoint, Date.now() + 120_000, h)).toBe("complete");
    const saved = h.writes.at(-1)!.checkpoint;
    for (const [id, answer] of Object.entries(original.answers)) expect(saved.answers[id]).toEqual(answer);
    expect(saved.contextReplan?.reason).toBe("historical_oversized_request_replan");
    expect(saved.contextReplan?.originalPlan).toEqual(original.pending);
    expect(saved.contextReplan?.originalFailure).toMatchObject({ code: "typesafe_http_400", requestFingerprint: nativeJevFingerprint(original.pending!.input) });
    const finalCalls = h.evaluate.mock.calls.filter(([input]) => Object.hasOwn(input.questions, facet.id));
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0][0].questions).toEqual({ [facet.id]: operatingFacetQuestion(facet.id) });
    expect(JSON.stringify(finalCalls[0][0].state)).toContain("LICENSE_GRANT");
    expect(Buffer.byteLength(JSON.stringify(nativeJevBody(finalCalls[0][0])))).toBeLessThan(96_000);
    expect(h.evaluate.mock.calls.some(([input]) => nativeJevFingerprint(input) === nativeJevFingerprint(original.pending!.input))).toBe(false);
    expect(saved.contextRecoveryHistory).toHaveLength(1);
    expect(Object.keys(saved.contextRecoveryHistory![0].decisions).length).toBe(customerReferencePassages(packets).length);
    expect(saved.answers[facet.id].nativeResult).toMatchObject({ answer: { choice: "supported", probabilities: { supported: .96 } } });
  });

  it("does not reopen ordinary small400s, changed evidence, already-answered inputs or a second failed recovery", () => {
    const checkpoint = held();
    const small = catalogAnswerPlans(company, [facet], packets.slice(0, 1)).plans[0];
    expect(customerReferenceCanResumeContext(seed, { ...checkpoint, pending: small })).toBe(false);
    expect(customerReferenceCanResumeContext({ ...seed, name: "Changed identity" }, checkpoint)).toBe(false);
    expect(customerReferenceCanResumeContext(seed, { ...checkpoint, answers: { ...checkpoint.answers, [facet.id]: checkpoint.answers.rr_c01 } })).toBe(false);
    const once = { version: "customer-context-replan-v1" as const, reason: "historical_oversized_request_replan" as const,
      originalPlan: checkpoint.pending!, originalFailure: { requestFingerprint: nativeJevFingerprint(checkpoint.pending!.input), code: "typesafe_http_400", retryable: false }, originalReceiptFingerprint: "old" };
    expect(customerReferenceCanResumeContext(seed, { ...checkpoint, contextReplan: once })).toBe(false);
  });

  it("routes a known local oversized final before any rejected large inference and stops if all evidence remains relevant", async () => {
    const checkpoint = held(); delete checkpoint.pending; checkpoint.lastError = "evidence_exceeds_native_request_limit";
    const h = harness();
    h.evaluate.mockImplementation(async input => ({ status: "complete", reused: false, evaluation: { ok: true, usage: { inputTokens: 100, outputTokens: 20 },
      provider_result: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: "choice", choice: "candidate", probabilities: { candidate: 1 } }])) } } }));
    expect(await classifyCustomerReference(seed, checkpoint, Date.now() + 120_000, h)).toBe("source_blocked");
    expect(h.writes.at(-1)!.error).toBe("customer_context_relevant_evidence_still_large");
    expect(h.evaluate.mock.calls.every(([input]) => !Object.hasOwn(input.questions, facet.id))).toBe(true);
    const recovery = h.writes.at(-1)!.checkpoint.contextRecovery!;
    expect(customerReferenceRetainedPassages(packets, recovery).map(p => p.text).join("")).toBe(text);
    expect(customerReferenceRecoveryNext(company, facet, packets, recovery).blocked).toBe("customer_context_relevant_evidence_still_large");
  });

  it("resumes exact pending passage requests and saved native selections without routing them twice", async () => {
    let clock = Date.now(); const start = clock; vi.spyOn(Date, "now").mockImplementation(() => clock);
    const h = harness(), evaluate = h.evaluate.getMockImplementation()!;
    h.evaluate.mockImplementation(async input => { const result = await evaluate(input); clock = start + 90_000; return result; });
    expect(await classifyCustomerReference(seed, held(), start + 120_000, h)).toBe("continued");
    const checkpoint = h.writes.at(-1)!.checkpoint;
    checkpoint.lastError = "reference_continuation";
    const finishedIds = Object.keys(checkpoint.contextRecovery!.decisions); expect(finishedIds.length).toBeGreaterThan(0);
    const next = harness(); clock = start;
    expect(await classifyCustomerReference(seed, checkpoint, start + 120_000, next)).toBe("complete");
    const newIds = next.evaluate.mock.calls.flatMap(([input]) => ((input.state as { passages?: { id: string }[] }).passages ?? []).map(p => p.id));
    expect(newIds.some(id => finishedIds.includes(id))).toBe(false);
  });
});
