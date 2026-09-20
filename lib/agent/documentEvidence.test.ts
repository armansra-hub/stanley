import { expect, it } from "vitest";
import { recordEvidenceText, recordEvidenceCapturedAt } from "./documentEvidence";
it("preserves exact full-record bytes while rejecting empty records", () => {
  expect(recordEvidenceText("  Full record\n" )).toBe("  Full record\n"); expect(recordEvidenceText(" \n ")).toBeNull();
});
it("preserves same-day timestamp ordering and still accepts legacy dates", () => {
  expect(recordEvidenceCapturedAt("2026-09-20T10:45:22-07:00")).toBe("2026-09-20T17:45:22.000Z");
  expect(recordEvidenceCapturedAt("2026-09-20")).toBe("2026-09-20"); expect(recordEvidenceCapturedAt(null)).toBeNull();
});
