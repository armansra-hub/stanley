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
    expect(paths.length).toBeLessThanOrEqual(DAILY_CHILD_REQUEST_LIMIT);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      const n = new URL(path, "https://local").searchParams.get("n");
      if (n != null) expect(Number(n)).toBeGreaterThan(0);
    }
  });

  it("preserves primary coverage while assigning real slots to overdue sources", () => {
    const paths = buildDailyWavePaths(0);
    expect(pathsFor(paths, "/api/cron/triggers")).toHaveLength(7);
    expect(pathsFor(paths, "/api/cron/fmcsa")).toHaveLength(4);
    expect(pathsFor(paths, "/api/cron/website")).toHaveLength(15);
    expect(paths.filter((path) => path.includes("scope=tail"))).toHaveLength(0);
    expect(pathsFor(paths, "/api/cron/cosos")).toHaveLength(1);
    expect(pathsFor(paths, "/api/cron/ats")).toHaveLength(15);
    expect(pathsFor(paths, "/api/cron/signals")).toHaveLength(0);
    expect(pathsFor(paths, "/api/cron/public-growth")).toHaveLength(19);
    expect(pathsFor(paths, "/api/cron/review-candidates")).toHaveLength(16);
    expect(paths).toContain("/api/cron/reconcile-hidden");

    const triggerCoverage = pathsFor(paths, "/api/cron/triggers")
      .reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
    // A 16-hour manifest repeats three times inside the promised 48-hour cycle.
    expect(triggerCoverage * 3).toBeGreaterThanOrEqual(6950);
    const eligibleCoverage = new Map([["/api/cron/fmcsa", 813], ["/api/cron/website", 6868], ["/api/cron/cosos", 365], ["/api/cron/ats", 6868]]);
    for (const pathname of ["/api/cron/fmcsa", "/api/cron/website", "/api/cron/cosos", "/api/cron/ats"]) {
      const coverage = pathsFor(paths, pathname)
        .reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
      expect(coverage * 2).toBeGreaterThanOrEqual(eligibleCoverage.get(pathname)!);
    }
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

  it("gives every recurring source a real 48-hour-or-faster cadence", () => {
    for (let day = 0; day < 5; day++) {
      const publicPaths = pathsFor(buildDailyWavePaths(day), "/api/cron/public-growth");
      const sources = publicPaths.map((path) => new URL(path, "https://local").searchParams.get("source"));
      expect(new Set(sources)).toEqual(new Set(["usaspending", "usaspending-subawards", "sam-opportunities", "revenue"]));
      expect(sources.filter((source) => source === "usaspending")).toHaveLength(16);
      expect(sources).toHaveLength(19);
    }
  });

  it("runs exactly one prime-award worker and one reviewer in every hourly stage", () => {
    const paths = buildDailyWavePaths(0);
    for (let offset = 0; offset < paths.length; offset += 5) {
      const stage = paths.slice(offset, offset + 5);
      const prime = stage.filter((path) => new URL(path, "https://local").searchParams.get("source") === "usaspending");
      expect(prime).toHaveLength(1);
      expect(stage[0]).toBe(prime[0]);
      expect(pathsFor(stage, "/api/cron/review-candidates")).toHaveLength(1);
      expect(stage[1]).toBe(pathsFor(stage, "/api/cron/review-candidates")[0]);
    }
  });

  it("uses source-specific bounded budgets against explicit recurring eligible sets", () => {
    for (const target of PUBLIC_GROWTH_RECURRING_COVERAGE) {
      const url = new URL(target.path, "https://local");
      expect(url.searchParams.get("scope")).toBe("verified");
      expect(Number(url.searchParams.get("n"))).toBe(target.batchSize);
      const rotations = Math.ceil(target.foundationEligibleBaseline / (target.batchSize * target.invocationsPerRotation));
      expect(rotations * target.rotationHours).toBeLessThanOrEqual(target.targetCycleHours);
      expect(target.targetCycleHours).toBeLessThanOrEqual(48);
    }
    expect(PUBLIC_GROWTH_RECURRING_COVERAGE.map((target) => String(target.source))).not.toContain("sam-entity");
  });
});
