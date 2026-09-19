import { describe, expect, it, vi } from "vitest";
import { atsBoardSourceUrl, atsHiringPattern, atsJobIdentity, atsRoleCategories, prepareAtsJob, type AtsScanSummary } from "./atsLifecycle";
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));

const job = { id: "provider-42", title: "Business Systems Analyst", description: "Own our ERP implementation, billing and project accounting.", location: "Denver", url: "https://jobs.lever.co/acme/42?utm_source=site", date: "2026-09-17T00:00:00Z" };
const summary: AtsScanSummary = { baseline: false, openJobs: 8, newJobs: 3, changedJobs: 1, reopenedJobs: 0, expiredJobs: 1,
  roleCounts: { business_systems: 3, billing: 2 }, changes: [], changesTruncated: false,
  previousCompleteAt: "2026-09-15T00:00:00Z", completedAt: "2026-09-17T00:00:00Z", intervalDays: 2,
  newListingsPerDay: 1.5, paceBasis: "complete scan observations", newOperatingJobs: 3,
  newOperatingRoleCounts: { business_systems: 3, billing: 2 } };

describe("ATS job identity and semantic-neutral changes", () => {
  it("uses native identity across a title or URL edit and isolates boards", () => {
    expect(atsJobIdentity("ats:lever:acme", job)).toBe(atsJobIdentity("ats:lever:acme", { ...job, title: "Senior Analyst", url: "https://jobs.lever.co/acme/42-renamed" }));
    expect(atsJobIdentity("ats:lever:other", job)).not.toBe(atsJobIdentity("ats:lever:acme", job));
    expect(atsJobIdentity("ats:lever:acme", { ...job, id: undefined })).toBe(atsJobIdentity("ats:lever:acme", { ...job, id: undefined, url: "https://jobs.lever.co/acme/42" }));
  });
  it("ignores source timestamp/cosmetic changes but detects meaningful JD edits", () => {
    const prepared = prepareAtsJob("ats:lever:acme", job);
    expect(prepareAtsJob("ats:lever:acme", { ...job, date: "2026-09-18", description: `  ${job.description}\n` }).content_hash).toBe(prepared.content_hash);
    expect(prepareAtsJob("ats:lever:acme", { ...job, description: "A new operating responsibility" }).content_hash).not.toBe(prepared.content_hash);
  });
  it("does not turn a missing description into a content change or lose placement attribution", () => {
    const prepared = prepareAtsJob("ats:lever:acme", { ...job, description: "Our client is seeking an ERP implementer." });
    const known = { ...prepared, client_placement: true, categories: [] };
    const missing = prepareAtsJob("ats:lever:acme", { ...job, description: "" }, known);
    expect(missing.content_hash).toBe(prepared.content_hash);
    expect(missing.client_placement).toBe(true);
    expect(missing.categories).toEqual([]);
  });
  it("supports overlapping operating roles and separates recruiter delivery work", () => {
    expect(atsRoleCategories(job)).toEqual(expect.arrayContaining(["business_systems", "implementation", "billing", "project_accounting"]));
    expect(atsRoleCategories({ ...job, title: "Controller", description: "On behalf of our client" })).toEqual([]);
    expect(atsRoleCategories({ ...job, title: "Account Executive", description: "Sell ERP implementations" })).toEqual([]);
  });
});

describe("ATS complete-scan patterns", () => {
  it("never presents an initial baseline as newly increased hiring", () => {
    expect(atsHiringPattern({ ...summary, baseline: true })).toBeNull();
    expect(atsHiringPattern({ ...summary, previousCompleteAt: null })).toBeNull();
  });
  it("emits contextual multi-role clusters without claiming completed hires", () => {
    const pattern = atsHiringPattern(summary);
    expect(pattern?.title).toBe("New operating-role hiring cluster");
    expect(pattern?.text).toContain("not confirmed hires");
    expect(pattern?.text).toContain("2026-09-15T00:00:00Z");
  });
  it("requires either a multi-role cluster or an actual comparable pace increase", () => {
    expect(atsHiringPattern({ ...summary, newOperatingJobs: 1, newOperatingRoleCounts: { finance: 1 } })).toBeNull();
    expect(atsHiringPattern({ ...summary, newOperatingJobs: 0, previousListingsPerDay: .5, paceChangeRatio: 3 })?.title).toBe("Public job-listing pace increased");
  });
  it("links the actual polled board endpoint rather than a made-up job URL", () => {
    expect(atsBoardSourceUrl("lever", "acme")).toBe("https://api.lever.co/v0/postings/acme?mode=json");
    expect(() => atsBoardSourceUrl("lever", "../other")).toThrow();
  });
});
