import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
import { CANDIDATE_VERIFIER_REQUEST_BYTES, verifyCandidateEvidenceLLM } from "./classify";

const input = { companyName: "Example Engineering", companyDomain: "example.test", companyLocation: "Phoenix, AZ",
  expectedEvent: "operating_change", headline: "Example introduces project billing", evidenceUrl: "https://example.test/news/projects",
  evidenceText: "Example Engineering announced a new project delivery and milestone billing model in September 2026." };
const verdict = { exact_company: true, concrete_event: true, event: "operating_change", is_acquirer: false, confidence: "high", reason: "The source identifies the company and its announced billing change." };
beforeEach(() => { create.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("budgeted independent final verifier", () => {
  it("accepts operating changes and reports measured usage separately from the verdict", async () => {
    const usage = vi.fn();
    create.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1000, output_tokens: 80 } });
    expect(await verifyCandidateEvidenceLLM(input, { singleAttempt: true, onUsage: usage })).toEqual(verdict);
    expect(usage).toHaveBeenCalledWith({ inputTokens: 1000, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
  });

  it("bounds complete Unicode requests by bytes while preserving source attribution", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1000, output_tokens: 80 } });
    await verifyCandidateEvidenceLLM({ ...input, evidenceText: "界".repeat(12000) }, { singleAttempt: true });
    const request = create.mock.calls[0][0];
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(CANDIDATE_VERIFIER_REQUEST_BYTES);
    expect(request.messages[0].content).toContain(input.evidenceUrl);
    expect(request.max_tokens).toBe(256);
  });

  it("does not dispatch an unreserved fallback on ambiguous failure", async () => {
    const usage = vi.fn();
    create.mockRejectedValue(new Error("response lost"));
    expect(await verifyCandidateEvidenceLLM(input, { singleAttempt: true, onUsage: usage })).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(usage).not.toHaveBeenCalled();
  });

  it("retains known usage when the response cannot be interpreted", async () => {
    const usage = vi.fn();
    create.mockResolvedValue({ content: [{ type: "text", text: "invalid" }], usage: { input_tokens: 1000, output_tokens: 10 } });
    expect(await verifyCandidateEvidenceLLM(input, { singleAttempt: true, onUsage: usage })).toBeNull();
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1000, outputTokens: 10 }));
  });

  it("aborts on the remaining runtime and makes only one paid attempt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    create.mockImplementation((_body, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = verifyCandidateEvidenceLLM(input, { singleAttempt: true, deadlineMs: 1250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the legacy unsupported-schema fallback when no budgeted mode is requested", async () => {
    create.mockRejectedValueOnce(new Error("unsupported schema")).mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1000, output_tokens: 80 } });
    expect(await verifyCandidateEvidenceLLM(input)).toEqual(verdict);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
