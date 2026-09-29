import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn(), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { classifyCustomerReference, runCustomerReferenceReading, type ReferenceCheckpoint } from "./customerReferenceResearch";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS } from "./operatingCatalog";
import { customerReferenceCatalogSources, customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
import { catalogPackets } from "./operatingCoverage";
import { CUSTOMER_REFERENCE_RECOVERY_VERSION, customerReferencePassages } from "./customerReferenceRecovery";
import type { NativeJevInput } from "./nativeJev";
import type { CustomerReferenceRegistryRow } from "./customerReferenceRegistry";
const capturedText = "The company's own installation, hardware and managed service operations.";
const seed = (id: string): CustomerReferenceSeed => ({ id, name: `Company ${id}`, domain: "acme.com", website: "https://acme.com/",
  announcementDate: "2026-09-24", announcementType: "new_customer", sources: [{ id: "home", url: "https://acme.com/", title: "Acme services", text: capturedText,
    contentHash: createHash("sha256").update(capturedText).digest("hex"), observedAt: "2026-09-28T00:00:00Z" }] });
const row = (id: string, completed = false): CustomerReferenceRegistryRow => {
  const full = seed(id);
  return { id, name: full.name, domain: full.domain, website: full.website, announcement_date: full.announcementDate,
    announcement_type: full.announcementType, buying_program_id: null, comparison_industry: null, identity_notes: [],
    candidate_urls: [], sources: full.sources.map(({ text: _text, ...proof }) => proof), source_status: "ready", source_checkpoint: null,
    source_lease_until: null, active: true, as_of: "2026-09-24", created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z",
    native_status: completed ? "complete" : null, native_catalog_version: completed ? OPERATING_CATALOG_VERSION : null,
    native_evidence_key: completed ? customerReferenceEvidenceKey(full) : null, native_answered: completed ? 47 : 0 };
};
function store(registryRows: CustomerReferenceRegistryRow[], nativeById = new Map<string, any>()) {
  const operations: { table: string; action: string; value?: any; filters: [string, unknown][] }[] = [];
  const db = { from: vi.fn((table: string) => {
    const operation = { table, action: "read", value: undefined as any, filters: [] as [string, unknown][] };
    operations.push(operation);
    const chain: any = {};
    chain.update = (value: any) => { operation.action = "update"; operation.value = value; return chain; };
    chain.upsert = async (value: any) => { operation.action = "upsert"; operation.value = value; return { error: null }; };
    chain.select = () => chain;
    for (const key of ["eq", "neq", "or", "gt"]) chain[key] = (column: string, value: unknown) => { operation.filters.push([column, value]); return chain; };
    chain.maybeSingle = async () => {
      const id = operation.filters.find(([key]) => key === "id")?.[1];
      if (table === "intelligence_customer_reference_registry" && operation.value?.source_status === "running") {
        return { data: { ...registryRows.find(row => row.id === id)!, sources: [], native_status: undefined }, error: null };
      }
      if (operation.action === "read") {
        if (nativeById.has(String(id))) return { data: structuredClone(nativeById.get(String(id))), error: null };
        const saved = registryRows.find(row => row.id === id);
        return { data: saved?.native_status === "blocked" ? { id, status: "blocked", catalog_version: saved.native_catalog_version,
          evidence_key: saved.native_evidence_key, checkpoint: null } : null, error: null };
      }
      if (operation.value?.lease_token) return { data: { checkpoint: structuredClone(nativeById.get(String(id))?.checkpoint ?? null) }, error: null };
      if (operation.value?.checkpoint && nativeById.has(String(id))) {
        const saved = { ...nativeById.get(String(id)), ...structuredClone(operation.value) };
        nativeById.set(String(id), saved);
        const registry = registryRows.find(row => row.id === id)!;
        registry.native_status = saved.status; registry.native_last_error = saved.checkpoint.lastError;
        registry.native_answered = Object.keys(saved.checkpoint.answers).length;
      }
      return { data: { id }, error: null };
    };
    return chain;
  }) };
  return { db: db as any, operations };
}

describe("full registry foreground reference runner", () => {
  it("admits a proven packed final, memoizes an oversized negative under lease, and skips both on a cold pass", async () => {
    const makeHeld = (id: string, uniqueLines: number) => {
      const shared = Array.from({ length: 360 }, (_, i) =>
        `Shared policy ${i}: Our licensed work remains subject to its original definitions, roles, restrictions, attribution and exceptions.\r\n`).join("");
      const full: CustomerReferenceSeed = { ...seed(id), sources: ["alpha", "beta"].map(key => {
        const text = shared + Array.from({ length: uniqueLines }, (_, i) =>
          `Specific ${key} operation ${i}: We provide separately documented service agreements with customer equipment and project schedules.\n`).join("");
        return { id: key, url: `https://acme.com/${key}`, title: key, text,
          contentHash: createHash("sha256").update(text).digest("hex"), observedAt: "2026-09-28T00:00:00Z" };
      }) };
      const packets = catalogPackets(customerReferenceCatalogSources(full));
      const checkpoint: ReferenceCheckpoint = { version: 1, evidenceKey: customerReferenceEvidenceKey(full), phase: "answer", mapped: {},
        answers: Object.fromEntries(OPERATING_FACETS.filter(f => f.id !== "rr_c11").map(f => [f.id,
          { decision: "insufficient_evidence", facetVersion: "paid", sourceUrls: [], nativeResult: { paid: f.id } }])),
        requests: 50, reused: 0, inputTokens: 1234, outputTokens: 56, lastError: "customer_context_relevant_evidence_still_large",
        contextRecovery: { version: CUSTOMER_REFERENCE_RECOVERY_VERSION, facetId: "rr_c11", packetIds: packets.map(p => p.id), origin: "local_planning_limit",
          decisions: Object.fromEntries(customerReferencePassages(packets).map(p => [p.id, { answer: { type: "choice", choice: "candidate" },
            requestFingerprint: `paid-${p.id}`, receiptFingerprint: `receipt-${p.id}` }])) } };
      const compact: CustomerReferenceRegistryRow = { ...row(id), sources: full.sources.map(({ text: _text, ...proof }) => proof),
        native_status: "blocked", native_catalog_version: OPERATING_CATALOG_VERSION, native_evidence_key: checkpoint.evidenceKey,
        native_last_error: checkpoint.lastError, native_answered: 46 };
      return { full, compact, checkpoint };
    };
    const ready = makeHeld("fits", 50), large = makeHeld("oversized", 500), rows = [ready.compact, large.compact];
    const originals = new Map([ready, large].map(item => [item.full.id, structuredClone(item.checkpoint)]));
    const native = new Map([ready, large].map(item => [item.full.id, { id: item.full.id, status: "blocked", catalog_version: OPERATING_CATALOG_VERSION,
      evidence_key: item.checkpoint.evidenceKey, checkpoint: item.checkpoint, result: null }]));
    const h = store(rows, native), getRow = vi.fn(async (id: string) => {
      const item = id === ready.full.id ? ready : large; return { ...item.compact, sources: item.full.sources };
    });
    const evaluate = vi.fn(async (input: NativeJevInput) => {
      expect(Object.keys(input.questions)).toEqual(["rr_c11"]);
      return { status: "complete" as const, reused: false, evaluation: { ok: true as const, usage: { inputTokens: 10, outputTokens: 1 },
        provider_result: { model: "jev-1.13.0", answers: { rr_c11: { type: "choice" as const, choice: "supported" } } } } };
    });
    const classify: typeof classifyCustomerReference = (full, checkpoint, deadline, deps) => classifyCustomerReference(full, checkpoint, deadline, { ...deps, evaluate });
    const result = await runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows, getRow, classify });
    expect(result).toMatchObject({ processed: 2, completed: 1, requests: 1, inputTokens: 10 });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(native.get("fits")!.status).toBe("complete");
    const negative = native.get("oversized")!.checkpoint;
    expect(negative.packedPlanningReview).toMatchObject({ version: "packed-final-96-v1", evidenceKey: large.checkpoint.evidenceKey, eligible: false,
      previousError: "customer_context_relevant_evidence_still_large" });
    expect(negative.lastError).toBe("customer_context_relevant_evidence_still_large_packed96_v1");
    expect(negative.answers).toEqual(originals.get("oversized")!.answers);
    expect(negative.contextRecovery).toEqual(originals.get("oversized")!.contextRecovery);
    const proofWrite = h.operations.find(op => op.value?.checkpoint?.packedPlanningReview);
    expect(proofWrite?.filters.some(([key]) => key === "lease_token")).toBe(true);
    expect(proofWrite?.filters).toContainEqual(["evidence_key", large.checkpoint.evidenceKey]);
    const cold = store(rows, native); getRow.mockClear(); evaluate.mockClear();
    expect(await runCustomerReferenceReading(Date.now() + 120_000, { ...cold, registry: async () => rows, getRow, classify }))
      .toMatchObject({ processed: 0, completed: 0, requests: 0 });
    expect(getRow).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled(); expect(cold.operations).toEqual([]);
  });

  it("processes an eligible customer beyond the first thousand and never regrades unchanged completed references", async () => {
    const rows = [...Array.from({ length: 1_001 }, (_, index) => row(String(index).padStart(4, "0"), true)), row("last-new")];
    const h = store(rows), registry = vi.fn(async () => rows), getRow = vi.fn(async (id: string) => ({ ...row(id), sources: seed(id).sources }));
    const classify = vi.fn(async (_seed: CustomerReferenceSeed) => "complete" as const), collect = vi.fn();
    const result = await runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry, getRow, classify, collect });
    expect(result).toMatchObject({ processed: 1, completed: 1, stoppedBy: "references_exhausted" });
    expect(getRow).toHaveBeenCalledTimes(1); expect(getRow).toHaveBeenCalledWith("last-new");
    expect(classify).toHaveBeenCalledTimes(1); expect(classify.mock.calls[0][0].id).toBe("last-new");
    expect(collect).not.toHaveBeenCalled();
    expect(h.operations.every(operation => operation.filters.every(([column, value]) => column !== "id" || value === "last-new"))).toBe(true);
  });

  it("resumes started customer work before a newer fresh customer and preserves usage from confirmed checkpoints", async () => {
    const prior = { ...row("unfinished"), native_answered: 2, announcement_date: "2024-01-01" };
    const rows = [row("fresh"), prior], h = store(rows);
    const classify = vi.fn(async (_seed: CustomerReferenceSeed, _previous: ReferenceCheckpoint | null, _deadline: number, deps: any) => {
      await deps.save({ version: 1, evidenceKey: "key", phase: "direct", mapped: {}, answers: {}, requests: 2, reused: 1, inputTokens: 300, outputTokens: 40 }, "pending", null, "reference_continuation");
      return "continued" as const;
    });
    const result = await runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows,
      getRow: async id => ({ ...row(id), sources: seed(id).sources }), classify });
    expect(classify.mock.calls[0][0].id).toBe("unfinished"); expect(classify).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stoppedBy: "continued", requests: 4, reused: 2, inputTokens: 600, outputTokens: 80, concurrency: 2 });
  });

  it("collects and saves an exact customer's raw website sources before classification", async () => {
    const rows = [{ ...row("new-source"), source_status: "pending" as const, sources: [] }], h = store(rows);
    const collect = vi.fn(async (input: any, _previous: any, _deadline: number, deps: any) => {
      const capture = { status: "ready" as const, sources: seed(input.id).sources,
        checkpoint: { version: 1 as const, queue: [], attempts: {}, sourceGaps: [] }, outcome: "ready" as const };
      expect(await deps.save(capture)).toBe(true); return capture;
    });
    const classify = vi.fn(async (_seed: CustomerReferenceSeed) => "complete" as const);
    const result = await runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows, collect, classify });
    expect(collect).toHaveBeenCalledTimes(1); expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0].sources[0].text).toBe(capturedText);
    expect(result).toMatchObject({ captured: 1, completed: 1 });
    const persisted = h.operations.find(operation => operation.table === "intelligence_customer_reference_registry" && operation.value?.source_status === "ready");
    expect(persisted?.value.sources[0].text).toBe(capturedText);
    expect(persisted?.filters.some(([column]) => column === "source_lease_token")).toBe(true);
  });

  it("does not spin on source gaps, permanent provider rejections or a current provider hold", async () => {
    const rows = [{ ...row("source-blocked"), source_status: "blocked" as const }, { ...row("provider-blocked", true), native_status: "blocked", native_last_error: "typesafe_http_400" }, row("hold")];
    const h = store(rows), getRow = vi.fn(async (id: string) => ({ ...row(id), sources: seed(id).sources }));
    const classify = vi.fn(async () => "provider_hold" as const), collect = vi.fn();
    const result = await runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows, getRow, classify, collect });
    expect(result.stoppedBy).toBe("provider_hold"); expect(classify).toHaveBeenCalledTimes(1);
    expect(getRow).toHaveBeenCalledTimes(2); expect(getRow).toHaveBeenCalledWith("hold"); expect(collect).not.toHaveBeenCalled();
  });

  it("overlaps exactly two different customers and never dispatches the third after a global hold", async () => {
    const rows = [row("a"), row("b"), row("c")], h = store(rows);
    let releaseHealthy!: () => void, releaseHold!: () => void;
    const healthy = new Promise<void>(resolve => { releaseHealthy = resolve; });
    const hold = new Promise<void>(resolve => { releaseHold = resolve; });
    const finished: string[] = [];
    const classify = vi.fn(async (source: CustomerReferenceSeed, _previous: ReferenceCheckpoint | null, _deadline: number, deps: any) => {
      if (source.id === "a") { await hold; return "provider_hold" as const; }
      await healthy;
      await deps.save({ version: 1, evidenceKey: customerReferenceEvidenceKey(source), phase: "answer", mapped: {}, answers: {},
        requests: 1, reused: 0, inputTokens: 100, outputTokens: 1 }, "complete", null, null);
      finished.push(source.id); return "complete" as const;
    });
    let returned = false;
    const run = runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows,
      getRow: async id => ({ ...row(id), sources: seed(id).sources }), classify }).then(value => { returned = true; return value; });
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
    expect(classify.mock.calls.map(call => call[0].id)).toEqual(["a", "b"]);
    releaseHold(); await Promise.resolve(); await Promise.resolve();
    expect(returned).toBe(false); expect(finished).toEqual([]);
    releaseHealthy();
    expect(await run).toMatchObject({ processed: 2, completed: 1, stoppedBy: "provider_hold", requests: 1 });
    expect(finished).toEqual(["b"]); expect(classify).toHaveBeenCalledTimes(2);
    expect(h.operations.some(operation => operation.filters.some(([column, value]) => column === "id" && value === "c"))).toBe(false);
  });

  it("drains a healthy customer checkpoint before rejecting another lane's storage failure", async () => {
    const rows = [row("a"), row("b"), row("c")], h = store(rows);
    let fail!: () => void, finish!: () => void;
    const failed = new Promise<void>(resolve => { fail = resolve; }), healthy = new Promise<void>(resolve => { finish = resolve; });
    const saved: string[] = [];
    const classify = vi.fn(async (source: CustomerReferenceSeed) => {
      if (source.id === "a") { await failed; throw new Error("exact_checkpoint_failed"); }
      await healthy; saved.push(source.id); return "complete" as const;
    });
    let rejected = false;
    const run = runCustomerReferenceReading(Date.now() + 120_000, { ...h, registry: async () => rows,
      getRow: async id => ({ ...row(id), sources: seed(id).sources }), classify }).catch(error => { rejected = true; return error; });
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
    fail(); await Promise.resolve(); await Promise.resolve(); expect(rejected).toBe(false);
    finish(); expect((await run).message).toBe("exact_checkpoint_failed");
    expect(saved).toEqual(["b"]); expect(classify).toHaveBeenCalledTimes(2);
  });
});
