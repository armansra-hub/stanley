import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepAts } from "./atsSweep";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(), checked: vi.fn(), flags: vi.fn(), trigger: vi.fn(), priority: vi.fn(),
  detect: vi.fn(), fetch: vi.fn(), enqueue: vi.fn(), read: vi.fn(), write: vi.fn(),
}));
vi.mock("@/lib/db/triggers", () => ({ pickAtsForRotation: mocks.pick, setAtsChecked: mocks.checked, setErpFlags: mocks.flags, recordTrigger: mocks.trigger, recomputePriority: mocks.priority }));
vi.mock("@/lib/sources/ats", async (original) => ({ ...await original<typeof import("@/lib/sources/ats")>(), detectAts: mocks.detect, fetchAtsJobsBatch: mocks.fetch }));
vi.mock("@/lib/intelligence/observations", () => ({ enqueueObservation: mocks.enqueue }));
vi.mock("@/lib/intelligence/sourceState", () => ({ readSourceState: mocks.read, writeSourceState: mocks.write }));
vi.mock("./rotationBatches", () => ({ rotationBatches: async function* (load: (size: number) => Promise<unknown[]>) { yield await load(12); } }));

const company = { id: "company-1", name: "Acme Logistics", domain: "acme.com", ats_type: "lever", ats_token: "acme", record_dead: false, description: null, subindustry: null, ns_industry: null };
const job = { title: "Business Systems Analyst", description: "Lead our ERP implementation and recurring billing.", url: "https://jobs.lever.co/acme/job-71", location: "Denver", date: "2026-09-17T00:00:00.000Z" };

beforeEach(() => {
  vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "true");
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.pick.mockResolvedValue([company]);
  mocks.checked.mockResolvedValue(undefined);
  mocks.flags.mockResolvedValue(undefined);
  mocks.trigger.mockResolvedValue(true);
  mocks.priority.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue({ jobs: [job], nextOffset: null, complete: true, status: "complete" });
  mocks.enqueue.mockResolvedValue({ id: "observation-1", queued: true });
  mocks.read.mockResolvedValue({ cursor: null, lastSuccessAt: null });
  mocks.write.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("ATS collection integration", () => {
  it("redetects a stored none on its next fair rotation", async () => {
    mocks.pick.mockResolvedValue([{ ...company, ats_type: "none", ats_token: null }]);
    mocks.detect.mockResolvedValue({ type: "lever", token: "acme" });
    expect((await sweepAts(1)).detected).toBe(1);
    expect(mocks.detect).toHaveBeenCalledWith("acme.com");
    expect(mocks.checked).toHaveBeenCalledWith("company-1", { ats_type: "lever", ats_token: "acme" });
    expect(mocks.fetch).toHaveBeenCalled();
  });

  it("resumes the stored offset and saves continuation only after evidence storage", async () => {
    mocks.read.mockResolvedValue({ cursor: { offset: 150 }, lastSuccessAt: null });
    mocks.fetch.mockResolvedValue({ jobs: [job], nextOffset: 300, complete: false, status: "partial" });
    await sweepAts(1);
    expect(mocks.fetch).toHaveBeenCalledWith("lever", "acme", { offset: 150, maxJobs: 150 });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "job", sourceUrl: job.url, eventDate: job.date }));
    expect(mocks.write).toHaveBeenCalledWith("company-1", "ats:lever:acme", { cursor: { offset: 300 }, complete: false });
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[0]);
    // The broader operating role receives semantic interpretation, not a regex
    // trigger or an unsupported persistent incumbent update.
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.flags).not.toHaveBeenCalled();
  });

  it("does not advance continuation when enabled observation storage fails", async () => {
    mocks.enqueue.mockRejectedValue(new Error("storage unavailable"));
    await sweepAts(1);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.checked).toHaveBeenCalledWith("company-1", {});
  });

  it("retains the prior offset and records a provider failure as incomplete", async () => {
    mocks.read.mockResolvedValue({ cursor: { offset: 150 }, lastSuccessAt: null });
    mocks.fetch.mockResolvedValue({ jobs: [], nextOffset: 150, complete: false, status: "unavailable" });
    await sweepAts(1);
    expect(mocks.write).toHaveBeenCalledWith("company-1", "ats:lever:acme", expect.objectContaining({ cursor: { offset: 150 }, complete: false, error: expect.any(String) }));
  });

  it("retains client-placement attribution without assigning its systems to the recruiter", async () => {
    mocks.fetch.mockResolvedValue({ jobs: [{ ...job, title: "Controller", description: "Our client uses QuickBooks and needs a controller." }], nextOffset: null, complete: true, status: "complete" });
    await sweepAts(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ isClientPlacement: true }) }));
    expect(mocks.flags).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("does not call the new storage lane when the feature is disabled", async () => {
    vi.stubEnv("STANLEY_INTELLIGENCE_ENABLED", "false");
    mocks.fetch.mockResolvedValue({ jobs: [{ ...job, title: "Controller" }], nextOffset: null, complete: true, status: "complete" });
    await sweepAts(1);
    expect(mocks.fetch).toHaveBeenCalledWith("lever", "acme", { offset: 0, maxJobs: 60 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.trigger).toHaveBeenCalled();
  });
});
