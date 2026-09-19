import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { buildStoryRequest, parseAccountStory, storyEvidenceHash, ACCOUNT_WRITER_REQUEST_BYTES, type StoryEvidence } from "./narratives";
const company = { id: "account", name: "Synthetic Services", domain: "example.test", subindustry: "Field services", ns_industry: null };
const row: StoryEvidence = { id: "one", company_id: company.id, content_hash: "one", is_current: true,
  source_url: "https://example.test/locations", title: "Operating locations", source_kind: "website", event_date: null,
  observed_at: "2026-09-18", evidence_text: "We operate Austin and Denver service centers.",
  attributes: { companyRelationship: "direct", companyRelevance: .9, signalType: "none",
    topicEvidence: [{ topic: "multi_location", probability: .95, start: 0, end: 44 }] } };
const good = { overview: [{ text: "The company lists two service centers.", citations: ["one"] }], developments: [],
  hypotheses: [{ text: "Coordination across service centers may require shared reporting; friction is unverified.", citations: ["one"] }],
  contradictions: [], unknowns: ["Current accounting system"] };
describe("sourced account story input", () => {
  it("pairs new developments with source-grounded footprint instead of assuming relative scale", () => {
    const baseline = { ...row, evidence_text: `${"Company introduction. ".repeat(80)}We operate two facilities with 85 employees.` };
    const event = { ...row, id: "event", source_url: "https://example.test/news/third-facility",
      evidence_text: "The company opened a third facility.", attributes: { ...row.attributes, signalType: "press", evidenceExcerpt: "The company opened a third facility." } };
    const result = buildStoryRequest(company, [event, baseline]);
    expect(result.sources.find(source => source.id === row.id)?.passages.join(" ")).toContain("two facilities with 85 employees");
    expect(result.system).toContain("Cite both the new development and the baseline");
    expect(result.system).toContain("acquisition-relative size remain explicitly unknown");
    expect(result.system).toContain("never rescore");
  });
  it("preserves supplied judgments and contextualizes source history without a review prompt", () => {
    const result = buildStoryRequest(company, [row, { ...row, id: "old", is_current: false, evidence_text: "We operate one Austin service center." }]);
    expect(result.sources.map(source => source.id)).toEqual(["one", "old"]);
    expect(result.sources[1].current).toBe(false);
    expect(result.system).toContain("never rescore");
    expect(result.system).toContain("Absence of a topic");
    expect(result.sources[0].jevSignalType).toBe("none");
  });
  it("bounds the complete request under its reserved generation allowance and exposes omitted evidence", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ ...row, id: String(index), source_url: `https://example.test/${index}`,
      evidence_text: "文".repeat(4000), title: "文".repeat(1000) }));
    const result = buildStoryRequest(company, rows);
    expect(Buffer.byteLength(result.system + result.user, "utf8") + 1000).toBeLessThanOrEqual(ACCOUNT_WRITER_REQUEST_BYTES);
    expect(result.coverage.requestLimited).toBe(true);
    expect(result.coverage.includedCurrent).toBeLessThan(result.coverage.availableCurrent);
    expect(result.sources.length).toBeGreaterThan(0);
  });
  it("keeps corrected and related-company sources out of direct account writing", () => {
    expect(buildStoryRequest(company, [{ ...row, feedback_excluded: true },
      { ...row, attributes: { ...row.attributes, companyRelationship: "related" } }]).sources).toEqual([]);
  });
  it("hashes materially changed sources and context while ignoring input order and raw score distributions", () => {
    const second = { ...row, id: "two" };
    expect(storyEvidenceHash(company, [row, second])).toBe(storyEvidenceHash(company, [second, row]));
    expect(storyEvidenceHash(company, [row])).not.toBe(storyEvidenceHash(company, [{ ...row, content_hash: "changed" }]));
    expect(storyEvidenceHash(company, [row])).not.toBe(storyEvidenceHash(company, [{ ...row, is_current: false }]));
    expect(storyEvidenceHash(company, [row])).toBe(storyEvidenceHash(company, [{ ...row,
      attributes: { ...row.attributes, rawAnswers: { random: { score: 2 } } } }]));
  });
});
describe("story syntax and citation integrity", () => {
  it("accepts sourced prose without judging its semantic conclusion", () => {
    expect(parseAccountStory(JSON.stringify(good), ["one"])).toEqual(good);
  });
  it("rejects an invented citation and refuses uncited narrative facts", () => {
    expect(parseAccountStory(JSON.stringify(good), ["different"])).toBeNull();
    expect(parseAccountStory(JSON.stringify({ ...good, overview: [{ text: "Claim", citations: [] }] }), ["one"])).toBeNull();
  });
  it("requires two distinct available source IDs to display a contradiction", () => {
    const claim = { topic: "Locations", description: "Earlier source lists Austin; later source says only Denver.", citations: ["one", "old"] };
    expect(parseAccountStory(JSON.stringify({ ...good, contradictions: [claim] }), ["one", "old"])).not.toBeNull();
    expect(parseAccountStory(JSON.stringify({ ...good, contradictions: [{ ...claim, citations: ["one", "one"] }] }), ["one"])).toBeNull();
  });
  it("rejects truncated or structurally incomplete writing", () => {
    expect(parseAccountStory('{"overview":', ["one"])).toBeNull();
    expect(parseAccountStory(JSON.stringify({ ...good, unknowns: undefined }), ["one"])).toBeNull();
  });
});
