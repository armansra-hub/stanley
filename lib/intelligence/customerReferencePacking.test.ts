import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn(), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { catalogAnswerPlans, catalogPackets, type CatalogSource } from "./operatingCoverage";
import { OPERATING_FACETS, operatingFacetQuestion } from "./operatingCatalog";
import { nativeJevBody } from "./nativeJev";
import { customerReferenceAnswerPlans, customerReferenceLargeAnswerPlans, customerReferencePackedAnswerPlans, packCustomerReferenceText, unpackCustomerReferenceText } from "./customerReferencePacking";
import { customerReferenceCatalogSources, customerReferenceCompany, customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
import { classifyCustomerReference, customerReferenceCanResumePacked, type ReferenceCheckpoint } from "./customerReferenceResearch";
import configured from "./customerReferenceData.json";

const windward = configured.references.find(ref => ref.id === "windward") as CustomerReferenceSeed;
const source = (id: string, text: string): CatalogSource => ({ id, title: id, source_url: `https://example.test/${id}`, source_kind: "website", event_date: null,
  observed_at: "2026-09-28T00:00:00Z", content_hash: createHash("sha256").update(text).digest("hex"), evidence_text: text });
const remaining = OPERATING_FACETS.slice(40);
function heldCheckpoint(): ReferenceCheckpoint {
  const packets = catalogPackets(customerReferenceCatalogSources(windward));
  return { version: 1, evidenceKey: customerReferenceEvidenceKey(windward), phase: "answer",
    mapped: Object.fromEntries(packets.map(packet => [packet.id, { scanned: OPERATING_FACETS.map(f => f.id), candidates: OPERATING_FACETS.map(f => f.id) }])),
    answers: Object.fromEntries(OPERATING_FACETS.slice(0, 40).map(facet => [facet.id, { decision: "insufficient_evidence", nativeResult: { exactPrior: facet.id }, facetVersion: "preserved", sourceUrls: [] }])),
    requests: 17, reused: 0, inputTokens: 12_000, outputTokens: 200, lastError: "evidence_exceeds_native_request_limit" };
}

describe("lossless customer-reference overflow packing", () => {
  it("reconstructs every byte including repeated text, CRLF, whitespace, Unicode and packet boundaries", () => {
    const repeated = `  Repeated navigation with \\"quotes\\" and emoji 🛰️ plus meaningful service text.\r\n`;
    const original = [source("a", `${repeated}\nFirst different paragraph.\n${repeated}No trailing newline`), source("b", `${repeated}Other page\r\n${repeated}`)];
    const packets = catalogPackets(original, 160);
    const packed = packCustomerReferenceText(packets);
    expect(packed.sharedText.length).toBeGreaterThan(0);
    for (let i = 0; i < packets.length; i++) {
      const rebuilt = unpackCustomerReferenceText(packed.sharedText, packed.sources[i].textParts);
      expect(Buffer.from(rebuilt)).toEqual(Buffer.from(packets[i].text));
      const { observedAt: _clock, ...citation } = packets[i].citation;
      expect(packed.sources[i]).toMatchObject({ id: packets[i].id, ...citation });
    }
    for (const item of original) expect(packed.sources.filter(row => row.observationId === item.id)
      .map(row => unpackCustomerReferenceText(packed.sharedText, row.textParts)).join("")).toBe(item.evidence_text);
  });

  it("rejects a broken dictionary reference instead of silently dropping text", () => {
    expect(() => unpackCustomerReferenceText(["line"], [{ sharedLine: 2 }])).toThrow("invalid_customer_reference_shared_line");
  });

  it("fits the actual Windward corpus without removing any question, guide or cited packet", () => {
    const packets = catalogPackets(customerReferenceCatalogSources(windward)), company = customerReferenceCompany(windward);
    expect(catalogAnswerPlans(company, remaining, packets).blocked.length).toBeGreaterThan(0);
    expect(customerReferencePackedAnswerPlans(company, OPERATING_FACETS, packets).blocked).toEqual([]);
    const packed = customerReferencePackedAnswerPlans(company, remaining, packets);
    expect(packed.blocked).toEqual([]);
    expect(packed.plans.flatMap(plan => plan.facetIds)).toEqual(remaining.map(f => f.id));
    const normal = catalogAnswerPlans(company, [remaining[0]], []).plans[0].input.state as any;
    for (const plan of packed.plans) {
      expect(Buffer.byteLength(JSON.stringify(nativeJevBody(plan.input)))).toBeLessThanOrEqual(48_000);
      expect(plan.packetIds).toEqual(packets.map(packet => packet.id));
      const state = plan.input.state as any;
      const { sources: _sources, ...ordinarySemantics } = normal;
      expect(state).toMatchObject(ordinarySemantics);
      expect(state.guidance).toEqual(normal.guidance);
      for (const id of plan.facetIds) expect(plan.input.questions[id]).toEqual(operatingFacetQuestion(id));
      for (let i = 0; i < packets.length; i++) expect(unpackCustomerReferenceText(state.sharedText, state.sources[i].textParts)).toBe(packets[i].text);
    }
  });

  it("reopens only a compatible exact size hold whose remaining evidence fits", () => {
    const checkpoint = heldCheckpoint();
    expect(customerReferenceCanResumePacked(windward, checkpoint)).toBe(true);
    expect(customerReferenceCanResumePacked(windward, { ...checkpoint, lastError: "typesafe_http_400" })).toBe(false);
    expect(customerReferenceCanResumePacked(windward, { ...checkpoint, evidenceKey: "changed" })).toBe(false);
    expect(customerReferenceCanResumePacked(windward, { ...checkpoint, mapped: {} })).toBe(false);
    expect(customerReferenceCanResumePacked(windward, { ...checkpoint, answers: Object.fromEntries(OPERATING_FACETS.map(f => [f.id, checkpoint.answers.rr_c01])) })).toBe(false);
  });

  it("finishes only the seven remaining questions and preserves all forty prior native answers exactly", async () => {
    const checkpoint = heldCheckpoint(), before = structuredClone(checkpoint.answers);
    const writes: any[] = [];
    const evaluate = vi.fn(async (input: any) => ({ status: "complete", reused: false, evaluation: { ok: true, usage: { inputTokens: 20, outputTokens: 1 },
      provider_result: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: "choice", choice: "insufficient_evidence" }])) } } }));
    const save = vi.fn(async (saved, status, result, error) => { writes.push(structuredClone({ saved, status, result, error })); return true; });
    expect(await classifyCustomerReference(windward, checkpoint, Date.now() + 120_000, { evaluate, save } as any)).toBe("complete");
    const asked = evaluate.mock.calls.flatMap(([input]) => Object.keys(input.questions));
    expect(asked).toEqual(remaining.map(f => f.id));
    expect(writes.at(-1).status).toBe("complete");
    for (const [id, answer] of Object.entries(before)) expect(writes.at(-1).result.answers[id]).toEqual(answer);
    expect(writes.at(-1).saved.evidenceKey).toBe(checkpoint.evidenceKey);
    expect(writes.at(-1).result.sources.map((s: any) => s.contentHash)).toEqual(windward.sources.map(s => s.contentHash));
  });
});

const largeSeed: CustomerReferenceSeed = { id: "full-source-customer", name: "Full Source Customer", domain: "example.test",
  website: "https://example.test", announcementDate: "2026-09-01", announcementType: "new_customer",
  sources: ["operations", "services", "contracts"].map(id => {
    const text = Array.from({ length: 270 }, (_,i) => `Service ${id}-${i}: Our employees maintain customer equipment under separately documented agreements and project schedules.`).join("\n");
    return { id, url: `https://example.test/${id}`, title: id, text, contentHash: createHash("sha256").update(text).digest("hex"), observedAt: "2026-09-28T00:00:00Z" };
  }) };

describe("customer-only full-source transport overflow", () => {
  it("asks all47 in direct batches before paying for per-packet mapping, preserving every literal source and definition", async () => {
    const packets = catalogPackets(customerReferenceCatalogSources(largeSeed)), company = customerReferenceCompany(largeSeed);
    expect(customerReferencePackedAnswerPlans(company, OPERATING_FACETS, packets).blocked.length).toBe(47);
    const ordinaryState = catalogAnswerPlans(company, [OPERATING_FACETS[0]], []).plans[0].input.state as any;
    const writes: any[] = [];
    const evaluate = vi.fn(async (input: any) => {
      const body = nativeJevBody(input);
      expect(input.requestProfile).toBe("customer-reference-full-source-v1");
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(192_000);
      expect((input.state as any).guidance).toEqual(ordinaryState.guidance);
      for (const source of largeSeed.sources) expect((input.state as any).sources.filter((p: any) => p.observationId === source.id).map((p: any) => p.text).join("")).toBe(source.text);
      for (const id of Object.keys(input.questions)) expect(input.questions[id]).toEqual(operatingFacetQuestion(id));
      return { status: "complete", reused: false, evaluation: { ok: true, usage: { inputTokens: 100, outputTokens: 1 },
        provider_result: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: "choice", choice: "insufficient_evidence" }])) } } };
    });
    const outcome = await classifyCustomerReference(largeSeed, null, Date.now() + 120_000, { evaluate,
      save: async (saved: ReferenceCheckpoint, status: string, result: unknown, error: string | null) => { writes.push(structuredClone({ saved, status, result, error })); return true; } } as any);
    expect(outcome).toBe("complete"); expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.flatMap(([input]) => Object.keys(input.questions))).toEqual(OPERATING_FACETS.map(f => f.id));
    expect(writes.at(-1).result.sources.map((s: any) => s.contentHash)).toEqual(largeSeed.sources.map(s => s.contentHash));
  });

  it("groups only identical mapped evidence sets and keeps a provider rejection frozen for read-only recovery", async () => {
    const packets = catalogPackets(customerReferenceCatalogSources(largeSeed)), company = customerReferenceCompany(largeSeed);
    const missing = OPERATING_FACETS.slice(36), narrow = packets.slice(0, Math.ceil(packets.length / 2));
    const candidates = Object.fromEntries(missing.map((f, i) => [f.id, (i < 2 ? narrow : packets).map(p => p.id)]));
    const plans = customerReferenceLargeAnswerPlans(company, missing, packets, candidates);
    expect(plans.blocked).toEqual([]); expect(plans.plans).toHaveLength(2);
    expect(plans.plans[0].packetIds).toEqual(narrow.map(p => p.id));
    expect(plans.plans[0].facetIds).toEqual(missing.slice(0, 2).map(f => f.id));
    const checkpoint: ReferenceCheckpoint = { version: 1, evidenceKey: customerReferenceEvidenceKey(largeSeed), phase: "answer",
      mapped: Object.fromEntries(packets.map(p => [p.id, { scanned: OPERATING_FACETS.map(f => f.id), candidates: missing.filter(f => candidates[f.id].includes(p.id)).map(f => f.id) }])),
      answers: Object.fromEntries(OPERATING_FACETS.slice(0, 36).map(f => [f.id, { decision: "insufficient_evidence", facetVersion: "original", sourceUrls: [], nativeResult: { original: f.id } }])),
      requests: 20, reused: 0, inputTokens: 8000, outputTokens: 100, lastError: "evidence_exceeds_native_request_limit" };
    const original = structuredClone(checkpoint.answers), writes: any[] = [];
    expect(customerReferenceCanResumePacked(largeSeed, checkpoint)).toBe(true);
    const evaluate = vi.fn(async () => ({ status: "complete", reused: false, evaluation: { ok: false, usage: null,
      error: { code: "typesafe_http_400", retryable: false } } }));
    expect(await classifyCustomerReference(largeSeed, checkpoint, Date.now() + 120_000, { evaluate,
      save: async (saved: ReferenceCheckpoint, status: string, result: unknown, error: string | null) => { writes.push(structuredClone({ saved, status, result, error })); return true; } } as any)).toBe("provider_error");
    expect(evaluate).toHaveBeenCalledOnce();
    const saved = writes.at(-1);
    expect(saved.status).toBe("blocked"); expect(saved.error).toBe("typesafe_http_400");
    expect(saved.saved.answers).toEqual(original); expect(saved.saved.pending).toBeDefined();
    expect(customerReferenceCanResumePacked(largeSeed, { ...saved.saved, lastError: saved.error })).toBe(false);
    expect(customerReferenceAnswerPlans(company, [OPERATING_FACETS[0]], [])).toEqual(catalogAnswerPlans(company, [OPERATING_FACETS[0]], []));
  });
});
