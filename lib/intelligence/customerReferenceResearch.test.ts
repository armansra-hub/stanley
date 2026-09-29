import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn(), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { classifyCustomerReference, type ReferenceCheckpoint } from "./customerReferenceResearch";
import { customerReferenceCatalogSources, customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
import { OPERATING_FACETS, operatingFacetQuestion } from "./operatingCatalog";
import configuredReferences from "./customerReferenceData.json";
const text = "This company installs equipment and performs continuing maintenance for customers. Customer testimonials refer to other businesses.";
const seed: CustomerReferenceSeed = { id: "reference", name: "Reference Company", domain: "reference.test", website: "https://reference.test/",
  announcementDate: "2026-09-24", announcementType: "new_customer", sources: [{ id: "home", url: "https://reference.test/", title: "Services",
    text, contentHash: createHash("sha256").update(text).digest("hex"), observedAt: "2026-09-28T00:00:00Z" }] };
function harness() {
  const writes: { checkpoint: ReferenceCheckpoint; status: string; result: any; error: string | null }[] = [];
  const save = vi.fn(async (checkpoint, status, result, error) => { writes.push(structuredClone({ checkpoint, status, result, error })); return true; });
  const evaluate = vi.fn(async (input: any) => ({ status: "complete", reused: false, evaluation: { ok: true, usage: { inputTokens: 20, outputTokens: 1 },
    provider_result: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(input.questions).map(id => [id,
      { type: "choice", choice: "insufficient_evidence", probabilities: { supported: .1, insufficient_evidence: .9 } }])) } } }));
  return { writes, save, evaluate };
}
describe("customer website interpretation", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("binds every configured official source to its exact captured text and customer domain", () => {
    expect(configuredReferences.references.length).toBeGreaterThan(0);
    for (const reference of configuredReferences.references) {
      const sources = customerReferenceCatalogSources(reference as CustomerReferenceSeed);
      expect(sources.length, reference.id).toBeGreaterThan(0);
    }
  });
  it("uses the exact prospect questions and full observed public sources without customer relationship or Slack claims", async () => {
    const h = harness();
    expect(await classifyCustomerReference(seed, null, Date.now() + 120_000, h as any)).toBe("complete");
    const questions = Object.assign({}, ...h.evaluate.mock.calls.map(([input]) => input.questions));
    expect(questions).toEqual(Object.fromEntries(OPERATING_FACETS.map(f => [f.id, operatingFacetQuestion(f.id)])));
    for (const [input, context] of h.evaluate.mock.calls as any[]) {
      expect(JSON.stringify(input.state)).toContain(text);
      expect(input.state.company).toEqual({ name: seed.name, domain: seed.domain });
      expect(JSON.stringify(input)).not.toContain("new_customer");
      expect(JSON.stringify(input)).not.toContain(seed.announcementDate);
      expect(context).toMatchObject({ purpose: "operating_catalog", sourceKind: "customer_reference" });
    }
    const final = h.writes.at(-1)!;
    expect(Object.keys(final.result.answers)).toHaveLength(47);
    expect(final.result.answers.rr_c01.decision).toBe("insufficient_evidence");
    expect(final.result.answers.rr_c01.nativeResult.answer.probabilities).toEqual({ supported: .1, insufficient_evidence: .9 });
  });
  it("keeps the pending request durable before provider dispatch and resumes saved answers without reasking", async () => {
    const h = harness(); let clock = Date.now(), start = clock;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const original = h.evaluate.getMockImplementation()!;
    h.evaluate.mockImplementation(async input => {
      expect(h.writes.at(-1)!.checkpoint.pending?.input).toEqual(input);
      const answer = await original(input); clock = start + 85_000; return answer;
    });
    expect(await classifyCustomerReference(seed, null, start + 100_000, h as any)).toBe("continued");
    const saved = h.writes.at(-1)!.checkpoint;
    const already = Object.keys(saved.answers); expect(already.length).toBeGreaterThan(0);
    const second = harness(); clock = start;
    expect(await classifyCustomerReference(seed, saved, start + 120_000, second as any)).toBe("complete");
    for (const [input] of second.evaluate.mock.calls) expect(Object.keys(input.questions).some(id => already.includes(id))).toBe(false);
  });
  it("does not send missing, changed-hash, or unrelated-host evidence to Jev", async () => {
    const h = harness();
    expect(await classifyCustomerReference({ ...seed, sources: [] }, null, Date.now() + 120_000, h as any)).toBe("source_blocked");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(() => customerReferenceCatalogSources({ ...seed, sources: [{ ...seed.sources[0], text: "changed" }] })).toThrow("invalid_customer_reference_source");
    expect(() => customerReferenceCatalogSources({ ...seed, sources: [{ ...seed.sources[0], url: "https://other.test/" }] })).toThrow("invalid_customer_reference_source");
    expect(customerReferenceEvidenceKey(seed)).not.toBe(customerReferenceEvidenceKey({ ...seed, sources: [{ ...seed.sources[0], contentHash: "new" }] }));
  });
  it("stops on actual provider hold, preserving exact pending inputs and no invented answers", async () => {
    const h = harness(); h.evaluate.mockResolvedValue({ status: "budget_deferred", reason: "provider_balance_exhausted", retryAt: null } as any);
    expect(await classifyCustomerReference(seed, null, Date.now() + 120_000, h as any)).toBe("provider_hold");
    expect(h.writes.at(-1)).toMatchObject({ status: "pending", checkpoint: { answers: {}, pending: { phase: "answer" } } });
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: "typesafe_http_429", retryable: true, status: "blocked" },
    { code: "typesafe_timeout", retryable: true, status: "blocked" },
    { code: "typesafe_http_520", retryable: true, status: "blocked" },
    { code: "typesafe_http_400", retryable: false, status: "blocked" },
  ])("preserves the exact request as $status after $code without retrying", async ({ code, retryable, status }) => {
    const h = harness();
    h.evaluate.mockResolvedValue({ status: "complete", reused: false, evaluation: {
      ok: false, error: { code, retryable }, usage: null,
    } } as any);
    expect(await classifyCustomerReference(seed, null, Date.now() + 120_000, h as any)).toBe("provider_error");
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    const final = h.writes.at(-1)!;
    expect(final).toMatchObject({ status, error: code, result: null, checkpoint: { answers: {}, requests: 0, reused: 0 } });
    expect(final.checkpoint.pending?.input).toEqual(h.evaluate.mock.calls[0][0]);
    expect(final.checkpoint.pending).toEqual(h.writes[0].checkpoint.pending);
    expect(final.checkpoint).toMatchObject({ failedRequests: 1, unknownUsageRequests: 1,
      providerFailure: { code, billingUncertain: true } });
    const resumed = harness();
    expect(await classifyCustomerReference(seed, { ...final.checkpoint, lastError: final.error }, Date.now() + 120_000, resumed as any))
      .toBe(code === "typesafe_http_400" ? "provider_error" : "provider_request_held");
    expect(resumed.evaluate).not.toHaveBeenCalled();
    expect(resumed.writes.at(-1)?.checkpoint.pending).toEqual(final.checkpoint.pending);
    expect(resumed.writes.at(-1)?.checkpoint.failedRequests).toBe(1);
  });
  it("never sends a request after losing checkpoint ownership", async () => {
    const h = harness(); h.save.mockResolvedValue(false);
    expect(await classifyCustomerReference(seed, null, Date.now() + 120_000, h as any)).toBe("lease_changed");
    expect(h.evaluate).not.toHaveBeenCalled();
  });
  it("keeps original billing uncertainty on a reused failed receipt without counting a new dispatch", async () => {
    const h = harness();
    h.evaluate.mockResolvedValue({ status: "complete", reused: true, evaluation: {
      ok: false, error: { code: "typesafe_timeout", retryable: true }, usage: null,
    } } as any);
    expect(await classifyCustomerReference(seed, null, Date.now() + 120_000, h as any)).toBe("provider_error");
    const final = h.writes.at(-1)!;
    expect(final.checkpoint.providerFailure).toMatchObject({ reused: true, usage: null, billingUncertain: true });
    expect(final.checkpoint.requests).toBe(0);
    expect(final.checkpoint.failedRequests ?? 0).toBe(0);
    expect(final.checkpoint.unknownUsageRequests ?? 0).toBe(0);
    expect(final.checkpoint.inputTokens).toBe(0);
    expect(final.checkpoint.outputTokens).toBe(0);
  });
});
