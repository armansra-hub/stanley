import { describe, expect, it } from "vitest";
import { readTriggerSourceEvidence } from "./triggerEvidence";

const evidence = { observationId: "11111111-1111-4111-8111-111111111111", excerpt: "Exact sourced passage.", start: 20, end: 42, observedAt: "2026-09-18T20:00:00Z" };
describe("trigger source passage", () => {
  it("retains original text and source coordinates", () => {
    expect(readTriggerSourceEvidence({ intelligenceEvidence: evidence })).toEqual(evidence);
  });
  it("does not display malformed, oversized or invented-offset passages", () => {
    expect(readTriggerSourceEvidence({ intelligenceEvidence: { ...evidence, end: 43 } })).toBeNull();
    expect(readTriggerSourceEvidence({ intelligenceEvidence: { ...evidence, excerpt: "x".repeat(1201), start: 0, end: 1201 } })).toBeNull();
    expect(readTriggerSourceEvidence({ intelligenceEvidence: { ...evidence, observedAt: "unknown" } })).toBeNull();
    expect(readTriggerSourceEvidence({})).toBeNull();
  });
});
