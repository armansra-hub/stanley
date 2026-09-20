import { describe, expect, it } from "vitest";
import { buildTopicSearchResult, operatingTopicFilter, type TopicSearchRaw } from "./topicSearch";
import type { ProfileObservation } from "./profiles";
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
});
