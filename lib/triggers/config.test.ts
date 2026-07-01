import { describe, it, expect } from "vitest";
import { classifyHeadline, decayFactor, TRIGGER_SPEC } from "./config";

describe("classifyHeadline", () => {
  it("funding", () => {
    expect(classifyHeadline("Acme raises $12M Series B")).toBe("funding");
    expect(classifyHeadline("Startup secures $3 million in seed round")).toBe("funding");
  });
  it("M&A", () => {
    expect(classifyHeadline("BigCo acquires Acme Logistics")).toBe("ma");
    expect(classifyHeadline("Two staffing firms to merge")).toBe("ma");
  });
  it("finance hire", () => {
    expect(classifyHeadline("Acme names new CFO")).toBe("finance_hire");
    expect(classifyHeadline("Company hires Controller to lead finance")).toBe("finance_hire");
  });
  it("expansion → press", () => {
    expect(classifyHeadline("Acme expands with new office in Dallas")).toBe("press");
  });
  it("falls back to news", () => {
    expect(classifyHeadline("Acme wins regional service award")).toBe("news");
  });
});

describe("decayFactor", () => {
  const now = new Date("2026-07-01T00:00:00Z").getTime();
  it("≈1 at the event, ≈0.5 at one half-life", () => {
    expect(decayFactor("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z", 30, now)).toBeCloseTo(1, 2);
    expect(decayFactor("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z", 30, now)).toBeCloseTo(0.5, 1); // ~30 days
  });
  it("funding decays slower than news (longer half-life)", () => {
    const f = decayFactor("2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z", TRIGGER_SPEC.funding.half_life_days, now);
    const n = decayFactor("2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z", TRIGGER_SPEC.news.half_life_days, now);
    expect(f).toBeGreaterThan(n);
  });
});
