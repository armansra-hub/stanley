import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { detectAts, fetchAtsJobs } from "./ats";

vi.mock("@/lib/triggers/urlSafety", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(),
  fetchPublicHttpText: vi.fn(),
}));

const guardedFetch = vi.mocked(fetchPublicHttpText);

afterEach(() => vi.clearAllMocks());

function response(body: string, finalUrl = "https://public.example/path") {
  return { body, finalUrl, status: 200, contentType: "text/html" };
}

describe("Wizehire ATS support", () => {
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
    guardedFetch.mockResolvedValue(response("<html></html>"));
    await detectAts("acme.com");
    await fetchAtsJobs("lever", "acme");

    expect(guardedFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://acme.com",
      "https://acme.com/careers",
      "https://acme.com/jobs",
      "https://api.lever.co/v0/postings/acme?mode=json",
    ]);
  });

  it("fails closed when the guard rejects an unsafe discovery target", async () => {
    guardedFetch.mockRejectedValue(new Error("unsafe HTTP target"));
    await expect(detectAts("127.0.0.1:8080")).resolves.toBeNull();
    expect(guardedFetch).toHaveBeenCalled();
  });
});
