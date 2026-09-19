import { describe, expect, it } from "vitest";
import { atsRevisitOutcome, nextRevisit, websiteChangeHistory } from "./adaptiveRevisit";

const now = new Date("2026-09-19T02:00:00Z");
describe("measured source revisit cadence", () => {
  it("backs off successful quiet scans up to one day and resets immediately on change", () => {
    let history = nextRevisit(null, "baseline", now);
    expect(history.intervalHours).toBe(1);
    expect([1, 2, 3, 4, 5].map(() => {
      history = nextRevisit(history, "quiet", now); return history.intervalHours;
    })).toEqual([2, 4, 8, 24, 24]);
    expect(nextRevisit(history, "changed", now)).toMatchObject({ quietRuns: 0, intervalHours: 1, nextDueAt: "2026-09-19T03:00:00.000Z", lastChangedAt: now.toISOString() });
    expect(nextRevisit(history, "incomplete", now)).toMatchObject({ quietRuns: 4, intervalHours: 1 });
  });

  it("compares website pages independently when the discovery batch rotates", () => {
    const first = websiteChangeHistory(null, [{ url: "https://acme.com/", contentHash: "home" }, { url: "https://acme.com/about", contentHash: "about" }]);
    expect(first.outcome).toBe("baseline");
    expect(websiteChangeHistory(first.hashes, [{ url: "https://acme.com/about", contentHash: "about" }]).outcome).toBe("quiet");
    expect(websiteChangeHistory(first.hashes, [{ url: "https://acme.com/about", contentHash: "new business model" }]).outcome).toBe("changed");
    expect(websiteChangeHistory(first.hashes, [{ url: "https://acme.com/news/new", contentHash: "new article" }]).outcome).toBe("changed");
  });

  it("bounds the website hash history without confusing a missing page with deletion", () => {
    const first = websiteChangeHistory(null, Array.from({ length: 220 }, (_, i) => ({ url: `https://acme.com/${i}`, contentHash: `hash${i}` })));
    expect(Object.keys(first.hashes)).toHaveLength(200);
    expect(websiteChangeHistory(first.hashes, []).outcome).toBe("quiet");
    // Caller must separately require complete successful capture before backoff.
    expect(nextRevisit(null, "incomplete", now).intervalHours).toBe(1);
  });

  it("uses complete ATS lifecycle results including expirations, never partial page silence", () => {
    const summary = { baseline: false, newJobs: 0, changedJobs: 0, reopenedJobs: 0, expiredJobs: 0 };
    expect(atsRevisitOutcome(true, summary)).toBe("quiet");
    expect(atsRevisitOutcome(true, { ...summary, expiredJobs: 1 })).toBe("changed");
    expect(atsRevisitOutcome(true, { ...summary, baseline: true })).toBe("baseline");
    expect(atsRevisitOutcome(false, summary)).toBe("incomplete");
    expect(atsRevisitOutcome(true)).toBe("incomplete");
    expect(atsRevisitOutcome(true, { ...summary, newJobs: Number.NaN })).toBe("incomplete");
  });
});
