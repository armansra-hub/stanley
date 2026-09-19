import { describe, expect, it } from "vitest";
import { isPublishableTrigger } from "@/lib/db/triggers";

describe("trigger evidence visibility", () => {
  it("honors an explicit reversible correction without treating a missing marker as dismissal", () => {
    const finding = { type: "press", source_url: "https://example.com/news/new-location" };
    expect(isPublishableTrigger({ ...finding, metadata: { intelligenceFeedbackExcluded: true } })).toBe(false);
    expect(isPublishableTrigger({ ...finding, metadata: { intelligenceFeedbackExcluded: false } })).toBe(true);
  });
  it("quarantines fabricated homepage-anchor growth signals", () => {
    expect(isPublishableTrigger({ type: "ma", source_url: "https://example.com/#acquisition%20(they%20made)" })).toBe(false);
    expect(isPublishableTrigger({ type: "press", source_url: "https://example.com/#new%20location" })).toBe(false);
  });

  it("keeps M&A signals backed by real articles", () => {
    expect(isPublishableTrigger({ type: "ma", source_url: "https://example.com/news/acme-acquires-target" })).toBe(true);
    expect(isPublishableTrigger({ type: "federal_award", source_url: "https://www.usaspending.gov/award/ABC" })).toBe(true);
  });
});
