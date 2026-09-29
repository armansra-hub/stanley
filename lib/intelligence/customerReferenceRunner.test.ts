import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn(), withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
import { runCustomerReferenceReading, type ReferenceCheckpoint } from "./customerReferenceResearch";
import { OPERATING_CATALOG_VERSION } from "./operatingCatalog";
import { customerReferenceEvidenceKey, type CustomerReferenceSeed } from "./customerReferenceSources";
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
function store(registryRows: CustomerReferenceRegistryRow[]) {
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
      if (operation.action === "read") return { data: null, error: null };
      if (operation.value?.lease_token) return { data: { checkpoint: null }, error: null };
      return { data: { id }, error: null };
    };
    return chain;
  }) };
  return { db: db as any, operations };
}

describe("full registry foreground reference runner", () => {
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
    expect(classify.mock.calls[0][0].id).toBe("unfinished"); expect(classify).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stoppedBy: "continued", requests: 2, reused: 1, inputTokens: 300, outputTokens: 40 });
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
    expect(getRow).toHaveBeenCalledTimes(1); expect(getRow).toHaveBeenCalledWith("hold"); expect(collect).not.toHaveBeenCalled();
  });
});
