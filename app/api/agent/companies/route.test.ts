import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reads: [] as unknown[][],
  insert: vi.fn(async (_rows: Record<string, unknown>[]) => ({ error: null })),
  upsert: vi.fn(async (_rows: Record<string, unknown>[], _options?: Record<string, unknown>) => ({ error: null })),
  logEvent: vi.fn(),
}));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: () => true, callerAgent: () => "codex", unauthorized: vi.fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ in: async () => ({ data: mocks.reads.shift() ?? [], error: null }) }),
      insert: mocks.insert,
      upsert: mocks.upsert,
    }),
  }),
}));
import { POST } from "./route";

const existing = (patch: Record<string, unknown> = {}) => ({
  id: "old-company", name: "Existing", domain: "shared.example", website_raw: "https://shared.example",
  lists: [], sources: [], status: "new", netsuite_internal_id: null,
  tam_score: 63, record_digest: "Preserved history", ...patch,
});
async function request(body: Record<string, unknown>) {
  return POST(new Request("https://stanley.local/api/agent/companies", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
}
beforeEach(() => { mocks.reads = []; vi.clearAllMocks(); });

describe("exact-ID TAM refresh", () => {
  it("retires only canonical membership while preserving the immutable duplicate row", async () => {
    mocks.reads = [[existing({ netsuite_internal_id: "123", lists: ["netsuite_tam", "custom"] }),
      existing({ id: "retired", netsuite_internal_id: "123", lists: ["tam_duplicate"] })]];
    const response = await request({ action: "retire_membership", exactIdsOnly: true, internalIds: ["123"] });
    expect(await response.json()).toMatchObject({ exactIdsOnly: true, companyRowsToRetire: 1, written: 1, missingInternalIds: [] });
    expect(mocks.upsert).toHaveBeenCalledWith([
      expect.objectContaining({ id: "old-company", lists: ["custom", "tam_removed"], status: "removed_from_tam" }),
    ], { onConflict: "id" });
  });

  it("reports strict retirement counts without writing in dry run", async () => {
    mocks.reads = [[existing({ netsuite_internal_id: "123" }),
      existing({ id: "retired", netsuite_internal_id: "123", lists: ["tam_duplicate"] })]];
    const response = await request({ action: "retire_membership", exactIdsOnly: true, dryRun: true, internalIds: ["123"] });
    expect(await response.json()).toMatchObject({ exactIdsOnly: true, companyRowsToRetire: 1, dryRun: true });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a misspelled strict-mode flag instead of falling back to domain adoption", async () => {
    const response = await request({ exactIdsOnly: "true", rows: [{ internalId: "123", name: "New" }] });
    expect(response.status).toBe(422);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("creates an independent lead instead of adopting an unbound same-domain company", async () => {
    mocks.reads = [[], [existing()]];
    const response = await request({ exactIdsOnly: true, rows: [{ internalId: "123", name: "New lead", website: "https://shared.example" }] });
    expect(response.status).toBe(200);
    expect((await response.json()).adoptedByUnboundDomain).toEqual([]);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledWith([expect.objectContaining({
      netsuite_internal_id: "123", domain: null, website_raw: "https://shared.example", lists: ["netsuite_tam"],
    })]);
  });

  it("keeps legacy domain adoption when the flag is absent", async () => {
    mocks.reads = [[], [existing()]];
    const response = await request({ rows: [{ internalId: "123", name: "New lead", website: "https://shared.example" }] });
    expect((await response.json()).adoptedByUnboundDomain).toEqual(["123"]);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith([expect.objectContaining({ id: "old-company", netsuite_internal_id: "123" })], { onConflict: "id" });
  });

  it("preserves both exact IDs when new rows share a website in the same batch", async () => {
    mocks.reads = [[], []];
    const response = await request({ exactIdsOnly: true, rows: [
      { internalId: "123", name: "First", website: "https://shared.example" },
      { internalId: "124", name: "Second", website: "https://shared.example" },
    ] });
    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith([
      expect.objectContaining({ netsuite_internal_id: "123", domain: "shared.example" }),
      expect.objectContaining({ netsuite_internal_id: "124", domain: null, website_raw: "https://shared.example" }),
    ]);
  });

  it("updates only the canonical exact-ID row and leaves retired history and scores untouched", async () => {
    mocks.reads = [[existing({ netsuite_internal_id: "123" }), existing({ id: "retired", netsuite_internal_id: "123", lists: ["tam_duplicate"] })]];
    const response = await request({ exactIdsOnly: true, rows: [{ internalId: "123", name: "Refreshed" }] });
    expect(response.status).toBe(200);
    const update = mocks.upsert.mock.calls[0][0] as unknown as Record<string, unknown>[];
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({ id: "old-company", name: "Refreshed" });
    expect(update[0]).not.toHaveProperty("tam_score");
    expect(update[0]).not.toHaveProperty("record_digest");
  });

  it("fails before any write when an exact ID has multiple canonical rows", async () => {
    mocks.reads = [[existing({ netsuite_internal_id: "123" }), existing({ id: "second", netsuite_internal_id: "123" })]];
    const response = await request({ exactIdsOnly: true, rows: [{ internalId: "123", name: "Refreshed" }] });
    expect(response.status).toBe(409);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reports the exact-ID insert in dry run without writing", async () => {
    mocks.reads = [[], [existing()]];
    const response = await request({ exactIdsOnly: true, dryRun: true, rows: [{ internalId: "123", name: "New", website: "https://shared.example" }] });
    expect(await response.json()).toMatchObject({ exactIdsOnly: true, companyRowsToInsert: 1, adoptedByUnboundDomain: [] });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
