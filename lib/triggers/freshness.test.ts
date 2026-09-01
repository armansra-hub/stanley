import { describe, expect, it } from "vitest";
import { triggerIsAfterReviewBoundary } from "./freshness";

describe("triggerIsAfterReviewBoundary", () => {
  const boundary = "2026-08-20T12:00:00.000Z";

  it("keeps all evidence for a company that has never been reviewed", () => {
    expect(triggerIsAfterReviewBoundary({ signal_date: "2020-01-01", detected_at: "2026-09-01" }, null)).toBe(true);
  });

  it("keeps only events that happened and were detected after the review", () => {
    expect(triggerIsAfterReviewBoundary({ signal_date: "2026-08-21", detected_at: "2026-08-22" }, boundary)).toBe(true);
    expect(triggerIsAfterReviewBoundary({ signal_date: "2026-08-19", detected_at: "2026-08-22" }, boundary)).toBe(false);
    expect(triggerIsAfterReviewBoundary({ signal_date: "2026-08-21", detected_at: "2026-08-19" }, boundary)).toBe(false);
  });

  it("fails closed when post-review evidence has no real event date", () => {
    expect(triggerIsAfterReviewBoundary({ signal_date: null, detected_at: "2026-08-22" }, boundary)).toBe(false);
  });
});
