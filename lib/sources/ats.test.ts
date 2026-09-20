import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { detectAts, detectAtsResult, fetchAtsJobs, fetchAtsJobsBatch, scanJob } from "./ats";

vi.mock("@/lib/triggers/urlSafety", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(),
  fetchPublicHttpText: vi.fn(),
}));

const guardedFetch = vi.mocked(fetchPublicHttpText);

afterEach(() => vi.clearAllMocks());

function response(body: string, finalUrl = "https://dyadlaw.com/") {
  return { body, finalUrl, status: 200, contentType: "text/html" };
}

describe("Wizehire ATS support", () => {
  it("distinguishes unserved company pages from an observed site with no board", async () => {
    guardedFetch.mockImplementation(async input => ({ ...response("Not found", String(input)), status: 404 }));
    expect((await detectAtsResult("dyadlaw.com")).status).toBe("unavailable");
    guardedFetch.mockImplementation(async input => response("<main>Company services and contact information.</main>", String(input)));
    expect((await detectAtsResult("dyadlaw.com")).status).toBe("none");
  });
  it("reports public career systems outside the supported adapters separately", async () => {
    guardedFetch.mockImplementation(async input => response('<a href="https://acme.bamboohr.com/careers">Careers</a>', String(input)));
    expect(await detectAtsResult("dyadlaw.com")).toMatchObject({ status: "unsupported", unsupportedProvider: "bamboohr.com" });
  });
  it("detects the public jobroll company id", async () => {
    guardedFetch.mockResolvedValue(response(
      '<script src="https://wizehire.com/jobroll/v1/bootstrap/27220/jobroll.js?company_id=27220"></script>',
    ));

    await expect(detectAts("dyadlaw.com")).resolves.toEqual({ type: "wizehire", token: "27220" });
  });

  it("normalizes jobs from the public JSONP feed", async () => {
    guardedFetch.mockResolvedValue(response(
      'wh_cb([{"title":"Legal Secretary","snippet":"Support the legal team","location":"Vista, CA, US","url":"https://jobs.wizehire.com/job/legal-secretary"}]);',
    ));

    await expect(fetchAtsJobs("wizehire", "27220")).resolves.toEqual([{
      title: "Legal Secretary",
      description: "Support the legal team",
      location: "Vista, CA, US",
      url: "https://jobs.wizehire.com/job/legal-secretary",
      date: null,
    }]);
  });

  it("routes company discovery and provider polling through the pinned fetch", async () => {
    guardedFetch.mockImplementation(async (url) => response("<html></html>", String(url)));
    await detectAts("acme.com");
    await fetchAtsJobs("lever", "acme");

    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://acme.com",
      "https://acme.com/careers",
      "https://acme.com/jobs",
      "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=50",
    ]);
  });

  it("fails closed when the guard rejects an unsafe discovery target", async () => {
    guardedFetch.mockRejectedValue(new Error("unsafe HTTP target"));
    await expect(detectAts("127.0.0.1:8080")).resolves.toBeNull();
    expect(guardedFetch).toHaveBeenCalled();
  });

  it("follows a discovered careers page before guessed paths", async () => {
    guardedFetch.mockImplementation(async (url) => response(String(url) === "https://acme.com"
      ? '<a href="/company/careers/open-roles">Join our team</a>'
      : '<iframe src="https://boards.greenhouse.io/acme"></iframe>', String(url)));
    await expect(detectAts("acme.com")).resolves.toEqual({ type: "greenhouse", token: "acme" });
    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual(["https://acme.com", "https://acme.com/company/careers/open-roles"]);
  });

  it("does not bind a board after a cross-company site redirect", async () => {
    guardedFetch.mockResolvedValue(response('<a href="https://jobs.lever.co/foreign">Jobs</a>', "https://foreign.com/careers"));
    await expect(detectAts("acme.com")).resolves.toBeNull();
  });

  it("still tries the careers fallback when the homepage is unavailable", async () => {
    guardedFetch.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(response('<a href="https://jobs.lever.co/acme">Open roles</a>', "https://acme.com/careers"));
    await expect(detectAts("acme.com")).resolves.toEqual({ type: "lever", token: "acme" });
  });
});

describe("bounded ATS coverage", () => {
  const leverJobs = Array.from({ length: 75 }, (_, index) => ({ text: index === 70 ? "Business Systems Analyst" : `Role ${index}`, descriptionPlain: "ERP implementation and project accounting", hostedUrl: `https://jobs.lever.co/acme/${index}`, createdAt: 1_789_603_200_000 }));

  it("finds Lever roles beyond the old first 60 using supported pagination", async () => {
    guardedFetch.mockImplementation(async (raw) => {
      const url = new URL(String(raw));
      const skip = Number(url.searchParams.get("skip"));
      const limit = Number(url.searchParams.get("limit"));
      return response(JSON.stringify(leverJobs.slice(skip, skip + limit)), url.toString());
    });
    const batch = await fetchAtsJobsBatch("lever", "acme", { maxJobs: 100 });
    expect(batch.jobs).toHaveLength(75);
    expect(batch.jobs[70].title).toBe("Business Systems Analyst");
    expect(batch.complete).toBe(true);
    expect(batch.nextOffset).toBeNull();
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a continuation after a later provider failure", async () => {
    guardedFetch.mockResolvedValueOnce(response(JSON.stringify(leverJobs.slice(0, 50)))).mockRejectedValueOnce(new Error("timeout"));
    const batch = await fetchAtsJobsBatch("lever", "acme");
    expect(batch).toMatchObject({ status: "partial", complete: false, nextOffset: 50 });
    expect(batch.jobs).toHaveLength(50);
  });

  it("does not call an unavailable feed complete or interpolate an unsafe token", async () => {
    guardedFetch.mockResolvedValue(response('{"error":"rate limit"}'));
    await expect(fetchAtsJobsBatch("ashby", "acme", { offset: 150 })).resolves.toMatchObject({ status: "unavailable", complete: false, nextOffset: 150 });
    guardedFetch.mockClear();
    await expect(fetchAtsJobsBatch("lever", "../foreign")).resolves.toMatchObject({ status: "unavailable" });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("resumes complete-board feeds at the saved offset without losing later roles", async () => {
    guardedFetch.mockResolvedValue(response(JSON.stringify({ jobs: Array.from({ length: 200 }, (_, index) => ({ title: `Role ${index}`, absolute_url: `https://boards.greenhouse.io/acme/jobs/${index}`, content: "Description", updated_at: "invalid" })) })));
    const batch = await fetchAtsJobsBatch("greenhouse", "acme", { offset: 150, maxJobs: 60 });
    expect(batch.jobs).toHaveLength(50);
    expect(batch.jobs[0]).toMatchObject({ title: "Role 150", date: null });
    expect(batch.complete).toBe(true);
  });

  it("uses SmartRecruiters totalFound and reads bounded operating-role details", async () => {
    guardedFetch.mockImplementation(async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname.endsWith("/42")) return response(JSON.stringify({ id: "42", name: "Business Systems Analyst", jobAd: { sections: { jobDescription: { text: "Own our ERP implementation." } } } }), url.toString());
      return response(JSON.stringify({ totalFound: 51, content: [{ id: "42", name: "Business Systems Analyst", releasedDate: "2026-09-17" }] }), url.toString());
    });
    const batch = await fetchAtsJobsBatch("smartrecruiters", "acme", { offset: 50 });
    expect(batch.complete).toBe(true);
    expect(batch.jobs[0].description).toBe("Own our ERP implementation.");
    expect(String(guardedFetch.mock.calls[0][0])).toContain("offset=50");
  });

  it("stops repeated pages without claiming complete coverage", async () => {
    guardedFetch.mockResolvedValue(response(JSON.stringify(leverJobs.slice(0, 50))));
    const batch = await fetchAtsJobsBatch("lever", "acme", { maxPages: 5 });
    expect(batch).toMatchObject({ nextOffset: 50, complete: false, status: "partial" });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an empty SmartRecruiters page for completion when totalFound advertises a remainder", async () => {
    guardedFetch.mockResolvedValue(response(JSON.stringify({ totalFound: 200, content: [] })));
    await expect(fetchAtsJobsBatch("smartrecruiters", "acme", { offset: 50 })).resolves.toMatchObject({ status: "partial", complete: false, nextOffset: 50 });
  });
});

describe("operating-role evidence", () => {
  it("recognizes process evidence outside finance job titles", () => {
    expect(scanJob("Business Systems Analyst", "Lead ERP implementation and recurring billing integration.")).toMatchObject({ isFinance: false, isOperating: true, isClientPlacement: false, painHits: expect.arrayContaining(["implementing an ERP", "billing operations"]) });
    expect(scanJob("Project Accountant", "Own project accounting and job costing.").painHits).toContain("project accounting / job costing");
  });

  it("keeps client placements from becoming the recruiter's incumbent", () => {
    expect(scanJob("Controller", "Our client is seeking an expert in QuickBooks.")).toMatchObject({ isClientPlacement: true, incumbent: null });
    expect(scanJob("Systems Implementation Consultant", "Implement ERP for our clients using NetSuite.")).toMatchObject({ isClientPlacement: true, incumbent: null });
    expect(scanJob("Account Executive", "Sell ERP systems.").isOperating).toBe(false);
  });
});
