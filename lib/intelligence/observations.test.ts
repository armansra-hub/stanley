import { describe, expect, it } from "vitest";
import { canonicalEvidenceUrl, evidenceSections, prepareObservation } from "./observations";
import { jevCost, secondsUntilNextMonth } from "./budget";

const base = { companyId: "11111111-1111-4111-8111-111111111111", companyName: "Example Services", sourceKind: "website" as const,
  sourceUrl: "https://example.com/news?utm_source=feed&article=2#main", title: "Operating update", text: "A sourced public update." };
describe("durable observation identity", () => {
  it("coalesces tracking variants while retaining meaningful query identifiers", () => {
    expect(canonicalEvidenceUrl(base.sourceUrl)).toBe("https://example.com/news?article=2");
    expect(prepareObservation(base).contentHash).toBe(prepareObservation({ ...base, observedAt: "2026-09-18T00:00:00Z" }).contentHash);
    expect(prepareObservation(base).contentHash).not.toBe(prepareObservation({ ...base, companyDomain: "example.com" }).contentHash);
    expect(prepareObservation(base).sourceKey).toBe(prepareObservation({ ...base, sourceKind: "news" }).sourceKey);
    expect(prepareObservation(base).contentHash).toBe(prepareObservation({ ...base, sourceKind: "news" }).contentHash);
    expect(prepareObservation(base).contentHash).toBe(prepareObservation({ ...base, netsuiteInternalId: "1234" }).contentHash);
  });
  it("keeps exact source spans and marks bounded public captures", () => {
    const text = "First paragraph.\n".repeat(800);
    const parts = evidenceSections(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    for (const p of parts) expect(text.slice(p.start, p.end)).toBe(p.text);
    expect(prepareObservation({ ...base, text: "a".repeat(50_000) }).metadata.textTruncated).toBe(true);
  });
  it("rejects unsafe URLs and invalid dates without inventing an event timestamp", () => {
    expect(() => prepareObservation({ ...base, sourceUrl: "http://127.0.0.1/private" })).toThrow();
    expect(() => prepareObservation({ ...base, eventDate: "not a date" })).toThrow();
    expect(prepareObservation(base).eventDate).toBeNull();
  });
});
describe("Jev cost accounting", () => {
  it("rounds reservations upward and uses UTC calendar months", () => {
    expect(jevCost(120_000_000)).toBe(5.04);
    expect(jevCost(65_536)).toBe(0.002753);
    expect(jevCost(1)).toBe(0.000001);
    expect(secondsUntilNextMonth(new Date("2026-09-30T23:59:30Z"))).toBe(30);
  });
});
