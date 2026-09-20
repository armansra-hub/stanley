import { describe, expect, it } from "vitest";
import { researchCandidates } from "./research";
const now = Date.parse("2026-09-18T12:00:00Z");

describe("directed research rotation", () => {
  it("moves beyond recently completed sources and prioritizes unattempted verified alternatives", () => {
    const result = researchCandidates(["recent", "old", "new", "new"], [
      { source_url: "recent", next_attempt_at: "2026-09-25", last_attempt_at: "2026-09-18" },
      { source_url: "old", next_attempt_at: "2026-09-17", last_attempt_at: "2026-09-10" },
    ], url => url === "old" ? 10 : 1, now);
    expect(result).toEqual(["new", "old"]);
  });
  it("does not invent URLs from attempt history and bounds the candidate packet", () => {
    expect(researchCandidates([], [{ source_url: "https://unverified.test/", next_attempt_at: "2026-09-01", last_attempt_at: null }], () => 1, now)).toEqual([]);
    expect(researchCandidates(Array.from({ length: 150 }, (_, i) => `https://example.test/${i}`), [], () => 1, now)).toHaveLength(100);
  });
  it("does not rank another refresh's leased pages and makes them available at lease expiry", () => {
    const attempts = [
      { source_url: "leased", next_attempt_at: "2026-09-18T11:00:00Z", last_attempt_at: "2026-09-18T11:59:00Z", lease_until: "2026-09-18T12:02:00Z" },
      { source_url: "expired", next_attempt_at: "2026-09-18T11:00:00Z", last_attempt_at: "2026-09-18T11:00:00Z", lease_until: "2026-09-18T12:00:00Z" },
    ];
    expect(researchCandidates(["leased", "expired", "new"], attempts, () => 1, now)).toEqual(["new", "expired"]);
    expect(researchCandidates(["leased", "expired", "new"], attempts, () => 1, now + 120_000)).toEqual(["new", "expired", "leased"]);
  });
});
