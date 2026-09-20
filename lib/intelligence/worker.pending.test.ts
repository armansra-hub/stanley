import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), evaluate: vi.fn(), durable: vi.fn(),
  feedback: vi.fn(), identity: vi.fn(), publicScale: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc, from: mocks.from }),
  withServiceDeadline: (_deadline: number, run: () => unknown) => run() }));
vi.mock("./observations", () => ({ intelligenceEnabled: () => true, INTELLIGENCE_VERSION: "evidence-v2" }));
vi.mock("./jev", async importOriginal => ({ ...await importOriginal<typeof import("./jev")>(), evaluateEvidence: mocks.evaluate }));
vi.mock("./jevRequests", () => ({ durableJevRequest: mocks.durable, reconcileJevReceipts: async () => undefined }));
vi.mock("./budget", () => ({ secondsUntilNextMonth: () => 9999 }));
vi.mock("./feedback", () => ({ loadFeedbackExamples: mocks.feedback }));
vi.mock("@/lib/companyIdentity", () => ({ loadCompanyIdentityContext: mocks.identity }));
vi.mock("./publicContext", () => ({ loadPublicScaleObservations: async () => [], buildPublicScaleContext: mocks.publicScale }));
vi.mock("./narratives", () => ({ queueAccountStory: async () => undefined }));
vi.mock("./events", () => ({ attachObservationEvent: vi.fn(), bindEventTrigger: vi.fn() }));
vi.mock("./publish", () => ({ jevSignalType: () => null, publishJevFinding: mocks.publish }));
import { runIntelligenceWorker } from "./worker";
import { evidenceRequestFingerprint } from "./jev";
import type { EvaluateEvidenceInput, EvaluateEvidenceResult } from "./evaluation";

const observation = { id: "observation", company_id: "company", evidence_text: "Synthetic Consulting delivers client projects and quarterly reporting.",
  source_kind: "website", source_url: "https://example.test/about", title: "Our services", event_date: null,
  observed_at: "2026-09-19T12:00:00Z", is_current: true, metadata: {} };
const evaluation: EvaluateEvidenceResult = { ok: true, model: "jev-1.13.0", questionVersion: "stanley-business-services-v3",
  usage: { inputTokens: 123, outputTokens: 0 }, metadata: { provider: "typesafe-direct", rawAnswers: { companyRelevance: { type: "noul", noul: .95 } } },
  criteria: { project_delivery: .9 }, attributes: { signalType: "none", companyRelationship: "direct", companyRelevance: .95,
    concreteEvent: .1, evidenceSectionId: "s1", isAcquirer: 0, operationalComplexity: .2, growthRelevance: .1,
    evidenceStrength: .8, requiresResearch: .4, contentClass: "evergreen_profile", companyRole: "subject",
    contractActivity: "none", operatingChangeType: "none" } };
type PendingRequest = { start: number; end: number; input: EvaluateEvidenceInput; fingerprint: string };
let company: Record<string, unknown>, savedResult: Record<string, any> | null, checkpoints: Record<string, any>[];
let completion: Record<string, any> | null, failAnswerCheckpoint: boolean;
let nativeCache: Map<string, EvaluateEvidenceResult>;

beforeEach(() => {
  vi.clearAllMocks();
  company = { id: "company", name: "Synthetic Consulting", domain: "example.test", subindustry: "Management Consulting" };
  savedResult = null; checkpoints = []; completion = null; failAnswerCheckpoint = false; nativeCache = new Map();
  mocks.evaluate.mockResolvedValue(evaluation);
  mocks.feedback.mockResolvedValue([{ text: "Prior project reference", correction: "Distinguish projects from an awarded contract." }]);
  mocks.identity.mockResolvedValue({ context: "Authorized identity: Synthetic Consulting, 12 Main St." });
  mocks.publicScale.mockReturnValue({ text: "Public source: two locations.", citations: [] });
  mocks.publish.mockResolvedValue({ status: "not_eligible", reason: "operating_context_only" });
  mocks.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === "intelligence_claim") return { data: [{ id: "job", observation_id: observation.id, kind: "interpret",
      lease_token: "current-lease", attempts: 2, result: structuredClone(savedResult) }], error: null };
    if (name === "intelligence_finish") { completion = structuredClone(args); savedResult = structuredClone(args.p_result); }
    return { data: true, error: null };
  });
  mocks.from.mockImplementation((table: string) => {
    let patch: Record<string, any> | null = null;
    const query: any = {};
    for (const method of ["select", "eq", "gt", "limit"]) query[method] = () => query;
    query.update = (value: Record<string, any>) => { patch = structuredClone(value); return query; };
    const result = () => {
      if (table === "intelligence_jobs" && patch) {
        checkpoints.push(structuredClone(patch.result));
        if (failAnswerCheckpoint && patch.result.parts?.length) {
          failAnswerCheckpoint = false;
          return { data: null, error: { code: "synthetic_checkpoint_failure" } };
        }
        savedResult = structuredClone(patch.result);
        return { data: { id: "job" }, error: null };
      }
      return { data: table === "intelligence_config" ? { enabled: true } : table === "intelligence_views" ? []
        : table === "intelligence_observations" ? observation : table === "companies" ? company : null, error: null };
    };
    query.single = query.maybeSingle = async () => result();
    query.then = (resolve: any) => Promise.resolve(result()).then(resolve);
    return query;
  });
  mocks.durable.mockImplementation(async ({ fingerprint, execute }: { fingerprint: string; execute: () => Promise<EvaluateEvidenceResult> }) => {
    // A request identity must be durable before any paid dispatch or cache lookup.
    expect(savedResult?.pendingRequest?.fingerprint).toBe(fingerprint);
    const existing = nativeCache.get(fingerprint);
    if (existing) return { status: "complete", evaluation: structuredClone(existing), reused: true };
    const result = await execute();
    nativeCache.set(fingerprint, structuredClone(result));
    return { status: "complete", evaluation: result, reused: false };
  });
});

describe("paid-request intent recovery", () => {
  it("reuses the original paid request after its job checkpoint fails despite new company context and feedback", async () => {
    failAnswerCheckpoint = true;
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { checkpoint_or_service_error: 1 } });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(completion).toBeNull();
    expect(savedResult?.parts).toHaveLength(0);
    const original = structuredClone(savedResult?.pendingRequest) as PendingRequest;
    expect(original).toMatchObject({ start: 0, end: observation.evidence_text.length, input: { questionPack: "business-services-v3" } });
    expect(original.fingerprint).toBe(evidenceRequestFingerprint(original.input));

    company.name = "Synthetic Consulting Updated";
    company.subindustry = "Media & Publishing";
    const newFeedback = [{ text: "New reference", correction: "Additional entity identity information." }];
    mocks.feedback.mockResolvedValue(newFeedback);
    mocks.identity.mockResolvedValue({ context: "Authorized identity: new business address, 24 Main St." });
    mocks.publicScale.mockReturnValue({ text: "Public source: three locations.", citations: [] });
    expect(evidenceRequestFingerprint({ ...original.input, companyName: String(company.name), feedbackExamples: newFeedback })).not.toBe(original.fingerprint);

    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { complete: 1 } });
    expect(mocks.feedback).toHaveBeenCalledTimes(2);
    expect(mocks.durable).toHaveBeenCalledTimes(2);
    expect(mocks.durable.mock.calls.map(([args]) => args.fingerprint)).toEqual([original.fingerprint, original.fingerprint]);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    const { abortSignal: _signal, ...actualInput } = mocks.evaluate.mock.calls[0][0];
    expect(actualInput).toEqual(original.input);
    expect(savedResult?.pendingRequest).toBeUndefined();
    expect(savedResult?.parts[0].evaluation).toEqual(evaluation);
  });

  it("retains a newly checkpointed request while its exact durable request is busy", async () => {
    mocks.durable.mockImplementation(async ({ fingerprint }) => {
      expect(savedResult?.pendingRequest?.fingerprint).toBe(fingerprint);
      return { status: "busy" };
    });
    expect(await runIntelligenceWorker(1)).toMatchObject({ outcomes: { request_in_progress: 1 } });
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(checkpoints).toHaveLength(1);
    expect(savedResult?.pendingRequest).toEqual(checkpoints[0].pendingRequest);
    expect(completion).toMatchObject({ p_status: "queued", p_retry_seconds: 30,
      p_result: { pendingRequest: { start: 0, end: observation.evidence_text.length, input: { questionPack: "business-services-v3" } } } });
  });
});
