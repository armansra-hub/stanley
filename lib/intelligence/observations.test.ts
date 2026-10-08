import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { canonicalEvidenceUrl, evidenceSections, prepareObservation } from "./observations";
import { jevCost, secondsUntilNextMonth } from "./budget";
import { workerEvidenceInput } from "./worker";

const base = { companyId: "11111111-1111-4111-8111-111111111111", companyName: "Example Services", sourceKind: "website" as const,
  sourceUrl: "https://example.com/news?utm_source=feed&article=2#main", title: "Operating update", text: "A sourced public update." };
afterEach(() => vi.unstubAllEnvs());
describe("durable observation identity", () => {
  it("retains bounded government JSON verbatim and partitions exact POST requests", () => {
    const text = JSON.stringify({ description: "two  spaces\n\n\nremain", unknownProviderField: "😀".repeat(20_000) });
    const input = { ...base, sourceKind: "government" as const, text, governmentJsonCapture: { requestSha256: "a".repeat(64) } };
    const capture = prepareObservation(input);
    expect(capture.text).toBe(text);
    expect(capture.sections.map(section => section.text).join("")).toBe(text);
    expect(capture.metadata).toMatchObject({ textTruncated: false, sourceRepresentation: "retained_parsed_json", originalHttpBytesRetained: false });
    expect(capture.sourceKey).not.toBe(prepareObservation({ ...input, governmentJsonCapture: { requestSha256: "b".repeat(64) } }).sourceKey);
    expect(capture.url).toBe(prepareObservation(base).url);
  });
  it.each(["oversize", "db-character-bound", "wrong-kind", "invalid-json", "array", "wrong-hash"])("fails closed for unsafe government capture: %s", kind => {
    const input = { ...base, sourceKind: "government" as const, text: "{}", governmentJsonCapture: { requestSha256: "a".repeat(64) } };
    if (kind === "oversize") input.text = JSON.stringify({ text: "😀".repeat(70_000) });
    if (kind === "db-character-bound") input.text = JSON.stringify({ text: "x".repeat(60_000) });
    if (kind === "wrong-kind") Object.assign(input, { sourceKind: "news" });
    if (kind === "invalid-json") input.text = "not JSON";
    if (kind === "array") input.text = "[]";
    if (kind === "wrong-hash") input.governmentJsonCapture.requestSha256 = "bad";
    expect(() => prepareObservation(input)).toThrow();
  });
  it("matches the real observation SQL length constraint at ASCII and Unicode boundaries", async () => {
    const { PGlite } = createRequire(new URL("../../work/intelligence-sql-test/package.json", import.meta.url))("@electric-sql/pglite");
    const db = await PGlite.create("memory://");
    try {
      const migration = await readFile(new URL("../../supabase/migrations/0059_intelligence_evidence_and_work.sql", import.meta.url), "utf8");
      const column = migration.match(/^\s*(evidence_text text not null check \(length\(evidence_text\) between 1 and 48000\)),?$/m)?.[1];
      expect(column).toBeTruthy();
      await db.exec(`create table capture_boundary (${column})`);
      const input = { ...base, sourceKind: "government" as const, governmentJsonCapture: { requestSha256: "a".repeat(64) } };
      for (const char of ["a", "😀"]) {
        const text = JSON.stringify({ text: char.repeat(48_000 - JSON.stringify({ text: "" }).length) });
        const prepared = prepareObservation({ ...input, text });
        expect((await db.query("insert into capture_boundary(evidence_text) values ($1) returning length(evidence_text) as length", [prepared.text])).rows[0].length).toBe(48_000);
        const over = JSON.stringify({ text: char.repeat(48_001 - JSON.stringify({ text: "" }).length) });
        expect(() => prepareObservation({ ...input, text: over })).toThrow();
        await expect(db.query("insert into capture_boundary(evidence_text) values ($1)", [over])).rejects.toThrow();
      }
    } finally { await db.close(); }
  });
  it.each(["Management Consulting", "Operational Support Services", "Media & Publishing", null])("describes the actual worker's ordinary questions for %s without changing document identity", subindustry => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-1.13.0");
    const prepared = prepareObservation({ ...base, companySubindustry: subindustry });
    const worker = workerEvidenceInput({ evidence_text: prepared.text, source_kind: base.sourceKind, source_url: prepared.url,
      title: base.title, event_date: prepared.eventDate, observed_at: prepared.observedAt, metadata: prepared.metadata },
    { name: base.companyName, subindustry }, { start: 0, end: prepared.text.length, text: prepared.text }, null, []);
    expect(prepared.metadata.researchCriteria).toEqual(worker.criteria?.map(criterion => criterion.id));
    expect(prepared.metadata.researchCriteria).toHaveLength(10);
    expect(prepared.metadata.researchCriteriaSubindustry).toBe(subindustry);
    expect(prepared.metadata.researchCriteriaModel).toBe("jev-1.13.0");
    expect(prepared.contentHash).toBe(prepareObservation(base).contentHash);
  });
  it("does not guess an absent subindustry or replace directed criteria without exact company context", () => {
    expect(prepareObservation(base).metadata).not.toHaveProperty("researchCriteriaBasis");
    const metadata = { researchTopics: ["government_work"], researchCriteria: ["project_delivery", "multi_entity", "multi_location", "government_work"] };
    expect(prepareObservation({ ...base, metadata }).metadata.researchCriteria).toEqual(metadata.researchCriteria);
    const directed = prepareObservation({ ...base, metadata, companySubindustry: "Management Consulting" });
    expect(directed.metadata.researchCriteria).toContain("government_work");
    expect(directed.metadata.researchCriteria).toHaveLength(10);
  });
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
