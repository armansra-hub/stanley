import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), evaluate: vi.fn(), reserve: vi.fn(), publish: vi.fn(), attach: vi.fn(), bind: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }), withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, INTELLIGENCE_VERSION: "evidence-v2" }));
vi.mock("./jev", async importOriginal => ({ ...await importOriginal<typeof import("./jev")>(),
  evaluateEvidence: mocks.evaluate, estimateEvidenceInputTokens: () => 100, evidenceRequestFingerprint: () => "a".repeat(64) }));
vi.mock("./budget", async importOriginal => ({ ...await importOriginal<typeof import("./budget")>(), reserveJev: mocks.reserve, settleJev: vi.fn(), secondsUntilNextMonth: () => 9999 }));
vi.mock("./feedback", () => ({ loadFeedbackExamples: async () => [] }));
vi.mock("./narratives", () => ({ queueAccountStory: async () => undefined }));
vi.mock("./events", () => ({ reconcileObservationEvent: mocks.attach, EventReconciliationDeferred: class extends Error {}, bindEventTrigger: mocks.bind }));
vi.mock("./publish", async importOriginal => ({ ...await importOriginal<typeof import("./publish")>(), publishJevFinding: mocks.publish }));
import { evidencePackets, runIntelligenceWorker, type PartResult } from "./worker";

const company = { id: "company", name: "Synthetic Consulting", subindustry: "Management Consulting" };
const observation = { id: "observation", company_id: company.id, evidence_text: "A".repeat(6400), source_kind: "website",
  source_url: "https://example.test/news", title: "ERP planning", event_date: new Date(Date.now() - 86400000).toISOString(),
  observed_at: new Date().toISOString(), is_current: true, metadata: {} };
let job: any, checkpoints: any[], completion: any, stale: boolean;
beforeEach(() => {
  vi.clearAllMocks(); checkpoints = []; completion = null; stale = false;
  const parts: PartResult[] = evidencePackets(observation.evidence_text, 6000).map((packet, i) => ({ start: packet.start, end: packet.end,
    evaluation: { ok: true, model: "jev-1.13.0", questionVersion: "stanley-evidence-v2", usage: { inputTokens: 100, outputTokens: 0 },
      metadata: { provider: "typesafe-direct", rawAnswers: { companyRelevance: { type: "noul", noul: i ? .85 : .99 } } },
      criteria: (i ? { project_billing: .91 } : {}) as Record<string, number>, attributes: { signalType: i ? "erp_tech" : "none", companyRelationship: "direct",
        companyRelevance: i ? .85 : .99, concreteEvent: i ? .9 : .99, evidenceSectionId: "s1", isAcquirer: 0,
        operationalComplexity: i ? .3 : 1, growthRelevance: .2, evidenceStrength: .8, requiresResearch: .4 } } }));
  job = { id: "job", observation_id: observation.id, kind: "interpret", lease_token: "lease", attempts: 1, result: { parts } };
  let claimed = false;
  mocks.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === "intelligence_finish") completion = structuredClone(args);
    return { data: name === "intelligence_claim" ? claimed ? [] : (claimed = true, [job]) : true, error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    let patch: any; const query: any = {};
    for (const method of ["select", "eq", "gt", "limit"]) query[method] = () => query;
    query.update = (value: any) => { patch = structuredClone(value); checkpoints.push(patch); return query; };
    const result = () => ({ data: table === "intelligence_config" ? { enabled: true } : table === "intelligence_views" ? []
      : table === "intelligence_observations" ? observation : table === "companies" ? company : patch && !stale ? { id: job.id } : null, error: null });
    query.single = query.maybeSingle = async () => result(); query.then = (resolve: any) => Promise.resolve(result()).then(resolve);
    return query;
  });
  mocks.attach.mockResolvedValue({ id: "event", company_id: company.id }); mocks.bind.mockResolvedValue(undefined);
  mocks.publish.mockImplementation(async ({ evaluation }: any) => evaluation.attributes.signalType === "erp_tech"
    ? { status: "published", triggerId: "trigger", operationKey: "operation" } : { status: "not_eligible", reason: "operating_context_only" });
});

describe("saved-packet publication recovery", () => {
  it("publishes the eligible lower-ranked packet in one invocation without another paid call and retains all raw outcomes", async () => {
    expect(await runIntelligenceWorker(1)).toMatchObject({ processed: 1, outcomes: { complete: 1 } });
    expect(mocks.evaluate).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls.map(([value]) => value.evaluation.attributes.signalType)).toEqual(["erp_tech", "none"]);
    expect(mocks.attach.mock.calls[0][2].signalType).toBe("erp_tech");
    expect(checkpoints[0].result.publications).toHaveLength(1);
    expect(completion.p_result.publications).toHaveLength(2);
    expect(completion.p_attributes.signalType).toBe("none");
    expect(completion.p_attributes.topicEvidence[0]).toMatchObject({ topic: "project_billing", companyRelevance: .85 });
    expect(completion.p_attributes.packetFindings[1]).toMatchObject({ rawAnswers: job.result.parts[1].evaluation.metadata.rawAnswers,
      publication: { status: "published" }, excerptStart: 6000, excerptEnd: 6400 });
  });
  it("resumes checkpointed publication receipts without another publication or model call", async () => {
    job.result.publications = job.result.parts.map((part: PartResult) => ({ start: part.start, end: part.end,
      questionVersion: part.evaluation.questionVersion, attemptedAt: observation.observed_at, outcome: { status: "not_eligible", reason: "unknown_event_date" } }));
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { complete: 1 } });
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(completion.p_attributes.packetFindings[0].publication.reason).toBe("unknown_event_date");
  });
  it("never completes after losing the lease while saving the first publication outcome", async () => {
    stale = true;
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { checkpoint_or_service_error: 1 } });
    expect(completion).toBeNull(); expect(mocks.publish).toHaveBeenCalledOnce(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("never fills a routing-backfill packet gap with a paid evaluation", async () => {
    job.result.routingBackfill = "business-services-v1"; job.result.parts.pop();
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { saved_packet_coverage_gap: 1 } });
    expect(completion.p_status).toBe("failed"); expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
});
