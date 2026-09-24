import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPERATING_FACETS, OPERATING_INDUSTRY_GUIDES, OPERATING_COMMON_LESSONS, OPERATING_COMBINATION_RECIPES,
  PUBLIC_OPERATING_FACETS, operatingCatalogContext, operatingFacet, operatingFacetQuestion,
  operatingFacetQuestions, operatingGuideFacetCandidates, operatingFacetDecision,
  isSupportedOperatingFacetAnswer, assertOperatingNativeBounds,
  OPERATING_FACET_DECISIONS,
  OPERATING_EXCLUDED_SOURCE_CATEGORIES, OPERATING_CATALOG_VERSION, OPERATING_CATALOG_CONTENT_HASH, operatingCatalogContract,
  catalogResearchQueries,
} from "./operatingCatalog";
import { catalogSha256 } from "./operatingCatalogHash";

describe("research-derived operating catalog", () => {
  it("retains47 definitions and35 guides, with the user's one explicit source-category exclusion", () => {
    expect(OPERATING_FACETS).toHaveLength(47);
    expect(new Set(OPERATING_FACETS.map(f => f.id)).size).toBe(47);
    expect(OPERATING_EXCLUDED_SOURCE_CATEGORIES).toEqual(["O06"]);
    expect(operatingFacet("rr_o06")).toBeUndefined();
    expect(OPERATING_INDUSTRY_GUIDES).toHaveLength(35);
    expect(OPERATING_COMMON_LESSONS).toHaveLength(8);
    expect(OPERATING_COMBINATION_RECIPES).toHaveLength(10);
    for (const facet of OPERATING_FACETS) {
      expect(facet.id).toMatch(/^rr_[a-z][0-9]{2}$/);
      expect(facet.definition).toBeTruthy();
      expect(facet.boundary).toBeTruthy();
      expect(facet.discoveryHypothesis).toBeTruthy();
      expect(facet).not.toHaveProperty("examples");
      expect(facet).not.toHaveProperty("exampleNames");
      expect(facet.definitionHash).toBe(createHash("sha256").update(JSON.stringify([
        facet.id, facet.definitionVersion, facet.kind, facet.definition, facet.boundary, facet.instructions,
      ])).digest("hex"));
    }
    for (const guide of OPERATING_INDUSTRY_GUIDES) {
      expect(guide).not.toHaveProperty("researchExamples");
      expect(guide.territoryEffect).toBe("none");
      for (const id of guide.primaryFacetIds) expect(operatingFacet(id)).toBeDefined();
    }
  });

  it("includes all industry guidance in provider context without historical customer evidence", () => {
    const raw = operatingCatalogContext();
    const context = JSON.parse(raw);
    expect(context.industries).toHaveLength(35);
    expect(context.lessons).toHaveLength(8);
    expect(context.industries.map((g: { id: string }) => g.id)).toEqual(OPERATING_INDUSTRY_GUIDES.map(g => g.id));
    expect(raw).not.toContain("slack.com");
    expect(raw).not.toContain("researchExamples");
    expect(raw).not.toContain("publicSources");
    expect(context.policy).toContain("not facts about the target");
  });

  it("keeps seller/customer boundaries and complete conjunctions in native questions", () => {
    for (const id of ["rr_c01", "rr_c03", "rr_c05", "rr_i03", "rr_h01", "rr_s02"]) {
      const question = operatingFacetQuestion(id)!;
      expect(question.type).toBe("choice");
      expect(question.instructions).toContain("target company's own business");
      expect(question.instructions).toContain("customer's");
      expect(question.instructions).toContain("complete stated conjunction");
      expect(question.instructions).toContain(operatingFacet(id)!.boundary);
      expect(question.criteria.insufficient_evidence).toContain("incomplete");
      expect(question.criteria.not_supported).toContain("contradicts");
    }
  });

  it("retains complete decision definitions once in shared context and reduces repeated prompt bytes", () => {
    const context = operatingCatalogContext();
    const parsed = JSON.parse(context);
    expect(parsed.decisions).toEqual(OPERATING_FACET_DECISIONS);
    for (const meaning of Object.values(OPERATING_FACET_DECISIONS)) {
      expect(context.split(meaning)).toHaveLength(2);
    }
    const questions = operatingFacetQuestions(PUBLIC_OPERATING_FACETS.slice(0, 20).map(f => f.id)).questions;
    for (const question of Object.values(questions)) expect(question.instructions).toContain("Apply shared decision definitions");
    const repeated = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { ...question, criteria: OPERATING_FACET_DECISIONS }]));
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(bytes({ context, questions })).toBeLessThan(bytes({ context, questions: repeated }) - 6_000);
  });

  it("requires event dates and explicit systems context and removes renewal-history questions entirely", () => {
    expect(PUBLIC_OPERATING_FACETS).toHaveLength(47);
    expect(OPERATING_FACETS.filter(f => f.kind === "dated").map(f => f.id)).toEqual(["rr_r01", "rr_o01", "rr_o02", "rr_o03"]);
    for (const id of ["rr_r01", "rr_o01", "rr_o02", "rr_o03"]) {
      expect(operatingFacetQuestion(id)!.instructions).toContain("date and the target's own role are explicit");
      expect(operatingFacetQuestion(id)!.instructions).toContain("do not infer present urgency");
    }
    for (const id of ["rr_o04", "rr_o05"]) {
      expect(operatingFacetQuestion(id)!.instructions).toContain("only from explicit public evidence");
    }
    expect(() => operatingFacetQuestion("rr_o06")).toThrow("unknown_operating_facet");
    expect(operatingFacetQuestions(["rr_c01"])).toMatchObject({ requestedFacetIds: ["rr_c01"], contextOnlyFacetIds: [] });
  });

  it("preserves native supported decisions without converting choice confidence into probability", () => {
    const raw = { type: "choice", choice: "supported", confidence: .62, probabilities: { supported: .62, insufficient_evidence: .38 } };
    const before = JSON.stringify(raw);
    expect(isSupportedOperatingFacetAnswer(raw)).toBe(true);
    expect(operatingFacetDecision(raw)).toBe("supported");
    expect(JSON.stringify(raw)).toBe(before);
    expect(isSupportedOperatingFacetAnswer({ type: "noul", noul: .99 })).toBe(false);
    expect(isSupportedOperatingFacetAnswer({ type: "choice", choice: "insufficient_evidence" })).toBe(false);
    expect(operatingFacetDecision({ type: "choice", choice: "yes" })).toBeNull();
  });

  it("fails rather than slicing unknown, duplicate or oversized question sets", () => {
    expect(() => operatingFacetQuestions(PUBLIC_OPERATING_FACETS.map(f => f.id))).toThrow("operating_question_limit_exceeded");
    expect(() => operatingFacetQuestions(["rr_c01", "rr_c01"])).toThrow("duplicate_operating_facet");
    expect(() => operatingFacetQuestions(["customer_invented_category"])).toThrow("unknown_operating_facet");
    expect(() => operatingGuideFacetCandidates(["G99"])).toThrow("unknown_operating_guide");
    const ids = PUBLIC_OPERATING_FACETS.slice(0, 20).map(f => f.id);
    const set = operatingFacetQuestions(ids, 20);
    expect(set.requestedFacetIds).toEqual(ids);
    expect(Object.keys(set.questions)).toHaveLength(20);
    expect(() => assertOperatingNativeBounds({ model: "test", state: "x".repeat(48_000), questions: set.questions })).toThrow("native_request_too_large");
    expect(() => assertOperatingNativeBounds({ model: "test", state: {}, questions: {} })).toThrow("invalid_question_count");
    expect(assertOperatingNativeBounds({ model: "test", state: { text: "Public evidence" }, questions: operatingFacetQuestions(["rr_c01"]).questions }).questionCount).toBe(1);
  });

  it("preserves transport OR branches and affirmative non-asset evidence in cached recipes", () => {
    const transport = OPERATING_COMBINATION_RECIPES.find(r => r.id === "B07")!;
    expect(transport.branches).toEqual([
      { all: ["rr_t01"], any: ["rr_t03", "rr_t04"], legacyAll: ["non_asset_based_3pl"] },
      { all: ["rr_t02"], any: ["rr_t03", "rr_t04"], legacyAll: [] },
    ]);
    for (const recipe of OPERATING_COMBINATION_RECIPES) {
      expect(recipe.interpretation).toContain("not a new Jev probability");
      for (const id of recipe.facetIds) expect(operatingFacet(id)).toBeDefined();
    }
  });

  it("automatically binds the catalog version to complete question and guidance semantics", () => {
    const contract = JSON.stringify(operatingCatalogContract());
    expect(OPERATING_CATALOG_CONTENT_HASH).toBe(createHash("sha256").update(contract).digest("hex"));
    expect(OPERATING_CATALOG_VERSION).toBe("ring-ring-v1-" + OPERATING_CATALOG_CONTENT_HASH);
    expect(OPERATING_CATALOG_VERSION.length).toBeLessThanOrEqual(120);
    expect(catalogSha256(contract + " changed meaning")).not.toBe(OPERATING_CATALOG_CONTENT_HASH);
    for (const text of ["", "abc", "café 🧪", "x".repeat(56), "x".repeat(64), "x".repeat(1000)]) {
      expect(catalogSha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  it("covers every requested research theme without dropping categories to meet a query count", () => {
    for (const facet of OPERATING_FACETS) expect(catalogResearchQueries([facet.id]).length).toBeGreaterThan(0);
    expect(catalogResearchQueries(OPERATING_FACETS.map(f => f.id))).toHaveLength(24);
    expect(catalogResearchQueries(["rr_c09"])).toEqual(['pricing OR "usage based" OR consumption OR credits OR "per transaction"']);
    expect(catalogResearchQueries([])).toEqual([]);
    expect(() => catalogResearchQueries(["rr_o06"])).toThrow("unknown_operating_facet");
    expect(JSON.stringify(OPERATING_FACETS)).not.toMatch(/https?:|slack\.com|Integra Network|QuickBooks/);
    expect(JSON.stringify(OPERATING_INDUSTRY_GUIDES)).not.toMatch(/researchExamples|SwiftX|Program Productions/);
  });
});
