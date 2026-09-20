import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bindRelatedFederalEntities, federalRelationshipWitness, federalCoverage, federalAwardLabel } from "./federalPresentation";
import FederalIdentityContext from "@/components/FederalIdentityContext";

const direct = { id: "direct", legal_name: "Direct Co", match_status: "verified", uei: "ABCDEFGHIJKL", parent_uei: "ZYXWVUTSRQPO",
  source: "SAM.gov", source_url: "https://sam.gov/entity/ABCDEFGHIJKL/coreData", observed_at: "2026-09-18T00:00:00Z" };
describe("federal activity provenance and coverage display", () => {
  it("requires a source-backed exact parent UEI and never infers a relationship from a name", () => {
    expect(federalRelationshipWitness(direct)).toMatchObject({ reportingUei: direct.uei, reportedParentUei: direct.parent_uei });
    for (const patch of [{ parent_uei: null, parent_name: "Parent Co" }, { source_url: "https://sam.gov.example.com/fake" },
      { source: "CRM name guess" }, { observed_at: null }, { parent_uei: direct.uei }]) {
      expect(federalRelationshipWitness({ ...direct, ...patch })).toBeNull();
    }
    expect(bindRelatedFederalEntities([{ ...direct, match_status: "pending" }], [{ id: "parent", uei: direct.parent_uei }])).toEqual([]);
    expect(bindRelatedFederalEntities([direct], [{ id: "name", legal_name: "Parent Co", uei: "ZZZZZZZZZZZZ" }])).toEqual([]);
    expect(bindRelatedFederalEntities([direct], [{ ...direct, id: "cycle", uei: direct.parent_uei, parent_uei: direct.uei }])).toEqual([]);
  });
  it("binds both parent and child context without duplicating direct legal entities", () => {
    const parent = { id: "parent", uei: direct.parent_uei };
    const child = { ...direct, id: "child", uei: "ZZZZZZZZZZZZ", parent_uei: direct.uei };
    const result = bindRelatedFederalEntities([direct], [parent, child, direct, parent]);
    expect(result.map((row) => row.entity.id)).toEqual(["parent", "child"]);
    expect(result[0].relationships[0].relationship).toBe("reported_parent");
    expect(result[1].relationships[0].relationship).toBe("reported_child");
  });
  it("labels IDVs and order references while distinguishing the collected source scope from exhaustive coverage", () => {
    expect(federalAwardLabel("IDV_B")).toBe("Contract vehicle (IDV)");
    expect(federalAwardLabel("Blanket Purchase Agreement")).toBe("Contract vehicle (IDV)");
    expect(federalAwardLabel("BPA CALL")).toBe("Order / call");
    const coverage = federalCoverage([], [], []);
    expect(coverage.status).toBe("no_verified_match"); expect(coverage.historyComplete).toBe(false);
    expect(coverage.gaps.join(" ")).toContain("outside that source scope");
  });
  it("renders direct vs related evidence, registration status, source dates and partial coverage distinctly", () => {
    const entity = { ...direct, registration_status: "Expired", expiration_date: "2025-01-01" };
    const related = bindRelatedFederalEntities([entity], [{ id: "parent", legal_name: "Parent Co", uei: direct.parent_uei }]);
    related[0].awards = [{ id: "parent-award", award_type: "IDV_B", total_obligations: 50, award_ceiling: 1000,
      source_url: "https://www.usaspending.gov/award/P1/latest" }];
    const html = renderToStaticMarkup(React.createElement(FederalIdentityContext, { entities: [entity], pendingEntities: [], relatedEntities: related,
      coverage: federalCoverage([entity], [], []) }));
    expect(html).toContain("Federal registration on file"); expect(html).toContain("SAM registration: "); expect(html).toContain("Expired");
    expect(html).toContain("Related-company federal context"); expect(html).toContain("Reported parent of");
    expect(html).toContain("excluded from this account"); expect(html).toContain("Federal source coverage");
    expect(html).toContain("Not searched yet");
    expect(html).toContain("Contract vehicle (IDV)"); expect(html).toContain("relationship evidence");
    expect(html).not.toContain("Federal contractor confirmed");
  });
});
