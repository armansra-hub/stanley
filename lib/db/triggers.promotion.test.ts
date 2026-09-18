import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), reheat: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/reheat", () => ({ reheatCompanyForFreshSignal: mocks.reheat }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
import { promoteCandidate } from "./triggers";

const candidate = { id: "candidate", company_id: "company", verdict: "keep", promoted_trigger_id: null,
  type: "press", summary: "Example Engineering opened a new facility", source_name: "Company news",
  source_url: "https://example.test/news/new-facility", signal_date: "2026-09-17" };
const trigger = { id: "exact-trigger", company_id: "company", type: "press", summary: candidate.summary,
  source_url: candidate.source_url, source_name: candidate.source_name, signal_date: candidate.signal_date,
  detected_at: "2026-09-17T12:00:00Z", strength: 50, half_life_days: 60, metadata: {} };
type Call = { table: string; operation?: string; patch?: Record<string, unknown>; filters: unknown[][] };
let calls: Call[];
let missingReceipt: boolean;
let stale: boolean;

beforeEach(() => {
  calls = []; missingReceipt = false; stale = false;
  mocks.reheat.mockReset().mockResolvedValue(false);
  mocks.from.mockReset().mockImplementation((table: string) => {
    const call: Call = { table, filters: [] }; calls.push(call);
    const result = (single: boolean) => {
      if (call.operation === "insert") return { data: null, error: { code: "23505" } }; // Prior worker inserted it.
      if (table === "trigger_candidates") return { data: call.operation === "update" ? (stale ? null : { id: candidate.id }) : candidate, error: null };
      if (table === "triggers") return { data: single ? (missingReceipt ? null : trigger) : [trigger], error: null };
      return { data: call.operation === "update" ? null : { id: "company", status: "new", lists: ["netsuite_tam"] }, error: null };
    };
    const query: Record<string, unknown> = {};
    for (const op of ["select", "eq", "is", "gt", "limit", "order"]) query[op] = (...args: unknown[]) => { call.filters.push([op, ...args]); return query; };
    for (const op of ["insert", "update"]) query[op] = (patch: Record<string, unknown>) => { call.operation = op; call.patch = patch; return query; };
    query.maybeSingle = async () => result(true);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result(false)).then(resolve);
    return query;
  });
});

describe("leased trigger publication recovery", () => {
  it("recovers the exact source receipt after an accepted insert without selecting a newer same-type trigger", async () => {
    expect(await promoteCandidate("candidate", { leaseToken: "lease" })).toBe(true);
    const receipt = calls.find(call => call.table === "triggers" && call.filters.some(filter => filter[1] === "source_url"))!;
    expect(receipt.filters).toContainEqual(["eq", "company_id", "company"]);
    expect(receipt.filters).toContainEqual(["eq", "type", "press"]);
    expect(receipt.filters).toContainEqual(["eq", "source_url", candidate.source_url]);
    expect(receipt.filters.some(filter => filter[0] === "order")).toBe(false);
    const completed = calls.find(call => call.patch?.promoted_trigger_id)!;
    expect(completed.patch?.promoted_trigger_id).toBe("exact-trigger");
    expect(completed.filters).toContainEqual(["eq", "review_lease_token", "lease"]);
    expect(completed.filters).toContainEqual(["gt", "review_lease_until", expect.any(String)]);
    expect(mocks.reheat).toHaveBeenCalledWith("company", "press", candidate.source_url, candidate.signal_date, { strict: true });
  });
  it("leaves a kept candidate recoverable when the exact trigger receipt is unavailable", async () => {
    missingReceipt = true;
    await expect(promoteCandidate("candidate", { leaseToken: "lease" })).rejects.toThrow("exact trigger receipt");
    expect(calls.some(call => call.patch?.promoted_trigger_id)).toBe(false);
  });
  it("does not report completion after losing the publication lease", async () => {
    stale = true;
    await expect(promoteCandidate("candidate", { leaseToken: "lease" })).rejects.toThrow("checkpoint was not confirmed");
  });
});
