import { expect, it } from "vitest";
import { evaluateEvidence } from "./jev";
import { OPERATING_CRITERIA } from "./profiles";

// Explicit opt-in only: the ordinary test suite never makes a paid request.
it.skipIf(process.env.STANLEY_JEV_LIVE !== "true")("accepts the production evidence contract through direct TypeSafe", async () => {
  process.loadEnvFile(".env.local");
  const text = "Synthetic fixture, not a real prospect: Example Manufacturing (example.com) announced it has opened a second manufacturing facility and operates two subsidiaries. It manages inventory in both facilities.";
  const result = await evaluateEvidence({ companyName: "Example Manufacturing", companyDomain: "example.com", text,
    sourceKind: "website", sourceUrl: "https://example.com/news/expansion", title: "Synthetic expansion fixture",
    sections: [{ id: "s1", text }], criteria: OPERATING_CRITERIA, privacy: "public" });
  expect(result.ok).toBe(true);
  expect(result.usage?.inputTokens).toBeGreaterThan(0);
  if (result.ok) {
    expect(Object.keys(result.criteria).sort()).toEqual(OPERATING_CRITERIA.map(criterion => criterion.id).sort());
    console.log(JSON.stringify({ directJevContract: true, model: result.model, usage: result.usage, checkedAt: new Date().toISOString() }));
  }
}, 25000);
