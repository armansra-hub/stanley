import { describe, expect, it } from "vitest";
import { buildTopicSearchResult, operatingTopicFilter, type TopicSearchRaw } from "./topicSearch";
import type { ProfileObservation } from "./profiles";
import { OPERATING_CATALOG_VERSION } from "./operatingCatalog";
import { operatingRecipe } from "./operatingSearchCatalog";
const source = (id: string, topic: string): ProfileObservation => ({ id, source_url: `https://example.test/${id}`, title: "Public source", source_kind: "website", event_date: null, observed_at: "2026-09-18", evidence_text: "A verbatim source passage.", attributes: { companyRelationship: "direct", companyRelevance: .95, topicEvidence: [{ topic, probability: .9, start: 2, end: 25 }] } });
const fixture = (): TopicSearchRaw => ({ enabled: true, topics: ["project_billing", "inventory"], hasMore: false, nextCursor: null,
  accounts: [{ companyId: "account", name: "Example Engineering", domain: "example.test", subindustry: "Engineering", internalId: "1", coverage: { observations: 8, interpreted: 5 }, observations: [source("project", "project_billing"), source("stock", "inventory")] }] });

describe("cross-source operating matches", () => {
  it("explores lower native packet probabilities without changing supported defaults or attribution", () => {
    const raw = fixture(); raw.topics = ["project_billing"]; raw.accounts[0].observations = [{ ...source("moderate", "project_billing"), attributes: {
      companyRelationship: "direct", companyRelevance: .2, topicEvidence: [], packetFindings: [{start:0,end:20,
        criteria: { project_billing: .72 }, attributes: {companyRelationship:"direct",companyRelevance:.68}}] } }];
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
    const result = buildTopicSearchResult({...raw,visibility:"explore"});
    expect(result.accounts[0].topics[0]).toMatchObject({state:"exploratory",sources:[{probability:.72,companyRelevance:.68}]});
    expect(raw.accounts[0].observations[0].attributes!.topicEvidence).toEqual([]);
  });
  it("supports AND across separate sources with exact context and honest cache coverage", () => {
    const result = buildTopicSearchResult(fixture());
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].topics.map(topic => topic.sources[0].url)).toEqual(["https://example.test/project", "https://example.test/stock"]);
    expect(result.accounts[0].topics[0].sources[0].contextPreview).toBe("verbatim source passage");
    expect(result.accounts[0].coverage).toEqual({ observations: 8, interpreted: 5, citedObservations: 2 });
    expect(result.coverageLimited).toBe(true);
  });
  it("does not claim a compound match when one trait lacks valid evidence", () => {
    const raw = fixture(); raw.accounts[0].observations.pop();
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
  });
  it.each(["javascript:alert(1)", "https://user:secret@example.test/a"])("rejects unsafe citation URLs: %s", url => {
    const raw = fixture(); raw.accounts[0].observations[1].source_url = url;
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
  });
  it("requires bounded, numeric topic evidence and company attribution", () => {
    const raw = fixture(); raw.accounts[0].observations[0].attributes!.companyRelevance = "0.9";
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
    raw.accounts[0].observations[0].attributes!.companyRelevance = .9;
    raw.accounts[0].observations[0].attributes!.topicEvidence = [{ topic: "project_billing", probability: Infinity, start: 0, end: 10 }];
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
  });
  it("validates and deduplicates the finite operating taxonomy", () => {
    expect(operatingTopicFilter(["inventory", "inventory"])).toEqual(["inventory"]);
    expect(operatingTopicFilter(["constructor"])).toBeNull();
    expect(operatingTopicFilter([])).toEqual([]);
  });
  it("supports Any and counts-only without fabricating support for unmatched selected traits", () => {
    const raw = fixture(); raw.accounts[0].observations.pop(); raw.mode = "any";
    expect(buildTopicSearchResult(raw).accounts[0].topics.map(topic => topic.id)).toEqual(["project_billing"]);
    expect(buildTopicSearchResult({ ...raw, topics: [], topicCounts: { project_billing: 5 } })).toMatchObject({ accounts: [], topicCounts: { project_billing: 5 } });
  });
  it("accepts independently attributed topic packets behind a weak representative answer", () => {
    const raw = fixture();
    raw.accounts[0].observations[0].attributes = { companyRelevance: .2, companyRelationship: "unknown",
      topicEvidence: [{ topic: "project_billing", probability: .83, companyRelevance: .91, companyRelationship: "direct", start: 0, end: 20 }] };
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(1);
  });
  it("uses native catalog decisions without inventing probability or applying legacy cutoffs", () => {
    const raw = fixture(); raw.topics = ["rr_c01"];
    raw.accounts[0].observations = [{ ...source("model", "inventory"), content_hash: "exact", evidence_text: "😀 Installed equipment and service", attributes: null }];
    raw.accounts[0].catalogFacets = [{ id: "rr_c01", catalogVersion: OPERATING_CATALOG_VERSION, decision: "supported", status: "answered", probability: null,
      nativeResult: { answer: { type: "choice", choice: "supported" } }, citations: [{ observationId: "model", url: "https://example.test/model", title: "Model", sourceKind: "website",
        observedAt: "2026-09-24", eventDate: null, start: 3, end: 34, contentHash: "exact" }] }];
    const result = buildTopicSearchResult(raw);
    expect(result.accounts[0].topics[0]).toMatchObject({ classification: "native_choice", sources: [{ probability: null, contextPreview: "Installed equipment and service" }] });
    raw.accounts[0].catalogFacets[0].probability = .63;
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(1);
    expect(raw.accounts[0].catalogFacets[0].nativeResult).toEqual({ answer: { type: "choice", choice: "supported" } });
    raw.accounts[0].catalogFacets[0].catalogVersion = "old-definition";
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
    raw.accounts[0].catalogFacets[0].catalogVersion = OPERATING_CATALOG_VERSION;
    raw.accounts[0].observations[0].content_hash = "changed-evidence";
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
  });
  it.each(["insufficient_evidence", "not_supported", "conflicting", "private_context_required"])("does not turn %s into a match", decision => {
    const raw = fixture(); raw.topics = ["rr_o03"];
    raw.accounts[0].catalogFacets = [{ id: "rr_o03", catalogVersion: OPERATING_CATALOG_VERSION, decision, status: "context_only", probability: null, nativeResult: null, citations: [] }];
    expect(buildTopicSearchResult(raw).accounts).toEqual([]);
  });
  it("preserves the exact AND/OR structure of research combinations", () => {
    const recipe = operatingRecipe("B07")!;
    expect(recipe.combinations).toEqual([["rr_t01", "non_asset_based_3pl", "rr_t03"], ["rr_t01", "non_asset_based_3pl", "rr_t04"], ["rr_t02", "rr_t03"], ["rr_t02", "rr_t04"]]);
    expect(operatingRecipe("invalid")).toBeNull();
    const raw = fixture(); raw.combinations = [["project_billing"], ["inventory"]]; raw.accounts[0].observations.pop();
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(1);
    raw.combinations = [["project_billing", "inventory"]];
    expect(buildTopicSearchResult(raw).accounts).toHaveLength(0);
  });
  it("does not expose the user-removed renewal category", () => {
    expect(operatingTopicFilter(["rr_o06"])).toBeNull();
  });
});
