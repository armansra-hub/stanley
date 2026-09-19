import { describe, expect, it } from "vitest";
import {
  buildDailyWavePaths,
  DAILY_CHILD_REQUEST_LIMIT,
  DAILY_PLANNED_CHILDREN,
  DAILY_STAGE_SIZE,
  isGetCompatibleDailyPath,
  PUBLIC_GROWTH_RECURRING_COVERAGE,
  SAM_ENTITY_RECURRING_REFRESH,
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
    expect(pathsFor(paths, "/api/cron/triggers")).toHaveLength(6);
    expect(pathsFor(paths, "/api/cron/fmcsa")).toHaveLength(4);
    expect(pathsFor(paths, "/api/cron/website")).toHaveLength(12);
    expect(paths.filter((path) => path.includes("scope=tail"))).toHaveLength(0);
    expect(pathsFor(paths, "/api/cron/cosos")).toHaveLength(1);
    expect(pathsFor(paths, "/api/cron/ats")).toHaveLength(12);
    expect(pathsFor(paths, "/api/cron/signals")).toHaveLength(0);
    expect(pathsFor(paths, "/api/cron/public-growth")).toHaveLength(27);
    expect(pathsFor(paths, "/api/cron/review-candidates")).toHaveLength(15);
    expect(paths).toContain("/api/cron/reconcile-hidden");

    const triggerCoverage = pathsFor(paths, "/api/cron/triggers")
      .reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
    // A 16-hour manifest repeats three times inside the promised 48-hour cycle.
    // Preserve at least one whole missed wave's capacity at the refreshed TAM.
    expect(triggerCoverage * 3 - 500).toBeGreaterThanOrEqual(7441);
    const eligibleCoverage = new Map([["/api/cron/fmcsa", 889], ["/api/cron/website", 7441], ["/api/cron/cosos", 384], ["/api/cron/ats", 7441]]);
    for (const pathname of ["/api/cron/fmcsa", "/api/cron/website", "/api/cron/cosos", "/api/cron/ats"]) {
      const coverage = pathsFor(paths, pathname)
        .reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
      const largestWave = Math.max(...pathsFor(paths, pathname).map((path) => Number(new URL(path, "https://local").searchParams.get("n"))));
      expect(coverage * 3 - largestWave).toBeGreaterThanOrEqual(eligibleCoverage.get(pathname)!);
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

  it("finishes the 7,441-row revenue cursor in two calls with one missed call in 48 hours", () => {
    const paths = buildDailyWavePaths().map((path) => new URL(path, "https://local"));
    const revenue = paths.filter((url) => url.searchParams.get("source") === "revenue");
    expect(revenue).toHaveLength(1);
    const limit = Number(revenue[0].searchParams.get("limit"));
    // Revenue wraps only on the next invocation after its tail page. Sum-of-n
    // arithmetic would overstate capacity if the page still capped at 3,500.
    expect(Math.ceil(7441 / limit)).toBeLessThanOrEqual(revenue.length * 3 - 1);
    expect(limit).toBeLessThanOrEqual(4000);
  });

  it("preserves all recurring source routes without treating scheduled capacity as completion", () => {
    for (let day = 0; day < 5; day++) {
      const publicPaths = pathsFor(buildDailyWavePaths(day), "/api/cron/public-growth");
      const sources = publicPaths.map((path) => new URL(path, "https://local").searchParams.get("source"));
      expect(new Set(sources)).toEqual(new Set(["usaspending", "usaspending-subawards", "sam-entity", "sam-opportunities", "revenue"]));
      expect(sources.filter((source) => source === "usaspending")).toHaveLength(16);
      expect(sources.filter((source) => source === "usaspending-subawards")).toHaveLength(8);
      expect(sources).toHaveLength(27);
    }
  });

  it("spaces eight subaward waves exactly two hours apart across the rotation boundary", () => {
    const paths = buildDailyWavePaths();
    const stages: number[] = [], waves: number[] = [];
    expect(DAILY_STAGE_SIZE).toBe(5);
    expect(paths).toHaveLength(80);
    for (let offset = 0; offset < paths.length; offset += DAILY_STAGE_SIZE) {
      const stage = paths.slice(offset, offset + DAILY_STAGE_SIZE);
      expect(stage).toHaveLength(5);
      const subawards = stage.map((path) => new URL(path, "https://local"))
        .filter((url) => url.searchParams.get("source") === "usaspending-subawards");
      expect(subawards.length).toBeLessThanOrEqual(1);
      if (subawards.length) {
        stages.push(offset / DAILY_STAGE_SIZE);
        waves.push(Number(subawards[0].searchParams.get("wave")));
        expect(subawards[0].searchParams.get("scope")).toBe("verified");
        expect(subawards[0].searchParams.has("offset")).toBe(false);
      }
    }
    expect(stages).toHaveLength(8);
    expect(new Set(waves).size).toBe(8);
    for (let i = 0; i < stages.length; i++) {
      expect((stages[(i + 1) % stages.length] - stages[i] + 16) % 16).toBe(2);
    }
    const coverage = PUBLIC_GROWTH_RECURRING_COVERAGE.find((source) => source.source === "usaspending-subawards")!;
    expect(coverage.invocationsPerRotation).toBe(stages.length);
    expect(coverage.rotationHours).toBe(16);
  });

  it("preserves unrelated source and maintenance allocations", () => {
    const paths = buildDailyWavePaths();
    for (const pathname of ["/api/cron/tal-news", "/api/cron/cosos", "/api/cron/reconcile-hidden", "/api/cron/recompute"]) {
      expect(pathsFor(paths, pathname)).toHaveLength(1);
    }
    expect(pathsFor(paths, "/api/cron/fmcsa")).toHaveLength(4);
    for (const source of ["revenue", "sam-opportunities"]) {
      expect(paths.filter((path) => new URL(path, "https://local").searchParams.get("source") === source)).toHaveLength(1);
    }
    for (const pathname of ["/api/cron/triggers", "/api/cron/website", "/api/cron/ats"]) {
      const plannedChecks = pathsFor(paths, pathname).reduce((sum, path) => sum + Number(new URL(path, "https://local").searchParams.get("n")), 0);
      expect(plannedChecks * 3).toBe(9000);
    }
  });

  it("preserves hourly prime awards and 15 reviewer slots around the SAM refresh", () => {
    const paths = buildDailyWavePaths(0);
    for (let offset = 0; offset < paths.length; offset += 5) {
      const stage = paths.slice(offset, offset + 5);
      const prime = stage.filter((path) => new URL(path, "https://local").searchParams.get("source") === "usaspending");
      expect(prime).toHaveLength(1);
      expect(stage[0]).toBe(prime[0]);
      const samStage = offset / DAILY_STAGE_SIZE === SAM_ENTITY_RECURRING_REFRESH.stage;
      expect(pathsFor(stage, "/api/cron/review-candidates")).toHaveLength(samStage ? 0 : 1);
      expect(stage[1]).toBe(samStage
        ? SAM_ENTITY_RECURRING_REFRESH.path
        : pathsFor(stage, "/api/cron/review-candidates")[0]);
    }
  });

  it("bounds supplemental SAM calls while resuming the managed verified-source cursor", () => {
    const paths = buildDailyWavePaths();
    const sam = paths.map((path) => new URL(path, "https://local"))
      .filter((url) => url.searchParams.get("source") === "sam-entity");
    expect(sam).toHaveLength(1);
    expect(sam[0].searchParams.get("scope")).toBe("verified");
    expect(sam[0].searchParams.get("n")).toBe("1");
    expect(sam[0].searchParams.has("offset")).toBe(false);
    expect(sam[0].searchParams.has("companyId")).toBe(false);
    expect(SAM_ENTITY_RECURRING_REFRESH.rotationHours).toBe(paths.length / DAILY_STAGE_SIZE);
    // One page per selected company; no same-invocation main + retry double run.
    const maximumDailyEntityRequests = Math.ceil(24 / SAM_ENTITY_RECURRING_REFRESH.rotationHours)
      * sam.length * SAM_ENTITY_RECURRING_REFRESH.batchSize;
    expect(maximumDailyEntityRequests).toBe(2);
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
