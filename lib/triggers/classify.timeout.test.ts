import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
import { classifyEventLLM, HEADLINE_CLASSIFIER_TIMEOUT_MS } from "./classify";

beforeEach(() => { create.mockReset(); vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("headline classifier remaining runtime", () => {
  it("cancels a hung request at its deadline and returns the existing unverified fallback", async () => {
    create.mockImplementation((_body, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = classifyEventLLM("Example", "Example raises funding", { deadlineMs: 1250 });
    expect(create.mock.calls[0][1].timeout).toBe(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBeNull();
    expect(create.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not start another sequential classifier after the batch budget expires", async () => {
    expect(await classifyEventLLM("Example", "Another headline", { deadlineMs: 999 })).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds callers without a supplied deadline and cleans up the timer after success", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: '{"about_company":true,"event":"funding","is_acquirer":false}' }] });
    expect(await classifyEventLLM("Example", "Example raises funding")).toMatchObject({ event: "funding" });
    expect(create.mock.calls[0][1].timeout).toBe(HEADLINE_CLASSIFIER_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
