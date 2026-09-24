import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATING_CATALOG_VERSION, OPERATING_FACETS, operatingFacetQuestion } from "./operatingCatalog";
import { catalogAnswerPlans, catalogFacetVersion, catalogNativeResult, catalogPackets, catalogRetryAt, runOperatingCoverage,
  type CatalogCheckpoint, type CatalogSnapshot, type CatalogSource } from "./operatingCoverage";
import { nativeJevBody, nativeJevFingerprint, type NativeJevInput } from "./nativeJev";

const company = { id: "company", name: "Synthetic Services", domain: "synthetic.test", subindustry: null };
const sources: CatalogSource[] = [
  { id: "a", content_hash: "hash-a", source_url: "https://synthetic.test/projects", title: "Projects", source_kind: "website",
    event_date: null, observed_at: "2026-09-24T01:00:00Z", evidence_text: "Synthetic Services implements individual technology projects for customers." },
  { id: "b", content_hash: "hash-b", source_url: "https://synthetic.test/managed", title: "Managed operations", source_kind: "website",
    event_date: null, observed_at: "2026-09-24T01:00:00Z", evidence_text: "The same company also provides ongoing managed operations and support." },
];
const publicFacets = OPERATING_FACETS.filter(f => operatingFacetQuestion(f.id));
afterEach(() => vi.restoreAllMocks());

function harness(rows = sources, researchDue = false) {
  const saved = new Map<string, any>(); const writes: any[] = [];
  let checkpoint: CatalogCheckpoint | null = null;
  const snapshot = (): CatalogSnapshot => ({ evidenceKey: "stable-evidence-key", company,
    sources: rows.map(row => ({ id: row.id, contentHash: row.content_hash, url: row.source_url, title: row.title,
      sourceKind: row.source_kind, eventDate: row.event_date, characters: row.evidence_text.length,
      sourceTruncated: row.metadata?.textTruncated === true })), checkpoint, previousResearch: researchDue ? null : { doneAt: new Date().toISOString(), nextAt: new Date(Date.now() + 86400000).toISOString(), outcome: "caught_up" } });
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === "intelligence_catalog_snapshot") return { data: structuredClone(snapshot()), error: null };
    if (name !== "intelligence_catalog_checkpoint") throw new Error("Unexpected RPC " + name);
    writes.push(structuredClone(args)); checkpoint = structuredClone(args.p_checkpoint);
    for (const row of args.p_facets) saved.set(row.facetId, { facet_id: row.facetId, facet_version: row.facetVersion,
      evidence_key: args.p_evidence_key, status: row.status, decision: row.decision ?? null,
      probability: row.probability ?? null, native_result: row.nativeResult ?? null, citations: row.citations ?? [],
      request_fingerprints: row.requestFingerprints ?? [] });
    return { data: true, error: null };
  });
  const from = vi.fn((table: string) => {
    let selected: string[] | null = null;
    const query: any = { select: () => query, eq: () => query, in: (_key: string, ids: string[]) => { selected = ids; return query; },
      then: (resolve: any) => Promise.resolve({ data: table === "intelligence_catalog_facets" ? [...saved.values()] : rows.filter(row => !selected || selected.includes(row.id)), error: null }).then(resolve) };
    return query;
  });
  const evaluate = vi.fn(async (input: NativeJevInput) => ({ status: "complete" as const, reused: false,
    evaluation: { ok: true as const, usage: { inputTokens: 10, outputTokens: 10 }, provider_result: { model: "jev-1.13.0",
      answers: Object.fromEntries(Object.entries(input.questions).map(([id, q]) => [id, { type: "choice" as const,
        choice: q.type === "choice" && "candidate" in q.criteria ? "candidate" : id === "rr_c02" ? "supported" : "insufficient_evidence" }])) } } }));
  return { saved, writes, rpc, evaluate, db: { rpc, from } as any };
}
const job = { company_id: "company", lease_token: "lease", catalog_requested_version: OPERATING_CATALOG_VERSION };

describe("operating catalog account coverage", () => {
  it("retains every character, including surrogate pairs, across byte-bounded packets", () => {
    const source = { ...sources[0], evidence_text: "中文🙂abc".repeat(80) };
    const packets = catalogPackets([source], 37);
    expect(packets.map(packet => packet.text).join("")).toBe(source.evidence_text);
    expect(packets.every(packet => Buffer.byteLength(packet.text) <= 37)).toBe(true);
    expect(packets[0].citation.start).toBe(0);
    for (let i = 1; i < packets.length; i++) expect(packets[i].citation.start).toBe(packets[i - 1].citation.end);
    expect(packets.at(-1)?.citation.end).toBe(source.evidence_text.length);
  });
  it("byte-packs every public question over shared cross-source evidence without truncation", () => {
    const packets = catalogPackets(sources);
    const { plans, blocked } = catalogAnswerPlans(company, OPERATING_FACETS, packets);
    expect(blocked).toEqual([]);
    expect(plans.flatMap(plan => plan.facetIds)).toEqual(publicFacets.map(f => f.id));
    for (const plan of plans) {
      expect(Object.keys(plan.input.questions).length).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(JSON.stringify(nativeJevBody(plan.input)))).toBeLessThanOrEqual(48_000);
      expect((plan.input.state as any).sources.map((s: any) => s.text)).toEqual(sources.map(s => s.evidence_text));
    }
    expect((plans.find(p => p.facetIds.includes("rr_c02"))!.input.state as any).sources).toHaveLength(2);
  });
  it("does not charge a second contract just because capture clocks changed", () => {
    const first = catalogAnswerPlans(company, publicFacets.slice(0, 2), catalogPackets(sources)).plans[0].input;
    const later = catalogAnswerPlans(company, publicFacets.slice(0, 2), catalogPackets(sources.map(s => ({ ...s, observed_at: "2026-10-01T00:00:00Z" })))).plans[0].input;
    expect(nativeJevFingerprint(later)).toBe(nativeJevFingerprint(first));
    const changed = catalogAnswerPlans(company, publicFacets.slice(0, 2), catalogPackets([{ ...sources[0], evidence_text: "A different business model", content_hash: "new-hash" }, sources[1]])).plans[0].input;
    expect(nativeJevFingerprint(changed)).not.toBe(nativeJevFingerprint(first));
  });
  it("returns an oversized facet as unprocessed rather than trimming its source corpus", () => {
    const packets = catalogPackets([{ ...sources[0], evidence_text: "x".repeat(100_000) }]);
    const plan = catalogAnswerPlans(company, publicFacets.slice(0, 1), packets);
    expect(plan.plans).toEqual([]); expect(plan.blocked).toEqual([publicFacets[0].id]);
    expect(packets.reduce((n, p) => n + p.text.length, 0)).toBe(100_000);
  });
  it("preserves native choices without inventing a probability or validating semantics again", () => {
    const answer = { type: "choice" as const, choice: "supported", confidence: 0.37 };
    const result = catalogNativeResult(publicFacets[0], answer, catalogPackets(sources), "jev-1.13.0", "raw", "scoped");
    expect(result.probability).toBeNull(); expect(result.decision).toBe("supported");
    expect((result.nativeResult as any).answer).toBe(answer);
    expect(result.citations?.map(c => c.observationId)).toEqual(["a", "b"]);
    expect(() => catalogNativeResult(publicFacets[0], { type: "choice", choice: "missing" }, [], "jev", "x", "y")).toThrow("catalog_answer_missing_or_invalid");
  });
  it("evaluates all47 public facets and reuses exact answers", async () => {
    const h = harness();
    const result = await runOperatingCoverage(job, Date.now() + 120_000, h);
    expect(result.outcome).toBe("catalog_complete"); expect(h.saved.size).toBe(47);
    expect([...h.saved.values()].filter(r => r.status === "answered")).toHaveLength(47);
    expect(h.saved.has("rr_o06")).toBe(false);
    expect(h.saved.get("rr_c02")).toMatchObject({ decision: "supported", probability: null });
    const paid = h.evaluate.mock.calls.length;
    expect(paid).toBeGreaterThan(0); expect(paid).toBeLessThan(10);
    expect(h.writes.filter(w => w.p_checkpoint.pending).every(w => w.p_terminal === false)).toBe(true);
    await runOperatingCoverage(job, Date.now() + 120_000, h);
    expect(h.evaluate).toHaveBeenCalledTimes(paid);
  });
  it("keeps source-unavailable accounts distinct from native unknown and performs no paid request", async () => {
    const h = harness([]);
    expect((await runOperatingCoverage(job, Date.now() + 90_000, h)).outcome).toBe("catalog_source_blocked");
    expect(h.evaluate).not.toHaveBeenCalled();
    expect([...h.saved.values()].filter(r => r.status === "blocked")).toHaveLength(47);
    expect([...h.saved.values()].filter(r => r.decision === "insufficient_evidence")).toHaveLength(0);
  });
  it("requests initial gap research for a newly admitted account with no retained sources", async () => {
    const h = harness([], true);
    expect(await runOperatingCoverage(job, Date.now() + 90_000, h)).toMatchObject({ outcome: "catalog_needs_research", answered: 0,
      researchFacets: publicFacets.map(facet => facet.id) });
    expect(h.evaluate).not.toHaveBeenCalled();
  });
  it("preserves pending request on budget hold and obeys the absolute reset, including null authorization holds", async () => {
    const h = harness();
    h.evaluate.mockResolvedValueOnce({ status: "budget_deferred", reason: "daily_limit", retryAt: "2026-09-25T07:00:00Z" } as any);
    expect((await runOperatingCoverage(job, Date.now() + 90_000, h)).outcome).toBe("catalog_budget_deferred");
    expect(h.writes.at(-1)).toMatchObject({ p_terminal: true, p_retry_at: "2026-09-25T07:00:00.000Z", p_summary: { status: "blocked", lastError: "daily_limit" } });
    expect(h.writes.at(-1).p_checkpoint.pending).toBeTruthy();
    expect(catalogRetryAt(null)).toBeNull(); expect(catalogRetryAt("invalid")).toBeNull();
  });
  it("checkpoints completed batches across deadline continuation without repeating them", async () => {
    const h = harness(); const started = Date.now(); let clock = started;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const original = h.evaluate.getMockImplementation()!;
    h.evaluate.mockImplementation(async (...args) => { const response = await original(...args); clock = started + 70_000; return response; });
    const first = await runOperatingCoverage(job, started + 90_000, h);
    expect(first.outcome).toBe("catalog_continued");
    const answered = [...h.saved.values()].filter(r => r.status === "answered").map(r => r.facet_id);
    expect(answered.length).toBeGreaterThan(0); expect(answered.length).toBeLessThan(47);
    const firstQuestions = h.evaluate.mock.calls[0][0].questions;
    clock = started; h.evaluate.mockImplementation(original);
    expect((await runOperatingCoverage(job, started + 120_000, h)).outcome).toBe("catalog_complete");
    for (const [input] of h.evaluate.mock.calls.slice(1)) expect(Object.keys(input.questions).some(id => id in firstQuestions)).toBe(false);
  });
  it("does not call the provider after losing the exact snapshot checkpoint gate", async () => {
    const h = harness(); const original = h.rpc.getMockImplementation()!;
    h.rpc.mockImplementation(async (name, args) => name === "intelligence_catalog_checkpoint" ? { data: false, error: null } : original(name, args));
    expect((await runOperatingCoverage(job, Date.now() + 90_000, h)).outcome).toBe("catalog_stale");
    expect(h.evaluate).not.toHaveBeenCalled();
  });
});
