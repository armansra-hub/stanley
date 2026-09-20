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
  it("keeps the legacy base identity stable when only discovery provenance differs", () => {
    const a = prepareObservation({ ...base, metadata: { discovery: { collector: "website" } } });
    const b = prepareObservation({ ...base, metadata: { discovery: { collector: "directed_research", url: "https://example.com/redirect" } } });
    expect(a.sourceKey).toBe(b.sourceKey);
    expect(a.contentHash).toBe(b.contentHash);
    expect(b.metadata.discovery).toEqual({ collector: "directed_research", url: "https://example.com/redirect" });
    // No version bump or historical reset is needed to reuse an existing page.
    expect(a.contentHash).toBe(prepareObservation(base).contentHash);
  });
  it("keeps genuinely changed publisher facts, company context and documents distinct", () => {
    const original = prepareObservation(base);
    for (const update of [{ title: "New acquisition" }, { text: "A different operating model." }, { eventDate: "2026-09-19" }, { companyName: "Different Services" }]) {
      expect(prepareObservation({ ...base, ...update }).contentHash).not.toBe(original.contentHash);
    }
    expect(prepareObservation({ ...base, sourceUrl: "https://example.com/distinct-document" }).sourceKey).not.toBe(original.sourceKey);
  });
  it("preserves original fetch truncation and discovery provenance independently of body clipping", () => {
    const prepared = prepareObservation({ ...base, metadata: { textTruncated: true, feedUrl: "https://feed.example/article" } });
    expect(prepared.metadata.textTruncated).toBe(true);
    expect(prepared.metadata.discovery).toMatchObject({ url: base.sourceUrl, title: base.title });
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
