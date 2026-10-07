import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepFmcsaTam } from "./fmcsaSweep";
import { sweepCoSos } from "./coSosSweep";

const mocks = vi.hoisted(() => ({ pick: vi.fn(), fmcsaChecked: vi.fn(), sosChecked: vi.fn(), trigger: vi.fn(), priority: vi.fn(),
  carrier: vi.fn(), prior: vi.fn(), snapshot: vi.fn(), entities: vi.fn(), ucc: vi.fn(), state: vi.fn() }));
vi.mock("@/lib/db/triggers", () => ({ pickCarriersForRotation: mocks.pick, pickSosCompaniesForRotation: mocks.pick,
  markFmcsaChecked: mocks.fmcsaChecked, markSosChecked: mocks.sosChecked, recordTrigger: mocks.trigger, recomputePriority: mocks.priority }));
vi.mock("@/lib/db/companies", () => ({ normalizeCompanyName: (name: string) => name.toLowerCase() }));
vi.mock("@/lib/triggers/sweep", () => ({ isGenericName: (name: string) => name === "services" }));
vi.mock("@/lib/sources/fmcsa", () => ({ fetchCarrierByName: mocks.carrier }));
vi.mock("@/lib/db/fmcsa", () => ({ getFmcsaSnapshot: mocks.prior, upsertFmcsaSnapshot: mocks.snapshot }));
vi.mock("@/lib/sources/coSos", async original => ({ ...await original<typeof import("@/lib/sources/coSos")>(), fetchNewCoEntities: mocks.entities, fetchRecentUccFilings: mocks.ucc }));
vi.mock("@/lib/intelligence/sourceState", () => ({ writeSourceState: mocks.state }));
vi.mock("./rotationBatches", () => ({ rotationBatches: async function* (load: (n: number) => Promise<unknown[]>) { yield await load(8); } }));

const company = { id: "account-1", name: "Acme Logistics", city: "Denver" };
const carrier = { dot: "123", legal: "Acme Logistics", dba: "", units: 10, drivers: 20, city: "Denver", state: "CO", mcs150: "2026-09-01" };
beforeEach(() => {
  vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.pick.mockResolvedValue([company]); mocks.carrier.mockResolvedValue([carrier]); mocks.prior.mockResolvedValue(null);
  mocks.snapshot.mockResolvedValue(undefined); mocks.entities.mockResolvedValue([]); mocks.ucc.mockResolvedValue([]);
  mocks.state.mockResolvedValue(undefined); mocks.fmcsaChecked.mockResolvedValue(undefined); mocks.sosChecked.mockResolvedValue(undefined);
  mocks.trigger.mockResolvedValue(true); mocks.priority.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("registry capture receipts", () => {
  it("refuses source-only collection before reservations when evidence capture is disabled", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    await expect(sweepFmcsaTam(1, { sourceOnly: true })).rejects.toThrow("requires evidence capture");
    await expect(sweepCoSos(1, { sourceOnly: true })).rejects.toThrow("requires evidence capture");
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("retains FMCSA originals and prior comparison without consuming an unreviewed delta", async () => {
    const prior = { nbr_power_unit: 5, driver_total: 10, captured_at: "2026-09-01T00:00:00Z" };
    const raw = { sourceUrl: "https://data.transportation.gov/resource/kjg3-diqy.json?query=exact", observedAt: "2026-10-07T00:00:00Z", rows: [{ dot_number: "123", legal_name: "Acme Logistics", nbr_power_unit: "10" }] };
    mocks.prior.mockResolvedValue(prior);
    mocks.carrier.mockImplementation(async (_name, _max, options) => { options.onCapture(raw); return [carrier]; });
    expect(await sweepFmcsaTam(1, { sourceOnly: true })).toMatchObject({ sourceOnly: true, succeeded: 1, fleet_growth: 0,
      receipts: [{ companyId: company.id, complete: true, reason: "comparison_captured_for_review" }] });
    expect(mocks.state).toHaveBeenCalledWith(company.id, "fmcsa", expect.objectContaining({ cursor: expect.objectContaining({
      records: [carrier], rawCaptures: [raw], matchedDot: "123", priorSnapshot: prior, priorSnapshotRead: true, comparisonBaselinePreserved: true,
    }) }));
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.priority).not.toHaveBeenCalled();
  });

  it("retains Colorado entity and UCC evidence without publishing inferred registry signals", async () => {
    const entities = [{ id: "E1", name: "Acme Logistics West", type: "LLC", formed: "2026-10-01", city: "Denver", status: "Good Standing" }];
    const filings = [{ filed: "2026-10-01", docType: "UCC financing statement", debtorAsFiled: company.name, debtorCity: "Denver", securedParty: "Bank" }];
    const raw = { sourceUrl: "https://data.colorado.gov/resource/wffy-3uut.json?query=exact", table: "filing", observedAt: "2026-10-07T00:00:00Z", rows: [{ fileid: "F1", filingdate: "2026-10-01", documenttype: "UCC financing statement" }] };
    mocks.entities.mockResolvedValue(entities);
    mocks.ucc.mockImplementation(async (_name, _since, options) => { options.onCapture(raw); return filings; });
    expect(await sweepCoSos(1, { sourceOnly: true })).toMatchObject({ sourceOnly: true, succeeded: 1, triggered: 0, ucc: 0 });
    expect(mocks.state).toHaveBeenCalledWith(company.id, "cosos", expect.objectContaining({ cursor: expect.objectContaining({ entities, filings, rawCaptures: [raw], collectionMode: "source_only" }) }));
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.priority).not.toHaveBeenCalled();
  });

  it("preserves default FMCSA delta publication and baseline advancement", async () => {
    mocks.prior.mockResolvedValue({ nbr_power_unit: 5, driver_total: 10, captured_at: "2026-09-01T00:00:00Z" });
    expect(await sweepFmcsaTam(1)).toMatchObject({ sourceOnly: false, fleet_growth: 1 });
    expect(mocks.trigger).toHaveBeenCalledWith(company.id, expect.objectContaining({ type: "fleet_expansion" }));
    expect(mocks.snapshot).toHaveBeenCalledWith("123", company.name, 10, 20, { strict: true });
    expect(mocks.priority).toHaveBeenCalledWith(company.id);
  });

  it("keeps a valid carrier with nullable metrics partial without storing a zero baseline", async () => {
    mocks.carrier.mockResolvedValue([{ ...carrier, units: null, drivers: null }]);
    expect(await sweepFmcsaTam(1)).toMatchObject({ partial: 1, succeeded: 0, receipts: [{ reason: "fleet_metrics_unavailable", captured: true, complete: false }] });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.fmcsaChecked).not.toHaveBeenCalled();
  });
  it("distinguishes an unavailable FMCSA request, an empty result and a baseline", async () => {
    mocks.carrier.mockRejectedValueOnce(new Error("HTTP 503"));
    expect(await sweepFmcsaTam(1)).toMatchObject({ attempted: 1, unavailable: 1, succeeded: 0,
      receipts: [{ companyId: company.id, complete: false, captured: false, completionStamped: false }] });
    expect(mocks.fmcsaChecked).not.toHaveBeenCalled();
    mocks.carrier.mockResolvedValueOnce([]);
    expect(await sweepFmcsaTam(1)).toMatchObject({ succeeded: 1, matched: 0 });
    expect(mocks.state).toHaveBeenLastCalledWith(company.id, "fmcsa", expect.objectContaining({ complete: true, status: "empty" }));
    expect(await sweepFmcsaTam(1)).toMatchObject({ succeeded: 1, matched: 1, receipts: [{ reason: "baseline_captured", complete: true }] });
  });

  it("does not hide FMCSA snapshot storage failure or stamp completion after it", async () => {
    mocks.snapshot.mockRejectedValue(new Error("snapshot state write failed"));
    expect(await sweepFmcsaTam(1)).toMatchObject({ failed: 1, succeeded: 0, receipts: [{ captured: true, complete: false }] });
    expect(mocks.fmcsaChecked).not.toHaveBeenCalled();
    expect(mocks.state).toHaveBeenCalledWith(company.id, "fmcsa", expect.objectContaining({ complete: false, error: "snapshot_write_failed" }));
  });

  it("reports capped or unsafe FMCSA searches as partial or skipped", async () => {
    mocks.carrier.mockImplementation(async (_name, _max, options) => { options.onTruncated(); return [carrier]; });
    expect(await sweepFmcsaTam(1)).toMatchObject({ partial: 1, receipts: [{ reason: "result_limit_reached", complete: false }] });
    expect(mocks.fmcsaChecked).not.toHaveBeenCalled();
    mocks.pick.mockResolvedValue([{ ...company, name: "Services" }]);
    expect(await sweepFmcsaTam(1)).toMatchObject({ skipped: 1, receipts: [{ captured: false, complete: false }] });
  });

  it("preserves partial Colorado entity capture when the UCC lookup fails", async () => {
    mocks.ucc.mockRejectedValue(new Error("timeout"));
    expect(await sweepCoSos(1)).toMatchObject({ partial: 1, succeeded: 0, receipts: [{ captured: true, complete: false, reason: "ucc_lookup_failed" }] });
    expect(mocks.sosChecked).not.toHaveBeenCalled();
    expect(mocks.state).toHaveBeenCalledWith(company.id, "cosos", expect.objectContaining({ complete: false, status: "partial" }));
  });

  it("does not mark skipped Colorado brands or capped lookups complete", async () => {
    mocks.pick.mockResolvedValueOnce([{ ...company, name: "Acme" }]);
    expect(await sweepCoSos(1)).toMatchObject({ skipped: 1, receipts: [{ complete: false, captured: false }] });
    expect(mocks.entities).not.toHaveBeenCalled();
    mocks.entities.mockImplementation(async (_brand, _since, _max, options) => { options.onTruncated(); return []; });
    expect(await sweepCoSos(1)).toMatchObject({ partial: 1, receipts: [{ reason: "result_limit_reached", complete: false }] });
    expect(mocks.sosChecked).not.toHaveBeenCalled();
  });

  it("retains one exact receipt per account and stamps only successful Colorado captures", async () => {
    mocks.pick.mockResolvedValue([{ ...company, id: "good" }, { ...company, id: "bad" }]);
    mocks.entities.mockRejectedValueOnce(new Error("HTTP 429"));
    const result = await sweepCoSos(2);
    expect(result).toMatchObject({ attempted: 2, succeeded: 1, unavailable: 1 });
    expect(result.receipts.map(receipt => receipt.companyId).sort()).toEqual(["bad", "good"]);
    expect(mocks.sosChecked).toHaveBeenCalledTimes(1);
    expect(mocks.sosChecked).toHaveBeenCalledWith(["bad"]);
  });

  it("reports a failed canonical source checkpoint without issuing a completion stamp", async () => {
    mocks.state.mockRejectedValue(new Error("source state write failed"));
    expect(await sweepFmcsaTam(1)).toMatchObject({ failed: 1, receipts: [{ reason: "checkpoint_failed", completionStamped: false }] });
    expect(mocks.fmcsaChecked).not.toHaveBeenCalled();
    expect(await sweepCoSos(1)).toMatchObject({ failed: 1, receipts: [{ reason: "checkpoint_failed", completionStamped: false }] });
    expect(mocks.sosChecked).not.toHaveBeenCalled();
  });
});
