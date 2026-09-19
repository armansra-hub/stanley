import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), from: vi.fn(), entity: vi.fn(), match: vi.fn() }));
vi.mock("./http", async (original) => ({ ...await original<typeof import("./http")>(), fetchJson: mocks.fetch }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: vi.fn() }));
vi.mock("./storage", () => ({ saveGovernmentEntity: mocks.entity, saveCompanyGovernmentMatch: mocks.match,
  recordPublicGrowthTriggersBulk: vi.fn(), stableHash: (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex") }));
import { searchSamEntitiesPage } from "./sam";
import { sweepSamCompany } from "./samSweep";
import { parseSamEntityContinuation, samBindingMatches } from "./samEntityState";
import { applyPublicGrowthRetryOutcomes, queuePublicGrowthMainFailures, readPublicGrowthRetryState } from "./sweepState";

const COMPANY = "11111111-1111-4111-8111-111111111111", ENTITY = "22222222-2222-4222-8222-222222222222";
const company = { id: COMPANY, name: "Brand", domain: "brand.test", city: "Austin", state: "TX" };
const row = (name = "Other", uei = "ABCDEFGHIJKL") => ({ entityRegistration: { legalBusinessName: name, ueiSAM: uei, cageCode: "1AB23", dbaName: name === "Legal Company" ? "Brand" : null },
  coreData: { entityInformation: { entityURL: "https://brand.test" }, physicalAddress: { city: "Austin", stateOrProvinceCode: "TX" } } });
let links: unknown[];
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SAM_API_KEY", "test-key"); links = [];
  const q: any = {}; for (const method of ["select", "eq", "limit"]) q[method] = () => q;
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: links, error: null }).then(resolve);
  mocks.from.mockReturnValue(q); mocks.entity.mockResolvedValue(ENTITY); mocks.match.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("SAM source-scoped continuation", () => {
  it("uses the documented CAGE and zero-based page filters without following provider URLs", async () => {
    mocks.fetch.mockResolvedValue({ entityData: [row()], links: { nextLink: "https://other.test/key" } });
    const result = await searchSamEntitiesPage({ cageCode: "1AB23" }, 3);
    const url = new URL(mocks.fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.sam.gov/entity-information/v4/entities");
    expect(url.searchParams.get("cageCode")).toBe("1AB23"); expect(url.searchParams.get("page")).toBe("3");
    expect(result.hasNext).toBe(true); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("finds a supported DBA after the first ten search results and resumes the distinct DBA query", async () => {
    mocks.fetch.mockResolvedValueOnce({ entityData: Array.from({ length: 10 }, (_, i) => row(`Other ${i}`)) })
      .mockResolvedValueOnce({ entityData: [row("Legal Company")] }).mockResolvedValueOnce({ entityData: [] });
    const first = await sweepSamCompany(company);
    expect(first).toMatchObject({ samDone: false, samContinuation: { targetIndex: 0, page: 1 } });
    expect(mocks.entity).not.toHaveBeenCalled();
    const second = await sweepSamCompany(company, { samContinuation: first.samContinuation });
    expect(second).toMatchObject({ status: "matched", entities: 1, samContinuation: { targetIndex: 1, page: 0 } });
    expect(mocks.match.mock.calls[0][2].status).toBe("verified");
    const final = await sweepSamCompany(company, { samContinuation: second.samContinuation });
    expect(final.samDone).toBe(true); expect(final.samContinuation).toBeUndefined();
    expect(new URL(mocks.fetch.mock.calls[2][0]).searchParams.get("dbaName")).toBe("Brand");
  });
  it("accepts a verified CAGE despite a different display name but rejects conflicting UEIs", async () => {
    links = [{ government_entity_id: ENTITY, government_entities: { uei: null, cage_code: "1AB23" } }];
    mocks.fetch.mockResolvedValue({ entityData: [row("Changed Legal Name")] });
    expect(await sweepSamCompany(company)).toMatchObject({ status: "matched", entities: 1 });
    expect(mocks.match).not.toHaveBeenCalled();
    expect(samBindingMatches({ entityId: ENTITY, uei: "ABCDEFGHIJKL", cageCode: "1AB23" }, { uei: "ZZZZZZZZZZZZ", cageCode: "1AB23" })).toBe(false);
  });
  it("retains the current page when persistence fails and preserves it through retry/dead-letter state", async () => {
    mocks.fetch.mockResolvedValue({ entityData: [row("Legal Company")] }); mocks.entity.mockRejectedValue(new Error("write unavailable"));
    const outcome = await sweepSamCompany(company);
    expect(outcome).toMatchObject({ status: "error", samDone: false, samContinuation: { page: 0, targetIndex: 0 } });
    let state = queuePublicGrowthMainFailures({}, [outcome], 1, "2026-09-19T00:00:00Z").cursorPatch;
    expect(readPublicGrowthRetryState(state).retryQueue[0].samContinuation).toEqual(outcome.samContinuation);
    for (let i = 0; i < 2; i++) state = applyPublicGrowthRetryOutcomes(state, state.retryQueue, [outcome], `2026-09-19T00:0${i + 1}:00Z`).cursorPatch;
    expect(state.deadLetters[0].samContinuation).toEqual(outcome.samContinuation);
  });
  it("queues successful partial pages without consuming the failure budget and rejects changed bindings", async () => {
    mocks.fetch.mockResolvedValue({ entityData: [] });
    const partial = await sweepSamCompany(company);
    const state = queuePublicGrowthMainFailures({}, [partial], 0, "2026-09-19T00:00:00Z").cursorPatch;
    expect(state.retryQueue[0]).toMatchObject({ failureAttempts: 0, samContinuation: partial.samContinuation });
    const binding = { entityId: ENTITY, uei: "ABCDEFGHIJKL", cageCode: "1AB23" };
    const continuation = parseSamEntityContinuation({ version: 1, companyId: COMPANY, targets: [{ query: { cageCode: "1AB23" }, binding }], targetIndex: 0, page: 0, lastPageHash: null }, COMPANY);
    const changed = await sweepSamCompany(company, { samContinuation: continuation });
    expect(changed).toMatchObject({ status: "error", error: "frozen SAM entity binding changed" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
