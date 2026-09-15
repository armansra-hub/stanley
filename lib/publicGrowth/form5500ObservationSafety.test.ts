import { describe, expect, it } from "vitest";
import { form5500EvidenceForWrite, form5500ObservationExclusion } from "./form5500ObservationSafety";

describe("Form5500 observation safety", () => {
  it.each([null, "bad", [], {}, { active: "true" }, { active: 1 }])("excludes malformed present marker %j", (marker) => {
    expect(form5500ObservationExclusion("PA", { sponsor_state: "PA", evidence: { stanley_quarantine: marker } })).toBe("malformed_quarantine_marker");
  });
  it("keeps active quarantine excluded and allows an explicit reviewed reversal", () => {
    expect(form5500ObservationExclusion("PA", { evidence: { stanley_quarantine: { active: true } } })).toBe("active_quarantine");
    expect(form5500ObservationExclusion("PA", { evidence: { stanley_quarantine: { active: false } } })).toBeNull();
  });
  it("does not let reversal or source label bypass a state contradiction", () => {
    expect(form5500ObservationExclusion(" ca ", { sponsor_state: "PA", evidence: { stanley_quarantine: { active: false } } })).toBe("current_state_contradiction");
  });
  it("does not reject missing city or unknown state as false identity", () => {
    expect(form5500ObservationExclusion("PA", { sponsor_state: "PA", evidence: {} })).toBeNull();
    expect(form5500ObservationExclusion(null, { sponsor_state: "PA" })).toBeNull();
  });
  it("refuses malformed stored evidence", () => {
    expect(form5500ObservationExclusion("PA", { evidence: ["bad"] })).toBe("malformed_observation_evidence");
  });
  it("source input cannot create or replace reserved review metadata", () => {
    const marker = { active: false, history: ["a", "b"] };
    expect(form5500EvidenceForWrite({}, { source: 1, stanley_quarantine: marker })).toEqual({ source: 1 });
    const existing = { stanley_quarantine: marker };
    expect(form5500EvidenceForWrite(existing, { source: 2, stanley_quarantine: { active: true } })).toEqual({ source: 2, stanley_quarantine: marker });
    expect(existing).toEqual({ stanley_quarantine: marker });
  });
});
