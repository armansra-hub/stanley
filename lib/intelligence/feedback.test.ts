import { describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => {
  const chain = { select: m.select, eq: () => chain, order: () => chain, limit: async () => ({ data: [], error: null }) };
  m.select.mockReturnValue(chain);
  return chain;
} }) }));
import { feedbackExamples, loadFeedbackExamples } from "./feedback";

describe("evidence-linked normal feedback", () => {
  it("binds feedback evidence to its exact FK while preserving the response alias", async () => {
    await expect(loadFeedbackExamples("synthetic-company")).resolves.toEqual([]);
    expect(m.select).toHaveBeenCalledWith("reason,note,intelligence_observations:intelligence_observations!intelligence_feedback_observation_id_fkey!inner(title,evidence_text,attributes)");
  });
  it("keeps the original evidence separate from a correction, never converting the note into source text", () => {
    const result = feedbackExamples([{ reason: "wrong_company", note: "This describes the customer.", intelligence_observations: {
      title: "A customer expansion", evidence_text: "The customer opened three branches.", attributes: { evidenceExcerpt: "The customer opened three branches." },
    } }]);
    expect(result).toEqual([{ text: "A customer expansion\nThe customer opened three branches.", correction: "wrong_company: This describes the customer." }]);
  });
  it("rejects invented excerpts and bounds Unicode examples to the actual provider limits", () => {
    const rows = Array.from({ length: 5 }, () => ({ reason: "not_now" as const, note: "😀".repeat(300), intelligence_observations: {
      title: "History", evidence_text: "漢字".repeat(2000), attributes: { evidenceExcerpt: "invented" },
    } }));
    const result = feedbackExamples(rows);
    expect(result).toHaveLength(3);
    expect(result.every(row => Buffer.byteLength(row.text) <= 1000 && Buffer.byteLength(row.correction) <= 500)).toBe(true);
    expect(result[0].text).not.toContain("invented");
    expect(result[0].text).toContain("漢字");
  });
});
