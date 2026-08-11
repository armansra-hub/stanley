import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_ARTIFACT_RULES,
  SCORE_KNOWN_HISTORY,
  SCORE_STORAGE_RULES,
} from "./scoreContract";

describe("agent API score contract", () => {
  const publicContract = [
    ...SCORE_STORAGE_RULES,
    ...ASSESSMENT_ARTIFACT_RULES,
    ...SCORE_KNOWN_HISTORY,
  ].join("\n");

  it("states the raw-grade equality and hard-zero invariant", () => {
    expect(publicContract).toContain("tam_score equals codex_score");
    expect(publicContract).toContain("record_dead");
    expect(publicContract).toContain("NetSuite incumbents");
  });

  it("keeps outside signals in Triggered instead of TAM or Old Gold", () => {
    expect(publicContract).toContain("signals never change codex_score, tam_score, or oldgold_score");
    expect(publicContract).toContain("rank only Triggered");
    expect(publicContract).not.toMatch(/(?:capped|adjust(?:ment|ed)?)\s*(?:at\s*)?[+-]?15/i);
    expect(publicContract).not.toContain(["codex", "rescore"].join("_"));
  });

  it("documents the assessment-artifact/live-storage Old Gold split", () => {
    expect(publicContract).toContain("old_gold_score of 0 remains 0 in the assessment artifact");
    expect(publicContract).toContain("companies.oldgold_score is intentionally null");
    for (const field of ["old_gold_class", "intro_call_exists", "opportunity_exists"]) {
      expect(publicContract).toContain(field);
    }
  });
});
