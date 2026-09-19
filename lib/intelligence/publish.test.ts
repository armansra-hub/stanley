import { describe, expect, it, vi } from "vitest";
import { jevSignalType, jevPublicationRoute, publishJevFinding, type JevPublicationObservation } from "./publish";
import type { EvaluateEvidenceResult } from "./evaluation";

const now = Date.parse("2026-09-18T12:00:00Z");
const company = { id: "11111111-1111-4111-8111-111111111111", name: "Blue River Services", status: "new" };
const text = "Blue River Services opened a second operating site and expanded its project delivery team.";
const observation: JevPublicationObservation = { id: "22222222-2222-4222-8222-222222222222", company_id: company.id, source_kind: "news", source_url: "https://blueriver.com/news/expansion", title: "Blue River adds a second operating site", evidence_text: text, event_date: "2026-09-17T00:00:00Z", observed_at: "2026-09-18T00:00:00Z", is_current: true, metadata: {} };
const evaluation: Extract<EvaluateEvidenceResult, { ok: true }> = { ok: true, model: "jev-1.13.0", questionVersion: "stanley-evidence-v1",
  attributes: { signalType: "press", companyRelationship: "direct", evidenceSectionId: "s1", companyRelevance: .93, concreteEvent: .88, isAcquirer: .12,
    operationalComplexity: .71, growthRelevance: .87, evidenceStrength: .76, requiresResearch: .41 }, criteria: { multi_location: .94 },
  metadata: { provider: "typesafe-direct", responseModel: "jev-1.13.0", confidence: { signalType: .91 } }, usage: { inputTokens: 800, outputTokens: 20 } };
const input = () => ({ company: { ...company }, observation: structuredClone(observation), evaluation: structuredClone(evaluation), passage: { start: 0, end: text.length, text } });

function fixture() {
  let saved: any = null;
  const record = vi.fn(async (companyId, trigger) => { saved = { id: "trigger1", company_id: companyId, type: trigger.type, source_url: trigger.source_url,
    source_name: trigger.source_name, summary: trigger.summary, signal_date: trigger.signal_date, metadata: { jevFinding: trigger.jevFinding, intelligenceEvidence: trigger.intelligenceEvidence } }; return true; });
  const find = vi.fn(async () => saved);
  const reheat = vi.fn().mockResolvedValue(true);
  const priority = vi.fn().mockResolvedValue(50);
  const attach = vi.fn(async (_id, _company, _url, finding, evidence) => {
    const contexts = saved?.metadata?.jevContextFindings ?? [];
    if (saved && !contexts.some((value: any) => value.finding.operationKey === finding.operationKey))
      saved.metadata = { ...saved.metadata, jevContextFindings: [...contexts, { finding, evidence }] };
    return true;
  });
  return { record, find, reheat, priority, attach, now: () => now, setSaved: (value: any) => { saved = value; }, getSaved: () => saved };
}

describe("direct Jev publication", () => {
  const classified = (patch: Partial<typeof evaluation.attributes> = {}) => ({ ...evaluation, questionVersion: "stanley-business-services-v2", attributes: {
    ...evaluation.attributes, signalType: "operating_change" as const, contentClass: "actual_company_development" as const,
    companyRole: "subject" as const, contractActivity: "none" as const, operatingChangeType: "billing_or_finance_process" as const, ...patch,
  } });
  it("uses native first-pass classes to distinguish holiday/editorial/client coverage from actual company changes", () => {
    for (const contentClass of ["holiday_greeting", "editorial_coverage", "client_work", "promotional_content", "incidental_mention", "evergreen_profile", "unknown"] as const) {
      const result = classified({ contentClass });
      expect(jevPublicationRoute(result, observation.event_date, now)).toEqual({ type: null, reason: `content_${contentClass}` });
      expect(result.attributes.contentClass).toBe(contentClass);
    }
    for (const companyRole of ["publisher", "namesake", "unknown"] as const)
      expect(jevPublicationRoute(classified({ companyRole }), observation.event_date, now).reason).toBe(`company_role_${companyRole}`);
    expect(jevSignalType(classified(), observation.event_date, now)).toBe("operating_change");
    expect(jevSignalType(classified({ signalType: "erp_tech", companyRole: "customer", operatingChangeType: "systems_change" }), observation.event_date, now)).toBe("erp_tech");
    // Real mixed-content source: the holiday headline does not erase an explicit closure.
    expect(jevSignalType(classified({ operatingChangeType: "closure_or_wind_down" }), observation.event_date, now)).toBe("operating_change");
  });
  it("routes own commercial awards but not bids, registrations or unverified government identity", () => {
    const award = classified({ signalType: "news", companyRole: "service_provider", contractActivity: "commercial_award", operatingChangeType: "contract_award" });
    expect(jevSignalType(award, observation.event_date, now)).toBe("operating_change");
    for (const contractActivity of ["bid_opportunity", "bid_submission", "registration", "existing_contract_delivery", "unknown", "none"] as const)
      expect(jevPublicationRoute(classified({ contractActivity, operatingChangeType: "contract_award" }), observation.event_date, now).reason).toBe("contract_award_not_established");
    expect(jevPublicationRoute(classified({ contractActivity: "government_award", operatingChangeType: "contract_award" }), observation.event_date, now).reason).toBe("government_publisher_required");
    // Older paid contracts have no new native fields and retain their original routing.
    expect(jevSignalType({ ...evaluation, questionVersion: "stanley-business-services-v1" }, observation.event_date, now)).toBe("press");
  });
  it("persists exact native content, role, contract and direction choices alongside their distributions", async () => {
    const deps = fixture(); const request = input(); request.evaluation = classified({ operatingChangeType: "closure_or_wind_down" });
    request.observation.title = "July 4, 1776 through July 4, 2026";
    request.evaluation.metadata = { provider: "typesafe-direct", rawAnswers: {
      contentClass: { type: "choice", choice: "actual_company_development", probabilities: { actual_company_development: .83, holiday_greeting: .17 }, confidence: .57 },
      companyRole: { type: "choice", choice: "subject" }, contractActivity: { type: "choice", choice: "none" },
      operatingChangeType: { type: "choice", choice: "closure_or_wind_down" },
    } };
    expect((await publishJevFinding(request, deps)).status).toBe("published");
    expect(deps.getSaved().metadata.jevFinding.attributes).toEqual(request.evaluation.attributes);
    expect(deps.getSaved().metadata.jevFinding.rawAnswers).toEqual(request.evaluation.metadata.rawAnswers);
  });
  it("keeps one event card across reports without changing the original source or Jev answers", async () => {
    const deps = fixture();
    const event = { id: "event1", company_id: company.id, event_type: "press", title: observation.title,
      event_date: observation.event_date, primary_source_url: observation.source_url, trigger_id: null, evidence_count: 1, revision: 1, updated_at: observation.observed_at };
    const findEvent = vi.fn(async () => deps.getSaved());
    await publishJevFinding({ ...input(), event }, { ...deps, findEvent });
    const original = structuredClone(deps.getSaved());
    const syndicated = input(); syndicated.observation.id = "20000000-0000-4000-8000-000000000002";
    syndicated.observation.source_url = "https://publisher.example.com/expansion";
    const second = await publishJevFinding({ ...syndicated, event }, { ...deps, findEvent });
    expect(second.status).toBe("already_published");
    expect(deps.record).toHaveBeenCalledOnce();
    expect(deps.getSaved()).toMatchObject(original);
    expect(deps.getSaved().metadata.jevContextFindings).toHaveLength(1);
    expect(deps.getSaved().source_url).toBe(observation.source_url);
  });
  it("reads the winning event after a concurrent insert loses the unique event key", async () => {
    const winner = fixture();
    const event = { id: "event1", company_id: company.id, event_type: "press", title: observation.title,
      event_date: observation.event_date, primary_source_url: observation.source_url, trigger_id: null, evidence_count: 2, revision: 2, updated_at: observation.observed_at };
    await publishJevFinding({ ...input(), event }, { ...winner, findEvent: async () => winner.getSaved() });
    const request = input(); request.observation.id = "20000000-0000-4000-8000-000000000003"; request.observation.source_url = "https://publisher.example.com/second";
    const losing = fixture(); losing.find.mockResolvedValue(null); losing.record.mockResolvedValue(false);
    const findEvent = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner.getSaved());
    expect((await publishJevFinding({ ...request, event }, { ...losing, findEvent })).status).toBe("already_published");
    expect(losing.record).toHaveBeenCalledOnce();
    expect(winner.getSaved().metadata.jevFinding.observationId).toBe(observation.id);
  });
  it("publishes raw Jev attributes and scores, model version and exact passage without second-model review", async () => {
    const deps = fixture();
    expect(await publishJevFinding(input(), deps)).toMatchObject({ status: "published", triggerId: "trigger1" });
    const metadata = deps.getSaved().metadata;
    expect(metadata.jevFinding).toMatchObject({ interpretation: "jev", independentlyVerified: false, model: evaluation.model,
      questionVersion: evaluation.questionVersion, attributes: evaluation.attributes, criteria: evaluation.criteria, confidence: evaluation.metadata.confidence, usage: evaluation.usage });
    expect(metadata.intelligenceEvidence).toEqual({ observationId: observation.id, excerpt: text, start: 0, end: text.length, observedAt: observation.observed_at });
    expect(deps.reheat).toHaveBeenCalledWith(company.id, "press", observation.source_url, observation.event_date);
    expect(deps.priority).toHaveBeenCalledWith(company.id);
  });
  it("uses exact stored receipt on retry and does not insert a second trigger", async () => {
    const deps = fixture();
    const first = await publishJevFinding(input(), deps);
    const retry = await publishJevFinding(input(), deps);
    expect(retry).toEqual({ ...first, status: "already_published" });
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.priority).toHaveBeenCalledTimes(2);
  });
  it("accepts JSONB key reordering in a byte-equivalent source receipt", async () => {
    const deps = fixture();
    await publishJevFinding(input(), deps);
    const saved = deps.getSaved();
    saved.metadata.intelligenceEvidence = Object.fromEntries(Object.entries(saved.metadata.intelligenceEvidence).reverse());
    saved.metadata.jevFinding = Object.fromEntries(Object.entries(saved.metadata.jevFinding).reverse());
    expect((await publishJevFinding(input(), deps)).status).toBe("already_published");
  });
  it("never treats recordTrigger false as a persistence receipt", async () => {
    const deps = fixture();
    deps.record.mockResolvedValue(false);
    await expect(publishJevFinding(input(), deps)).rejects.toThrow("no exact source receipt");
    expect(deps.priority).not.toHaveBeenCalled();
  });
  it("recovers a concurrently inserted exact finding even when insert returns false", async () => {
    const deps = fixture();
    const insert = deps.record.getMockImplementation()!;
    deps.record.mockImplementation(async (id, trigger) => { await insert(id, trigger); return false; });
    expect((await publishJevFinding(input(), deps)).status).toBe("already_published");
  });
  it("retries an interrupted priority update from the saved trigger receipt", async () => {
    const deps = fixture();
    deps.priority.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(publishJevFinding(input(), deps)).rejects.toThrow("database unavailable");
    expect((await publishJevFinding(input(), deps)).status).toBe("already_published");
    expect(deps.record).toHaveBeenCalledTimes(1);
  });
  it("requires strict post-insert reheat completion before returning publication success", async () => {
    const deps = fixture();
    deps.reheat.mockRejectedValueOnce(new Error("reheat unavailable"));
    await expect(publishJevFinding(input(), deps)).rejects.toThrow("reheat unavailable");
    expect(deps.priority).not.toHaveBeenCalled();
    expect((await publishJevFinding(input(), deps)).status).toBe("already_published");
  });
  it("throws when a supposedly inserted finding loses metadata or has a changed source passage", async () => {
    const deps = fixture();
    const insert = deps.record.getMockImplementation()!;
    deps.record.mockImplementation(async (id, trigger) => { await insert(id, trigger); delete deps.getSaved().metadata.jevFinding; return true; });
    await expect(publishJevFinding(input(), deps)).rejects.toThrow("metadata was not retained");
    const good = fixture();
    await publishJevFinding(input(), good);
    good.getSaved().metadata.intelligenceEvidence.excerpt = "changed";
    await expect(publishJevFinding(input(), good)).rejects.toThrow("receipt mismatch");
  });
  it("preserves a pre-existing different article interpretation under the established dedupe key", async () => {
    const deps = fixture();
    deps.setSaved({ id: "legacy1", company_id: company.id, type: "ma", source_url: observation.source_url, metadata: {} });
    expect(await publishJevFinding(input(), deps)).toMatchObject({ status: "context_attached", triggerId: "legacy1" });
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.getSaved().type).toBe("ma");
    expect(deps.getSaved().metadata.jevFinding).toBeUndefined();
    expect(deps.getSaved().metadata.jevContextFindings[0].finding.attributes).toEqual(evaluation.attributes);
    await publishJevFinding(input(), deps);
    expect(deps.getSaved().metadata.jevContextFindings).toHaveLength(1);
  });
  it("preserves verified-government publication for every government type and capture", async () => {
    for (const signalType of ["gov_contract", "federal_award", "federal_subaward", "sam_award_notice"] as const) {
      expect(jevSignalType({ ...evaluation, attributes: { ...evaluation.attributes, signalType } }, observation.event_date, now)).toBeNull();
    }
    const deps = fixture();
    const request = input(); request.observation.source_kind = "government";
    expect(await publishJevFinding(request, deps)).toMatchObject({ status: "not_eligible", reason: "government_publisher_required" });
    expect(deps.record).not.toHaveBeenCalled();
  });
  it("routes dated ERP/hiring/growth and substantive finance news without rewriting native labels", () => {
    for (const signalType of ["erp_tech", "hiring_velocity", "employee_growth"] as const)
      expect(jevSignalType({ ...evaluation, attributes: { ...evaluation.attributes, signalType } }, observation.event_date, now)).toBe(signalType);
    const news = { ...evaluation, attributes: { ...evaluation.attributes, signalType: "news" as const }, criteria: { close_reporting: .91 } };
    expect(jevSignalType(news, observation.event_date, now)).toBe("operating_change");
    expect(news.attributes.signalType).toBe("news");
    expect(jevPublicationRoute(news, null, now).reason).toBe("unknown_event_date");
    expect(jevPublicationRoute(news, "2020-01-01", now).reason).toBe("historical_event");
    expect(jevSignalType({ ...news, attributes: { ...news.attributes, concreteEvent: .2 } }, observation.event_date, now)).toBeNull();
  });
  it("keeps undated, future, stale, unrelated and low-relevance output on the raw observation only", async () => {
    for (const date of [null, "2026-10-18", "2020-01-01", "invalid"]) expect(jevSignalType(evaluation, date, now)).toBeNull();
    expect(jevSignalType({ ...evaluation, attributes: { ...evaluation.attributes, companyRelationship: "related" } }, observation.event_date, now)).toBeNull();
    expect(jevSignalType({ ...evaluation, attributes: { ...evaluation.attributes, companyRelevance: .3 } }, observation.event_date, now)).toBeNull();
    const deps = fixture(); const request = input(); request.observation.event_date = null;
    expect((await publishJevFinding(request, deps)).status).toBe("not_eligible");
    expect(deps.record).not.toHaveBeenCalled();
  });
  it("rejects wrong-account, unsafe source and invented/misaligned passage without publication", async () => {
    const deps = fixture(); const wrong = input(); wrong.observation.company_id = "other";
    await expect(publishJevFinding(wrong, deps)).rejects.toThrow("account mismatch");
    const unsafe = input(); unsafe.observation.source_url = "http://127.0.0.1/private";
    await expect(publishJevFinding(unsafe, deps)).rejects.toThrow();
    const invented = input(); invented.passage.text = "Invented passage";
    await expect(publishJevFinding(invented, deps)).rejects.toThrow("passage mismatch");
    expect(deps.record).not.toHaveBeenCalled();
  });
  it("bounds provider metadata without leaking arbitrary provider fields", async () => {
    const deps = fixture(); const request = input();
    (request.evaluation.metadata as any).rawProviderError = "do not persist";
    await publishJevFinding(request, deps);
    expect(JSON.stringify(deps.getSaved())).not.toContain("do not persist");
    const invalid = input(); invalid.evaluation.criteria = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, .5]));
    await expect(publishJevFinding(invalid, fixture())).rejects.toThrow("metadata");
  });
  it("preserves native scores, choices, probabilities and legends without reconciling model judgments", async () => {
    const deps = fixture(); const request = input();
    request.evaluation.metadata.rawAnswers = {
      operationalComplexity: { type: "score", score: 3.72, probabilities: { "0": .1, "1": .2, "2": .7 }, legend: { "0": "No operating change", "1": "Some change", "2": "Multiple operating changes" }, confidence: .61 },
      signalType: { type: "choice", choice: "press", probabilities: { press: .84, none: .16 }, confidence: .72 },
      concreteEvent: { type: "noul", noul: .887, confidence: .81 },
    };
    await publishJevFinding(request, deps);
    expect(deps.getSaved().metadata.jevFinding.rawAnswers).toEqual(request.evaluation.metadata.rawAnswers);
    expect(deps.getSaved().metadata.jevFinding.attributes.operationalComplexity).toBe(.71);
  });
  it("allows valid ATS finance evidence URLs while preserving existing company policy", async () => {
    const deps = fixture(); const request = input();
    request.evaluation.attributes.signalType = "finance_hire";
    request.observation.source_kind = "job";
    request.observation.source_url = "https://jobs.lever.co/blueriver/controller-123";
    expect((await publishJevFinding(request, deps)).status).toBe("published");
    const blocked = input(); blocked.company.name = "Blue River Accounting Firm"; blocked.evaluation.attributes.signalType = "finance_hire";
    expect((await publishJevFinding(blocked, fixture())).status).toBe("not_eligible");
  });
});
