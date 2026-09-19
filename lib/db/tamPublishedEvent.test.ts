import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
import { getTamPublishedEvent } from "./tamCoordination";
const input = { runSlug: "test-run", netsuiteInternalId: "123", provenanceSha256: "a".repeat(64) };
beforeEach(() => {
  vi.clearAllMocks();
  const chain = { select: mocks.select, eq: mocks.eq, order: mocks.order, limit: mocks.limit, maybeSingle: mocks.maybeSingle };
  mocks.from.mockReturnValue(chain); mocks.select.mockReturnValue(chain); mocks.eq.mockReturnValue(chain); mocks.order.mockReturnValue(chain);
  mocks.maybeSingle.mockResolvedValue({ data: { id: "run-id" }, error: null });
  mocks.limit.mockResolvedValue({ data: [], error: null });
});
describe("exact published TAM event read", () => {
  it("filters exact run, ID, publication kind and provenance, with one compact result", async () => {
    mocks.limit.mockResolvedValue({ data: [{ id: 8, run_id: "run-id", netsuite_internal_id: "123", kind: "grade.published", created_at: "2026-09-19", provenance_sha256: input.provenanceSha256 }], error: null });
    const result = await getTamPublishedEvent(input);
    expect(mocks.from.mock.calls).toEqual([["tam_regrade_runs"], ["tam_regrade_events"]]);
    expect(mocks.eq.mock.calls).toEqual([["slug", "test-run"], ["run_id", "run-id"], ["netsuite_internal_id", "123"], ["kind", "grade.published"], ["metadata->>provenance_sha256", input.provenanceSha256]]);
    expect(mocks.select).toHaveBeenLastCalledWith("id,run_id,netsuite_internal_id,kind,created_at,provenance_sha256:metadata->>provenance_sha256");
    expect(mocks.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(mocks.limit).toHaveBeenCalledWith(1);
    expect(result.events[0]).toMatchObject({ kind: "grade.published", netsuite_internal_id: "123", metadata: { provenance_sha256: input.provenanceSha256 } });
    expect(result.events[0]).not.toHaveProperty("provenance_sha256");
  });
  it.each([{ ...input, runSlug: null }, { ...input, runSlug: " " }, { ...input, netsuiteInternalId: "123x" }, { ...input, netsuiteInternalId: null }, { ...input, provenanceSha256: "A".repeat(64) }, { ...input, provenanceSha256: null }])("rejects missing or malformed exact selectors before database access: %o", async (bad) => {
    await expect(getTamPublishedEvent(bad)).rejects.toThrow(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("returns empty events when absent, without broad fallback", async () => { expect(await getTamPublishedEvent(input)).toEqual({ events: [] }); expect(mocks.from).toHaveBeenCalledTimes(2); });
  it("propagates event read failures", async () => { mocks.limit.mockResolvedValue({ data: null, error: { message: "timeout" } }); await expect(getTamPublishedEvent(input)).rejects.toThrow("TAM publication event read failed: timeout"); });
  it("rejects an unknown run before querying events", async () => { mocks.maybeSingle.mockResolvedValue({ data: null, error: null }); await expect(getTamPublishedEvent(input)).rejects.toThrow("run not found"); expect(mocks.from).toHaveBeenCalledTimes(1); });
});
