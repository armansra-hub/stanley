import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./budget", async importOriginal => ({ ...await importOriginal<typeof import("./budget")>(),
  authorizeJevDispatch: vi.fn(async () => {}) }));
vi.mock("./jevRequests", () => ({ durableJevRequest: vi.fn() }));
import { evaluateNativeQuestions, evaluateNativeCached, nativeJevBody, nativeJevFingerprint } from "./nativeJev";

afterEach(() => vi.unstubAllEnvs());
const input = { state: { source: "Example Services opened its Denver office on September 1.", company: "Example Services" },
  questions: { expansion: { type: "noul" as const, instructions: "Does the source establish the target opened an office?" } } };
describe("native Jev shared transport", () => {
  it("keeps native answers, usage and useful question context unchanged", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const raw = { model: "jev-1.13.0", answers: { expansion: { type: "noul", noul: .87 } }, usage: { input_tokens: 310, output_tokens: 10 } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
    const result = await evaluateNativeQuestions(input, { fetch });
    expect(result).toEqual({ ok: true, provider_result: raw, usage: { inputTokens: 310, outputTokens: 10 } });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.questions).toEqual(input.questions);
    expect(sent.state).toEqual(input.state);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send private evidence without the existing authorization", async () => {
    const fetch = vi.fn();
    vi.stubEnv("TYPESAFE_PRIVATE_EXCERPTS_ENABLED", "false");
    expect(await evaluateNativeQuestions({ ...input, privacy: "private_excerpt" }, { fetch })).toMatchObject({ ok: false, error: { code: "privacy_not_authorized" } });
    expect(fetch).not.toHaveBeenCalled();
    await expect(evaluateNativeCached({ ...input, privacy: "private_excerpt" }, { purpose: "codex_connector" })).rejects.toThrow("Private");
  });
  it("binds reuse to evidence and exact questions while ignoring object key order", () => {
    expect(nativeJevFingerprint(input)).toBe(nativeJevFingerprint({ questions: input.questions, state: { company: input.state.company, source: input.state.source } }));
    expect(nativeJevFingerprint(input)).not.toBe(nativeJevFingerprint({ ...input, state: { ...input.state, company: "Another company" } }));
    expect(nativeJevFingerprint(input)).not.toBe(nativeJevFingerprint({ ...input, privacy: "private_excerpt" }));
  });
  it("rejects oversized inputs rather than silently dropping evidence", () => {
    expect(() => nativeJevBody({ ...input, state: "x".repeat(50_000) })).toThrow("too_large");
    expect(() => nativeJevBody({ ...input, questions: { bad: { type: "choice", instructions: "Choose", criteria: { only: "one" } } } })).toThrow("criteria");
  });
  it("permits complete public customer evidence without changing the wire body or existing reuse keys", async () => {
    const profile = { ...input, privacy: "public" as const, requestProfile: "customer-reference-full-source-v1" as const };
    expect(nativeJevFingerprint(profile)).toBe(nativeJevFingerprint({ ...input, privacy: "public" }));
    const large = { ...profile, state: { source: "Exact retained customer source. ".repeat(2000) } };
    expect(() => nativeJevBody({ ...large, requestProfile: undefined })).toThrow("native_request_too_large");
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const raw = { model: "jev-1.13.0", answers: { expansion: { type: "noul", noul: .87 } }, usage: { input_tokens: 15_200, output_tokens: 10 } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw)));
    expect(await evaluateNativeQuestions(large, { fetch })).toMatchObject({ ok: true, provider_result: raw });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent).toEqual({ model: "jev-1.13.0", state: large.state, questions: large.questions });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(evaluateNativeCached(large, { purpose: "codex_connector" })).rejects.toThrow("customer_reference_profile_scope_required");
    expect(() => nativeJevBody({ ...large, privacy: "private_excerpt" })).toThrow("invalid_native_request_profile");
    expect(() => nativeJevBody({ ...large, state: "x".repeat(192_001) })).toThrow("native_request_too_large");
  });
  it.each([400, 422])("retains a customer context rejection %s after one provider call without a smaller-text retry", async status => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const large = { ...input, state: "Complete retained source. ".repeat(2200), privacy: "public" as const,
      requestProfile: "customer-reference-full-source-v1" as const };
    const response = new Response("provider detail may contain source content", { status });
    const read = vi.spyOn(response, "text");
    const fetch = vi.fn().mockResolvedValue(response);
    expect(await evaluateNativeQuestions(large, { fetch })).toEqual({ ok: false,
      error: { code: `typesafe_http_${status}`, retryable: false }, usage: null });
    expect(fetch).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  });
  it("never loops or leaks provider error bodies", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const fetch = vi.fn().mockResolvedValue(new Response("do not log this", { status: 429 }));
    expect(await evaluateNativeQuestions(input, { fetch })).toEqual({ ok: false, error: { code: "typesafe_http_429", retryable: true }, usage: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains only explicit structured context codes, never echoed source text or a guessed400 cause", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const customer = { ...input, privacy: "public" as const, requestProfile: "customer-reference-full-source-v1" as const };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "DO NOT STORE source echo" } }), { status: 400 }));
    const result = await evaluateNativeQuestions(customer, { fetch });
    expect(result).toEqual({ ok: false, error: { code: "typesafe_http_400", retryable: false,
      contextLimit: { kind: "provider_error_code", code: "context_length_exceeded" } }, usage: null });
    expect(JSON.stringify(result)).not.toContain("DO NOT STORE"); expect(fetch).toHaveBeenCalledOnce();
    const unknown = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "bad_request", message: "context_length_exceeded quoted inside the source" } }), { status: 400 }));
    expect(await evaluateNativeQuestions(customer, { fetch: unknown })).toEqual({ ok: false, error: { code: "typesafe_http_400", retryable: false }, usage: null });
    const oversized = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "x".repeat(20_000) } }), { status: 400 }));
    expect(await evaluateNativeQuestions(customer, { fetch: oversized })).toEqual({ ok: false, error: { code: "typesafe_http_400", retryable: false }, usage: null });
  });
  it("records payment-required distinctly from rate limiting without assuming zero usage or reading its body", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const response = new Response("Private provider echo must not be read", { status: 402 });
    const read = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetch = vi.fn().mockResolvedValue(response);
    expect(await evaluateNativeQuestions(input, { fetch })).toEqual({ ok: false,
      error: { code: "typesafe_http_402", retryable: false }, usage: null });
    expect(fetch).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains usage when malformed native output cannot be interpreted", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev-1.13.0", answers: { expansion: { type: "noul", noul: 50 } }, usage: { input_tokens: 100 } })));
    expect(await evaluateNativeQuestions(input, { fetch })).toMatchObject({ ok: false, usage: { inputTokens: 100, outputTokens: null } });
  });
});
