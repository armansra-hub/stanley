import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateEvidence, estimateEvidenceInputTokens, JEV_MODEL, JEV_QUESTION_VERSION,
  MAX_EVIDENCE_STATE_BYTES, MAX_COMPANY_CONTEXT_BYTES, MAX_SURROUNDING_CONTEXT_BYTES, MAX_RAW_ANSWERS_BYTES, type JevEvaluationRequest,
  hasPrivateExcerptAuthorization, TYPESAFE_EVALUATION_URL,
} from "./jev";
import type { EvaluateEvidenceInput } from "./evaluation";

const input: EvaluateEvidenceInput = {
  text: "Example Engineering opened a second facility to support newly awarded work.",
  companyName: "Example Engineering", companyDomain: "example.test",
  sourceKind: "company_news", title: "A second facility", sourceUrl: "https://example.test/news/facility",
};

// Native HTTP fixtures follow https://docs.typesafe.ai/api (not SDK/Gateway shapes).
function response() {
  return {
    model: JEV_MODEL,
    answers: {
      signalType: { type: "choice", choice: "press", probabilities: { funding: 0, new_entity: 0, ma: 0, gov_contract: 0, finance_hire: 0, press: 1, erp_tech: 0, hiring_velocity: 0, employee_growth: 0, federal_award: 0, federal_subaward: 0, sam_award_notice: 0, operating_change: 0, news: 0, none: 0 }, confidence: 0.92 },
      companyRelationship: { type: "choice", choice: "direct", probabilities: { direct: 1, related: 0, unrelated: 0, unknown: 0 }, confidence: 0.9 },
      companyRelevance: { type: "noul", noul: 0.96 },
      concreteEvent: { type: "noul", noul: 0.91 },
      isAcquirer: { type: "noul", noul: 0 },
      operationalComplexity: { type: "score", score: 2.4, legend: { "0": "No additional complexity supported", "1": "A limited change in one operating process", "2": "A meaningful change involving multiple processes, locations or reporting needs", "3": "A substantial multi-entity, multi-country or multi-model operating change" }, probabilities: { "0": 0, "1": 0, "2": 0.6, "3": 0.4 }, confidence: 0.8 },
      growthRelevance: { type: "score", score: 1.8, legend: { "0": "No growth supported or contraction only", "1": "Possible growth with little concrete support", "2": "Concrete expansion, resources or business activity", "3": "Multiple direct facts establishing a substantial business expansion" }, probabilities: { "0": 0, "1": 0.2, "2": 0.8, "3": 0 }, confidence: 0.8 },
      evidenceStrength: { type: "score", score: 3, legend: { "0": "No attributable factual support", "1": "An indirect or uncorroborated mention", "2": "Specific attributable reporting or a clear company statement", "3": "Direct authoritative record or detailed primary evidence" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 }, confidence: 1 },
      requiresResearch: { type: "noul", noul: 0.42 },
    } as Record<string, unknown>,
    usage: { input_tokens: 2_300, output_tokens: 0 },
  };
}

beforeEach(() => {
  vi.stubEnv("TYPESAFE_MODEL", "");
  vi.stubEnv("TYPESAFE_PRIVATE_EXCERPTS_ENABLED", "");
  vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-a-real-secret");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Jev evidence adapter", () => {
  it("normalizes typed answers without treating probability as a grade or losing zero", async () => {
    const evaluate = vi.fn(async () => response());
    const result = await evaluateEvidence(input, { evaluate });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).toEqual({
      signalType: "press", companyRelationship: "direct", evidenceSectionId: null, companyRelevance: 0.96,
      concreteEvent: 0.91, isAcquirer: 0, operationalComplexity: 0.7999999999999999,
      growthRelevance: 0.6, evidenceStrength: 1, requiresResearch: 0.42,
    });
    expect(result).toMatchObject({ model: JEV_MODEL, questionVersion: JEV_QUESTION_VERSION, usage: { inputTokens: 2_300, outputTokens: 0 } });
    expect(result.metadata).toEqual({ provider: "typesafe-direct", responseModel: JEV_MODEL, rawAnswers: response().answers,
      confidence: { signalType: 0.92, companyRelationship: 0.9, operationalComplexity: 0.8, growthRelevance: 0.8, evidenceStrength: 1 } });
    expect(result).not.toHaveProperty("tamScore");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("supplies public background, same-source neighboring text and distinct dates without changing the packet", async () => {
    const context = { eventDate: "2026-09-10", observedAt: "2026-09-18T10:30:00-07:00",
      companyContext: "Public company profile: engineering services in Texas. Source: https://example.test/about",
      surroundingContext: "The preceding paragraph identifies Example Engineering. The following paragraph describes its Austin facility." };
    const evaluate = vi.fn(async (request: JevEvaluationRequest) => {
      expect(request.state).toMatchObject({ ...context, evidence: input.text, sourceUrl: input.sourceUrl });
      expect(request.questions.companyRelationship.instructions).toContain("companyContext is public background, not proof of this event");
      expect(request.questions.concreteEvent.instructions).toContain("observedAt is collection time, not event timing");
      expect(request.questions.signalType.instructions).toContain("surroundingContext is nearby text from this same source");
      expect(Buffer.byteLength(JSON.stringify(request.state))).toBeLessThanOrEqual(MAX_EVIDENCE_STATE_BYTES);
      expect(Buffer.byteLength(JSON.stringify({ state: request.state, questions: request.questions }))).toBeLessThanOrEqual(48_000);
      return response();
    });
    const result = await evaluateEvidence({ ...input, ...context }, { evaluate });
    expect(result).toMatchObject({ ok: true, questionVersion: "stanley-evidence-v2" });
    expect(estimateEvidenceInputTokens({ ...input, ...context })).toBeGreaterThan(estimateEvidenceInputTokens(input)!);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(context.companyContext);
    expect(JSON.stringify(result)).not.toContain(context.surroundingContext);
  });

  it("never substitutes observation time for an unknown event date", async () => {
    const evaluate = vi.fn(async (request: JevEvaluationRequest) => {
      expect(request.state.observedAt).toBe("2026-09-18T17:30:00Z");
      expect(request.state).not.toHaveProperty("eventDate");
      expect(request.state).not.toHaveProperty("companyContext");
      expect(request.state).not.toHaveProperty("surroundingContext");
      expect(request.questions.concreteEvent.instructions).toContain("Missing dates remain unknown");
      return response();
    });
    expect((await evaluateEvidence({ ...input, observedAt: "2026-09-18T17:30:00Z" }, { evaluate })).ok).toBe(true);
  });

  it.each([
    { eventDate: "x".repeat(65) }, { observedAt: "x".repeat(65) }, { companyContext: " " },
    { companyContext: "界".repeat(Math.ceil((MAX_COMPANY_CONTEXT_BYTES + 1) / 3)) },
    { surroundingContext: "x".repeat(MAX_SURROUNDING_CONTEXT_BYTES + 1) },
    { text: "x".repeat(16_000), companyContext: "x".repeat(4_000), surroundingContext: "x".repeat(4_000) },
  ])("retains per-field and total UTF-8 limits for contextual input: %j", async patch => {
    const evaluate = vi.fn();
    expect(await evaluateEvidence({ ...input, ...patch }, { evaluate })).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    expect(estimateEvidenceInputTokens({ ...input, ...patch })).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("preserves raw unknown, zero, fractional scores and distributions without recalibration or a second call", async () => {
    const native = response();
    native.answers.companyRelationship = { type: "choice", choice: "unknown",
      probabilities: { direct: 0.12, related: 0.13, unrelated: 0.01, unknown: 0.74 }, confidence: 0.37 };
    native.answers.operationalComplexity = { type: "score", score: 2.123456789,
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.6, "3": 0.2 }, legend: { "0": "None", "1": "Limited", "2": "Meaningful", "3": "Substantial" }, confidence: 0 };
    native.answers.criterion_multi_entity = { type: "noul", noul: 0.17 };
    const evaluate = vi.fn(async () => native);
    const result = await evaluateEvidence({ ...input, criteria: [{ id: "multi_entity", instructions: "Does the evidence describe multiple entities?" }] }, { evaluate });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.rawAnswers).toEqual(native.answers);
    expect(result.attributes.companyRelationship).toBe("unknown");
    expect(result.metadata.rawAnswers?.operationalComplexity).toMatchObject({ score: 2.123456789, confidence: 0 });
    expect(result.metadata.rawAnswers?.isAcquirer).toEqual({ type: "noul", noul: 0 });
    expect(Buffer.byteLength(JSON.stringify(result.metadata.rawAnswers))).toBeLessThanOrEqual(MAX_RAW_ANSWERS_BYTES);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("copies only requested typed answer fields, excluding unexpected response echoes", async () => {
    const native = response();
    native.answers.unrequested = { type: "noul", noul: 1, secret: "private provider echo" };
    native.answers.companyRelevance = { type: "noul", noul: 0.96, explanation: "private provider echo" };
    const result = await evaluateEvidence(input, { evaluate: async () => ({ ...native, state: "private provider echo" }) });
    expect(result.ok && result.metadata.rawAnswers?.companyRelevance).toEqual({ type: "noul", noul: 0.96 });
    expect(result.ok && result.metadata.rawAnswers).not.toHaveProperty("unrequested");
    expect(JSON.stringify(result)).not.toContain("private provider echo");
  });

  it.each([
    { type: "score", score: 2.4, probabilities: { "0": 1.1 } },
    { type: "score", score: 2.4, probabilities: { not_a_level: 0.5 } },
    { type: "score", score: 2.4, legend: { "0": "x".repeat(1201) } },
  ])("bounds raw native answer fields without retaining malformed provider text: %j", async answer => {
    const result = await evaluateEvidence(input, { evaluate: async () => ({ ...response(), answers: { ...response().answers, operationalComplexity: answer } }) });
    expect(result).toMatchObject({ ok: false, usage: { inputTokens: 2300 }, error: { kind: "invalid_response" } });
    expect(result).not.toHaveProperty("metadata");
  });

  it("sends bounded criteria together, exact source text separately from the title, and disables transport retries", async () => {
    let captured: JevEvaluationRequest | undefined;
    const result = await evaluateEvidence({ ...input, criteria: [{ id: "project_billing", instructions: "Does this evidence mention project billing?" }] }, {
      evaluate: async request => {
        captured = request;
        return { ...response(), answers: { ...response().answers, criterion_project_billing: { type: "noul", noul: 0.17 } } };
      },
    });
    expect(result.ok && result.criteria).toEqual({ project_billing: 0.17 });
    expect(captured?.state).toMatchObject({ evidence: input.text, title: input.title, companyName: input.companyName });
    expect(captured?.questions.criterion_project_billing).toMatchObject({ type: "noul" });
    expect(captured?.maxRetries).toBe(0);
    expect(captured?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("blocks private excerpts until direct-account data handling has been verified and enabled", async () => {
    const evaluate = vi.fn();
    expect(hasPrivateExcerptAuthorization()).toBe(false);
    expect(await evaluateEvidence({ ...input, privacy: "private_excerpt" }, { evaluate })).toMatchObject({ ok: false, error: { kind: "privacy_not_authorized", retryable: false } });
    expect(evaluate).not.toHaveBeenCalled();
    vi.stubEnv("TYPESAFE_PRIVATE_EXCERPTS_ENABLED", "TRUE");
    expect(hasPrivateExcerptAuthorization()).toBe(false);
  });

  it("uses only the authorized direct route for private excerpts and never downgrades after refusal", async () => {
    vi.stubEnv("TYPESAFE_PRIVATE_EXCERPTS_ENABLED", "true");
    expect(hasPrivateExcerptAuthorization()).toBe(true);
    const evaluate = vi.fn(async (request: JevEvaluationRequest) => {
      expect(request).not.toHaveProperty("providerOptions");
      throw { statusCode: 403, message: "private text echoed in provider error" };
    });
    const result = await evaluateEvidence({ ...input, privacy: "private_excerpt" }, { evaluate });
    expect(result).toMatchObject({ ok: false, error: { kind: "authentication", retryable: false, statusCode: 403 } });
    expect(JSON.stringify(result)).not.toContain("private text");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("rejects oversize UTF-8 evidence instead of silently truncating it or calling the provider", async () => {
    const evaluate = vi.fn();
    const oversized = { ...input, text: "界".repeat(Math.ceil(MAX_EVIDENCE_STATE_BYTES / 3)) };
    expect(estimateEvidenceInputTokens(oversized)).toBeNull();
    expect(await evaluateEvidence(oversized, { evaluate })).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { text: " " },
    { criteria: [{ id: "same", instructions: "One?" }, { id: "same", instructions: "Two?" }] },
    { criteria: [{ id: "__proto__", instructions: "One?" }] },
    { criteria: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, instructions: "One?" })) },
    { criteria: [{ id: "q", instructions: "x".repeat(1_201) }] },
    { feedbackExamples: Array.from({ length: 4 }, () => ({ text: "Old evidence", correction: "Old repost" })) },
    { sections: [{ id: "s1", text: "This passage is not in the source." }] },
    { sections: [{ id: "s1", text: input.text }, { id: "s1", text: input.text }] },
    { sections: Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, text: input.text })) },
    { sections: [{ id: "__none__", text: input.text }] },
  ])("rejects invalid or unbounded input before transport: %j", async invalid => {
    const evaluate = vi.fn();
    expect(await evaluateEvidence({ ...input, ...invalid }, { evaluate })).toMatchObject({ ok: false, error: { kind: "invalid_input", retryable: false } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("includes up to three small correction examples without confusing them with current evidence", async () => {
    const examples = [{ text: "Parent company wins a contract", correction: "This was not the subsidiary's contract." }];
    const evaluate = vi.fn(async (request: JevEvaluationRequest) => {
      expect(JSON.parse(request.state.feedbackExamples)).toEqual(examples);
      expect(request.questions.companyRelationship.instructions).toContain("not facts about this observation");
      return response();
    });
    expect((await evaluateEvidence({ ...input, feedbackExamples: examples }, { evaluate })).ok).toBe(true);
  });

  it.each([["s1", "s1"], ["__none__", null]])("selects a supplied verbatim section or abstains: %s", async (selected, expected) => {
    const sections = [{ id: "s1", text: "opened a second facility" }];
    const result = await evaluateEvidence({ ...input, sections }, {
      evaluate: async request => {
        expect(JSON.parse(request.state.sections)).toEqual(sections);
        expect(request.state.evidence).toBe(input.text);
        expect(request.questions.evidenceSectionId).toMatchObject({ type: "choice", criteria: { s1: expect.any(String), __none__: expect.any(String) } });
        return { ...response(), answers: { ...response().answers, evidenceSectionId: { type: "choice", choice: selected, probabilities: { s1: selected === "s1" ? 1 : 0, __none__: selected === "__none__" ? 1 : 0 }, confidence: 1 } } };
      },
    });
    expect(result.ok && result.attributes.evidenceSectionId).toBe(expected);
  });

  it.each([undefined, { type: "choice", choice: "invented_section" }])("rejects unsupported or missing section selection", async answer => {
    const result = await evaluateEvidence({ ...input, sections: [{ id: "s1", text: input.text }] }, {
      evaluate: async () => ({ ...response(), answers: { ...response().answers, evidenceSectionId: answer } }),
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });

  it.each([
    ["concreteEvent", { type: "noul", noul: 1.01 }],
    ["companyRelevance", { type: "noul", noul: NaN }],
    ["concreteEvent", { type: "boolean", probability: 0.8 }],
    ["signalType", { type: "choice", choice: "invented_signal" }],
    ["companyRelationship", { type: "choice", choice: "probably" }],
    ["operationalComplexity", { type: "score", score: 4 }],
    ["requiresResearch", undefined],
  ])("rejects malformed %s but retains known billable usage", async (key, answer) => {
    const result = await evaluateEvidence(input, { evaluate: async () => ({ ...response(), answers: { ...response().answers, [key]: answer } }) });
    expect(result).toMatchObject({ ok: false, usage: { inputTokens: 2_300 }, error: { kind: "invalid_response", retryable: false } });
  });

  it("requires an answer for each supplied criterion", async () => {
    const result = await evaluateEvidence({ ...input, criteria: [{ id: "q", instructions: "Question?" }] }, { evaluate: async () => response() });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });

  it.each([
    [401, "authentication", false], [402, "billing", false], [422, "invalid_request", false],
    [429, "rate_limit", true], [503, "provider_unavailable", true], [504, "timeout", true], [529, "provider_unavailable", true],
  ])("classifies HTTP %s for the worker, with no provider body leakage", async (statusCode, kind, retryable) => {
    const result = await evaluateEvidence(input, { evaluate: async () => { throw { statusCode, responseHeaders: { "retry-after": "2.5" }, responseBody: input.text }; } });
    expect(result).toMatchObject({ ok: false, error: { kind, retryable, statusCode, retryAfterMs: 2_500 } });
    expect(JSON.stringify(result)).not.toContain(input.text);
  });

  it("does not turn missing usage into zero cost", async () => {
    const result = await evaluateEvidence(input, { evaluate: async () => ({ answers: response().answers }) });
    expect(result).toMatchObject({ ok: true, usage: null });
    const partial = await evaluateEvidence(input, { evaluate: async () => ({ answers: response().answers, usage: { output_tokens: 0 } }) });
    expect(partial.usage).toEqual({ inputTokens: null, outputTokens: 0 });
  });

  it("honors caller cancellation before starting a paid call", async () => {
    const controller = new AbortController();
    controller.abort();
    const evaluate = vi.fn();
    expect(await evaluateEvidence({ ...input, abortSignal: controller.signal }, { evaluate })).toMatchObject({ ok: false, error: { kind: "cancelled", retryable: false } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("provides a conservative reservation estimate that includes added questions and context", () => {
    const base = estimateEvidenceInputTokens(input)!;
    const extended = estimateEvidenceInputTokens({ ...input, criteria: [{ id: "q", instructions: "Is project billing involved?" }] })!;
    expect(base).toBeGreaterThan(Buffer.byteLength(input.text));
    expect(extended).toBeGreaterThan(base);
  });

  it("posts the native schema directly with Bearer auth and no Gateway fields or redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response()), { status: 200 }));
    expect((await evaluateEvidence(input, { fetch: fetcher })).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(TYPESAFE_EVALUATION_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { authorization: "Bearer test-key-not-a-real-secret", "content-type": "application/json" } });
    const payload = JSON.parse(String(init?.body));
    expect(Object.keys(payload).sort()).toEqual(["model", "questions", "state"]);
    expect(payload.model).toBe("jev-1.13.0");
    expect(payload.questions.companyRelevance.type).toBe("noul");
    expect(payload.questions.companyRelationship.criteria).toMatchObject({ direct: expect.any(String), unknown: expect.any(String) });
    expect(payload.questions.evidenceStrength.criteria).toHaveLength(4);
    expect(payload.state.evidence).toBe(input.text);
  });

  it("does not make a request without the direct account key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetcher = vi.fn<typeof fetch>();
    expect(await evaluateEvidence(input, { fetch: fetcher })).toMatchObject({ ok: false, error: { kind: "authentication", retryable: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows a pinned model override but rejects aliases or another provider", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-1.14.0");
    const evaluate = vi.fn(async (request: JevEvaluationRequest) => ({ ...response(), model: request.model }));
    expect(await evaluateEvidence(input, { evaluate })).toMatchObject({ ok: true, model: "jev-1.14.0", metadata: { responseModel: "jev-1.14.0" } });
    for (const value of ["jev-latest", "typesafe-ai/jev", "https://another-provider.test", "jev-1.13.0\nother"]) {
      vi.stubEnv("TYPESAFE_MODEL", value);
      evaluate.mockClear();
      expect(await evaluateEvidence(input, { evaluate })).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
      expect(evaluate).not.toHaveBeenCalled();
    }
  });

  it("honors direct Retry-After without reading the error body or retrying", async () => {
    const providerResponse = new Response(`private provider echo ${input.text}`, { status: 529, headers: { "retry-after": "7" } });
    const text = vi.spyOn(providerResponse, "text");
    const json = vi.spyOn(providerResponse, "json");
    const fetcher = vi.fn<typeof fetch>(async () => providerResponse);
    const result = await evaluateEvidence(input, { fetch: fetcher });
    expect(result).toMatchObject({ ok: false, error: { kind: "provider_unavailable", statusCode: 529, retryAfterMs: 7_000, retryable: true } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(input.text);
  });

  it("parses HTTP-date Retry-After and bounds delays", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-18T12:00:00Z"));
    const result = await evaluateEvidence(input, { evaluate: async () => { throw { status: 429, responseHeaders: { "retry-after": "Fri, 18 Sep 2026 12:00:12 GMT" } }; } });
    expect(result).toMatchObject({ ok: false, error: { retryAfterMs: 12_000 } });
    const bounded = await evaluateEvidence(input, { evaluate: async () => { throw { status: 429, responseHeaders: { "retry-after": "999999999" } }; } });
    expect(bounded).toMatchObject({ ok: false, error: { retryAfterMs: 86_400_000 } });
  });

  it.each(["not JSON", "x".repeat(262_145)])("rejects malformed or oversized successful HTTP bodies", async body => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
    expect(await evaluateEvidence(input, { fetch: fetcher })).toMatchObject({ ok: false, error: { kind: "invalid_response", retryable: false } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
