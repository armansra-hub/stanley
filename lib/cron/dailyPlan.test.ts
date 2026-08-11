import { describe, expect, it } from "vitest";
import {
  buildDailyWavePaths,
  DAILY_CHILD_REQUEST_LIMIT,
  DAILY_PLANNED_CHILDREN,
  isGetCompatibleDailyPath,
  PUBLIC_GROWTH_RECURRING_COVERAGE,
} from "./dailyPlan";

function pathsFor(paths: string[], pathname: string) {
  return paths.filter((path) => new URL(path, "https://local").pathname === pathname);
}

describe("daily cron plan", () => {
  it("stays below the legacy ceiling with no duplicate or empty work slots", () => {
    const paths = buildDailyWavePaths(0);
    expect(paths).toHaveLength(DAILY_PLANNED_CHILDREN);
    expect(paths.length).toBeLessThan(DAILY_CHILD_REQUEST_LIMIT);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      const n = new URL(path, "https://local").searchParams.get("n");
      if (n != null) expect(Number(n)).toBeGreaterThan(0);
    }
  });

  it("preserves primary coverage while assigning real slots to overdue sources", () => {
    const paths = buildDailyWavePaths(0);
    expect(pathsFor(paths, "/api/cron/triggers")).toHaveLength(20);
    expect(pathsFor(paths, "/api/cron/fmcsa")).toHaveLength(3);
    expect(pathsFor(paths, "/api/cron/website")).toHaveLength(17);
    expect(paths.filter((path) => path.includes("scope=tail"))).toHaveLength(4);
    expect(pathsFor(paths, "/api/cron/ats")).toHaveLength(1);
    expect(pathsFor(paths, "/api/cron/signals")).toHaveLength(0);
    expect(pathsFor(paths, "/api/cron/public-growth")).toHaveLength(5);
    expect(paths).toContain("/api/cron/reconcile-hidden");

    const triggerCoverage = pathsFor(paths, "/api/cron/triggers")
      .reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
    expect(triggerCoverage).toBe(5000);
    for (const pathname of ["/api/cron/triggers", "/api/cron/fmcsa", "/api/cron/website", "/api/cron/cosos", "/api/cron/ats"]) {
      const waves = pathsFor(paths, pathname);
      expect(waves.every((path) => !new URL(path, "https://local").searchParams.has("offset"))).toBe(true);
      expect(new Set(waves.map((path) => {
        const params = new URL(path, "https://local").searchParams;
        return `${params.get("scope") ?? "default"}:${params.get("wave")}`;
      })).size).toBe(waves.length);
    }
  });

  it("uses only authenticated GET-compatible routes", () => {
    const paths = buildDailyWavePaths(0);
    expect(paths.every(isGetCompatibleDailyPath)).toBe(true);
    expect(paths.some((path) => path.includes("/form5500"))).toBe(false);
    expect(paths.some((path) => path.includes("/sam-extract"))).toBe(false);
    expect(paths.some((path) => path.includes("/sba-loans"))).toBe(false);
  });

  it("advances every public-growth source exactly once each day", () => {
    for (let day = 0; day < 5; day++) {
      const publicPaths = pathsFor(buildDailyWavePaths(day), "/api/cron/public-growth");
      const sources = publicPaths.map((path) => new URL(path, "https://local").searchParams.get("source"));
      expect(new Set(sources)).toEqual(new Set([
        "usaspending",
        "usaspending-subawards",
        "sam-entity",
        "sam-opportunities",
        "revenue",
      ]));
      expect(sources).toHaveLength(5);
    }
  });

  it("uses source-specific bounded budgets against explicit recurring eligible sets", () => {
    for (const target of PUBLIC_GROWTH_RECURRING_COVERAGE) {
      const url = new URL(target.path, "https://local");
      expect(url.searchParams.get("scope")).toBe("verified");
      expect(Number(url.searchParams.get("n"))).toBe(target.batchSize);
      expect(Math.ceil(target.foundationEligibleBaseline / target.batchSize)).toBe(target.targetCycleDays);
    }
    expect(PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "usaspending")?.targetCycleDays)
      .toBe(250);
    expect(PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "sam-entity")?.targetCycleDays)
      .toBeLessThanOrEqual(366);
  });
});
