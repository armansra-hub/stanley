import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAts, fetchAtsJobs } from "./ats";

afterEach(() => vi.unstubAllGlobals());

describe("Wizehire ATS support", () => {
  it("detects the public jobroll company id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<script src="https://wizehire.com/jobroll/v1/bootstrap/27220/jobroll.js?company_id=27220"></script>',
      { status: 200 },
    )));

    await expect(detectAts("dyadlaw.com")).resolves.toEqual({ type: "wizehire", token: "27220" });
  });

  it("normalizes jobs from the public JSONP feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'wh_cb([{"title":"Legal Secretary","snippet":"Support the legal team","location":"Vista, CA, US","url":"https://jobs.wizehire.com/job/legal-secretary"}]);',
      { status: 200 },
    )));

    await expect(fetchAtsJobs("wizehire", "27220")).resolves.toEqual([{
      title: "Legal Secretary",
      description: "Support the legal team",
      location: "Vista, CA, US",
      url: "https://jobs.wizehire.com/job/legal-secretary",
      date: null,
    }]);
  });
});
