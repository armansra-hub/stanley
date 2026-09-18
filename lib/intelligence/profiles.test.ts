import { describe, expect, it } from "vitest";
import { buildOperatingProfile, type ProfileObservation } from "./profiles";
const row: ProfileObservation = { id: "1", source_url: "https://example.com/news/integration", title: "Company integration", source_kind: "website", event_date: "2020-01-01", observed_at: "2026-09-18", evidence_text: "Integration across two subsidiaries.", attributes: { companyRelationship: "direct", companyRelevance: .95, concreteEvent: .9, topicEvidence: [{ topic: "acquisition_integration", probability: .9, start: 0, end: 35 }, { topic: "multi_entity", probability: .9, start: 0, end: 35 }] } };
describe("operating profiles", () => {
  it("links compound hypotheses to supported topics without upgrading them into facts", () => {
    const result = buildOperatingProfile([row]);
    expect(result.hypotheses[0].status).toBe("unverified");
    expect(result.developments[0].historical).toBe(true);
    expect(result.unknowns).toContain("Systems change");
  });
  it("does not treat related-company evidence or invalid source spans as direct facts", () => {
    expect(buildOperatingProfile([{ ...row, attributes: { ...row.attributes, companyRelationship: "related" } }]).hypotheses).toHaveLength(0);
    expect(buildOperatingProfile([{ ...row, evidence_text: "short" }]).hypotheses).toHaveLength(0);
  });
  it("does not count the same URL twice as corroboration", () => {
    expect(buildOperatingProfile([row, { ...row, id: "2" }]).topics[0].sources).toHaveLength(1);
  });
});
