import { describe, expect, it } from "vitest";
import { evidencePackets, candidateType, nextRetrySeconds } from "./worker";
import type { EvaluateEvidenceResult } from "./evaluation";

const result = { ok: true, model: "test", questionVersion: "v1", usage: null, metadata: { provider: "typesafe-direct" }, criteria: {},
  attributes: { signalType: "ma", companyRelationship: "direct", companyRelevance: 0.95, concreteEvent: 0.96,
    isAcquirer: 0.97, operationalComplexity: 0.7, growthRelevance: 0.7, evidenceStrength: 0.8, requiresResearch: 0.6, evidenceSectionId: "s1" },
} as Extract<EvaluateEvidenceResult, { ok: true }>;

describe("complete bounded evidence packets", () => {
  it("covers Unicode and long text exactly without split surrogate pairs", () => {
    const text = "A public update 😀 漢字.\n".repeat(3000);
    const packets = evidencePackets(text);
    expect(packets.map((p) => p.text).join("")).toBe(text);
    expect(packets.every((p) => Buffer.byteLength(p.text) <= 8000)).toBe(true);
    for (const p of packets) expect(text.slice(p.start, p.end)).toBe(p.text);
  });
});
describe("evidence-to-existing-review routing", () => {
  it("routes exact current acquirers and never invents event dates", () => {
    const now = Date.parse("2026-09-18");
    expect(candidateType(result, "2026-09-17", now)).toBe("ma");
    expect(candidateType(result, null, now)).toBeNull();
    expect(candidateType(result, "2020-01-01", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, isAcquirer: 0.1 } }, "2026-09-17", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, companyRelationship: "related" } }, "2026-09-17", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, signalType: "federal_award" } }, "2026-09-17", now)).toBeNull();
  });
  it("backs off deferred work instead of continuously retrying it", () => {
    expect(nextRetrySeconds(1)).toBe(120);
    expect(nextRetrySeconds(5)).toBeGreaterThan(nextRetrySeconds(2));
  });
});
