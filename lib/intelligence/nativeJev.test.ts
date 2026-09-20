import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("never loops or leaks provider error bodies", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const fetch = vi.fn().mockResolvedValue(new Response("do not log this", { status: 429 }));
    expect(await evaluateNativeQuestions(input, { fetch })).toEqual({ ok: false, error: { code: "typesafe_http_429", retryable: true }, usage: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains usage when malformed native output cannot be interpreted", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-private-key");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "jev-1.13.0", answers: { expansion: { type: "noul", noul: 50 } }, usage: { input_tokens: 100 } })));
    expect(await evaluateNativeQuestions(input, { fetch })).toMatchObject({ ok: false, usage: { inputTokens: 100, outputTokens: null } });
  });
});
