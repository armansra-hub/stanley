import { describe, expect, it } from "vitest";
import { buildDailyWavePaths, DAILY_CHILD_REQUEST_LIMIT } from "./dailyPlan";

describe("daily cron plan", () => {
  it("is unique, finite, and preserves the configured coverage volumes", () => {
    const paths = buildDailyWavePaths();
    expect(paths).toHaveLength(DAILY_CHILD_REQUEST_LIMIT);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p.startsWith("/api/cron/triggers?"))).toHaveLength(20);
    expect(paths.filter((p) => p.startsWith("/api/cron/website?"))).toHaveLength(36);
    expect(paths).not.toContain("/api/cron/apify-schedule");

    const triggerCoverage = paths
      .filter((p) => p.startsWith("/api/cron/triggers?"))
      .reduce((sum, p) => sum + Number(new URL(p, "https://local").searchParams.get("n")), 0);
    expect(triggerCoverage).toBe(5000);
  });
});
