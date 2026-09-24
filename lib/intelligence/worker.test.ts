import { describe, expect, it } from "vitest";
import { evidencePackets, candidateType, nextRetrySeconds, workerEvidenceInput } from "./worker";
import { estimateEvidenceInputTokens } from "./jev";
import type { EvaluateEvidenceResult } from "./evaluation";
import { buildPublicScaleContext } from "./publicContext";

const result = { ok: true, model: "test", questionVersion: "v1", usage: null, metadata: { provider: "typesafe-direct" }, criteria: {},
  attributes: { signalType: "ma", companyRelationship: "direct", companyRelevance: 0.95, concreteEvent: 0.96,
    isAcquirer: 0.97, operationalComplexity: 0.7, growthRelevance: 0.7, evidenceStrength: 0.8, requiresResearch: 0.6, evidenceSectionId: "s1" },
} as Extract<EvaluateEvidenceResult, { ok: true }>;

describe("complete bounded evidence packets", () => {
  it("includes the non-asset 3PL question in future logistics packets within the same question and token bounds", () => {
    for (const subindustry of ["Freight & Logistics", "Freight & Logistics Services", "Trucking, Moving & Storage"]) {
      for (const source_kind of ["website", "company_news", "ats_job"]) {
        const observation = { evidence_text: "Acme arranges customer freight through independent carriers.", source_kind,
          source_url: "https://acme.test/services", title: "Logistics services", event_date: null, observed_at: "2026-09-24" };
        const input = workerEvidenceInput(observation, { name: "Acme", subindustry }, evidencePackets(observation.evidence_text)[0], null, []);
        expect(input.criteria?.map(criterion => criterion.id)).toContain("non_asset_based_3pl");
        expect(input.criteria).toHaveLength(10);
        expect(estimateEvidenceInputTokens(input)).not.toBeNull();
      }
    }
  });
  it("gives new v2 packets authorized identity and publication-date provenance while keeping v1 unchanged", () => {
    const observation = { evidence_text: "Company closes its current publication.", source_kind: "website", source_url: "https://publisher.com/news",
      title: "Holiday message", event_date: "2026-07-04", observed_at: "2026-09-19", metadata: { eventDateBasis: "page_publication",
        sourceDates: [{ kind: "published", value: "2026-07-04", source: "article:published_time" }], researchTopics: ["investor_reporting"] } };
    const packet = evidencePackets(observation.evidence_text)[0];
    const input = workerEvidenceInput(observation, { name: "Publisher", subindustry: "Publishing" }, packet, null, [], undefined, "business-services-v2", "Authorized company identity: Minneapolis, MN");
    expect(input).toMatchObject({ questionPack: "business-services-v2", eventDateBasis: "page_publication", companyIdentityContext: "Authorized company identity: Minneapolis, MN" });
    expect(JSON.parse(input.sourceDateContext!)).toEqual(observation.metadata.sourceDates);
    expect(input.criteria?.slice(0, 4).map(c => c.id)).toEqual(["project_delivery", "multi_entity", "multi_location", "investor_reporting"]);
    expect(estimateEvidenceInputTokens(input)).not.toBeNull();
    const legacy = workerEvidenceInput(observation, { name: "Publisher" }, packet, null, [], undefined, "business-services-v1", "Never included");
    expect(legacy.questionPack).toBe("business-services-v1");
    expect(legacy).not.toHaveProperty("companyIdentityContext"); expect(legacy).not.toHaveProperty("eventDateBasis");
  });
  it("supplies attributed scale context separately from the event and leaves absent scale explicit", () => {
    const observation = { evidence_text: "Acme opened an Austin facility.", source_kind: "website", source_url: "https://acme.test/news",
      title: "New facility", event_date: null, observed_at: "2026-09-18T23:00:00Z" };
    const context = buildPublicScaleContext("company", [{ id: "baseline", company_id: "company", source_kind: "website",
      source_url: "https://acme.test/about", title: "About", evidence_text: "Acme operates two facilities.", event_date: "2026-09-01",
      observed_at: "2026-09-18", is_current: true, attributes: { companyRelationship: "direct", companyRelevance: .95 } }]);
    const input = workerEvidenceInput(observation, { name: "Acme" }, evidencePackets(observation.evidence_text)[0], null, [], context);
    expect(input.text).toBe(observation.evidence_text);
    expect(input.publicScaleContext).toContain("two facilities");
    expect(input.publicScaleContext).toContain("https://acme.test/about");
    expect(input.publicScaleContext).toContain("remain unknown unless");
    expect(estimateEvidenceInputTokens(input)).not.toBeNull();
  });
  it("prepares a short single-packet page without empty optional neighboring context", () => {
    const observation = { evidence_text: "Acme opened an Austin facility.", source_kind: "company_news", source_url: "https://acme.test/news",
      title: "New facility", event_date: null, observed_at: "2026-09-18T23:00:00Z" };
    const input = workerEvidenceInput(observation, { name: "Acme", domain: "acme.test", subindustry: " " }, evidencePackets(observation.evidence_text, 6000)[0], null, []);
    expect(input).not.toHaveProperty("surroundingContext");
    expect(input).not.toHaveProperty("companyContext");
    expect(estimateEvidenceInputTokens(input)).not.toBeNull();
  });
  it("keeps source context on a long page and prepares every packet within the same bounds", () => {
    const observation = { evidence_text: "Acme opened an Austin facility.\n".repeat(600), source_kind: "company_news", source_url: "https://acme.test/news",
      title: "New facility", event_date: null, observed_at: "2026-09-18T23:00:00Z" };
    for (const packet of evidencePackets(observation.evidence_text, 6000)) {
      const input = workerEvidenceInput(observation, { name: "Acme", domain: "acme.test", subindustry: "Engineering" }, packet, null, []);
      expect(input.surroundingContext?.length).toBeGreaterThan(0);
      expect(estimateEvidenceInputTokens(input)).not.toBeNull();
    }
  });
  it("retains full evidence with bounded identity, scale and source dates in the v2 request ceiling", () => {
    const observation = { evidence_text: "Acme describes its finance process and work.\n".repeat(400), source_kind: "website", source_url: "https://acme.com/news",
      title: "Operating update", event_date: "2026-09-18", observed_at: "2026-09-19", metadata: { eventDateBasis: "page_publication",
        sourceDates: Array.from({ length: 12 }, () => ({ kind: "published", value: "2026-09-18T00:00:00Z", source: "article:published_time" })) } };
    const context = { ...buildPublicScaleContext("company", []), text: "Public source baseline. ".repeat(130) };
    for (const packet of evidencePackets(observation.evidence_text, 6000)) {
      const request = workerEvidenceInput(observation, { name: "Acme", subindustry: "Management Consulting" }, packet, null, [], context, "business-services-v2", "Authorized identity context. ".repeat(130));
      expect(request.text).toBe(packet.text);
      const sizeInfo = Object.fromEntries(Object.entries(request).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? "")]));
      expect(estimateEvidenceInputTokens(request), JSON.stringify(sizeInfo)).not.toBeNull();
    }
  });
  it("covers Unicode and long text exactly without split surrogate pairs", () => {
    const text = "A public update 😀 漢字.\n".repeat(3000);
    const packets = evidencePackets(text);
    expect(packets.map((p) => p.text).join("")).toBe(text);
    expect(packets.every((p) => Buffer.byteLength(p.text) <= 8000)).toBe(true);
    for (const p of packets) expect(text.slice(p.start, p.end)).toBe(p.text);
  });
});
describe("evidence-to-existing-review routing", () => {
  it("routes exact current acquirers and never invents event dates", () => {
    const now = Date.parse("2026-09-18");
    expect(candidateType(result, "2026-09-17", now)).toBe("ma");
    expect(candidateType(result, null, now)).toBeNull();
    expect(candidateType(result, "2020-01-01", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, isAcquirer: 0.1 } }, "2026-09-17", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, companyRelationship: "related" } }, "2026-09-17", now)).toBeNull();
    expect(candidateType({ ...result, attributes: { ...result.attributes, signalType: "federal_award" } }, "2026-09-17", now)).toBeNull();
  });
  it("backs off deferred work instead of continuously retrying it", () => {
    expect(nextRetrySeconds(1)).toBe(120);
    expect(nextRetrySeconds(5)).toBeGreaterThan(nextRetrySeconds(2));
  });
});
