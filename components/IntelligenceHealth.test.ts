import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import IntelligenceHealth, { type IntelligenceHealthData } from "./IntelligenceHealth";
const fixture = (): IntelligenceHealthData => ({
  asOf: "2026-09-19T03:00:00Z", scope: "eligible_tam", spendScope: "global",
  queue: { due: 8, deferred: 2, running: 1, failed: 0, oldestDueAt: "2026-09-19T02:58:00Z", expiredLeases: 0, completedLastHour: 44, completedLast24h: 90 },
  work: { stories: { queued: 1, running: 2, failed: 0 }, research: { queued: 4, running: 0, failed: 1 } },
  freshness: { capturedLast24h: 60, interpretedLast24h: 50, medianCaptureToInterpretSeconds: 1080, p95CaptureToInterpretSeconds: 3600,
    lastCapturedAt: "2026-09-19T02:59:00Z", lastInterpretedAt: "2026-09-19T02:59:20Z",
    latestCohort: { start: "2026-09-19T02:00:00Z", end: "2026-09-19T03:00:00Z", captured: 10, interpreted: 3, pending: 7, medianSeconds: 20, p95Seconds: 30 } },
  coverage: { tamAccounts: 100, accountsWithEvidence: 20, accountsFirstCapturedLastHour: 3, accountsFirstCapturedLast24h: 9, sourceChangedLastHour: 7, accountsInterpreted: 12, accountsWithTopics: 8, accountsWithStoredStory: 3, accountsWithHiringBaseline: 2, websiteSuccess48h: 10, atsSuccess48h: 5 },
  yield: { allTriggersLast24h: 33, allTriggeredAccountsLast24h: 21, jevTriggersLast24h: 0, distinctTriggeredAccountsLast24h: 0, usefulFeedbackLast24h: 2, medianCaptureToCardSeconds: null, modelCostLast24h: .25 },
});
function render(health: IntelligenceHealthData) {
  // The app uses the automatic JSX runtime; Vitest's minimal transform is classic.
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(IntelligenceHealth, { health })).replace(/<[^>]*>/g, "");
}
afterEach(() => vi.unstubAllGlobals());
describe("intelligence metric scope and timing presentation", () => {
  it("distinguishes all cards, Jev-bearing cards, account coverage and source/job counts", () => {
    const text = render(fixture());
    expect(text).toContain("21 accounts with trigger cards");
    expect(text).toContain("33 cards across all sources");
    expect(text).toContain("0 cards with Jev output across 0 accounts");
    expect(text).toContain("12 / 100");
    expect(text).toContain("at least one interpreted source");
    expect(text).toContain("44 completed / last hour");
    expect(text).toContain("Research depth varies by account");
    expect(text).toContain("First evidence captured for 3 accounts in the last hour / 9 in 24 hr");
    expect(text).toContain("7 previously seen account sources changed");
  });
  it("shows latest-cohort speed alongside pending work without treating rolling latency as a promise", () => {
    const text = render(fixture());
    expect(text).toContain("Newest capture cohort20 sec");
    expect(text).toContain("3 of 10 sources interpreted · 7 pending");
    expect(text).toContain("24 hr completed median: 18 min");
    expect(text).toContain("not an estimate for pending work");
  });
  it("does not render zero timing when the entire newest cohort is pending", () => {
    const health = fixture();
    health.freshness.latestCohort = { ...health.freshness.latestCohort!, interpreted: 0, pending: 10, medianSeconds: null, p95Seconds: null };
    const text = render(health);
    expect(text).toContain("Newest capture cohortNot measured yet");
    expect(text).toContain("0 of 10 sources interpreted · 10 pending");
  });
});
