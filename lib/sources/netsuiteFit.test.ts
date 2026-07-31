import { describe, expect, it } from "vitest";
import { NETSUITE_FIT_RUBRIC, rubricFor } from "./netsuiteFit";

/** This module is REFERENCE DATA for a reading agent's prompt, not a matcher — see
 * the file header. These tests check the data is well-formed and scoping resolves
 * correctly; they do not test text extraction, because there is none here. */
describe("NETSUITE_FIT_RUBRIC", () => {
  it("every tell has a label, capability, confidence and at least one example phrasing", () => {
    for (const t of NETSUITE_FIT_RUBRIC) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.capability.length).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(t.confidence);
      expect(t.examplePhrasings.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate labels", () => {
    const labels = NETSUITE_FIT_RUBRIC.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("rubricFor", () => {
  it("includes cross-cutting tells for any subindustry", () => {
    const labels = rubricFor("Freight & Logistics").map((t) => t.label);
    expect(labels).toContain("multi-entity / multi-subsidiary");
  });

  it("includes subindustry-scoped tells only for their vertical", () => {
    expect(rubricFor("Staffing").map((t) => t.label)).toContain("pay/bill margin tracking");
    expect(rubricFor("Architecture, Engineering & Design").map((t) => t.label)).not.toContain("pay/bill margin tracking");
  });

  it("excludes all scoped tells when subindustry is unknown", () => {
    const scoped = rubricFor(undefined);
    expect(scoped.every((t) => !t.subindustries)).toBe(true);
  });
});
