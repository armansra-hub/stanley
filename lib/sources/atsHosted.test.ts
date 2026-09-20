import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { detectAtsResult, fetchAtsJobsBatch } from "./ats";
import { hostedJobDetail, parseHostedListings } from "./atsHosted";
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: vi.fn() }));
const fetch = vi.mocked(fetchPublicHttpText);
afterEach(() => fetch.mockReset());
const response = (body: string, url: string, status = 200) => ({ status, body, finalUrl: url, contentType: "text/html" });
describe("observed public hosted ATS collectors", () => {
  it.each([
    ["jazzhr", "https://acme.applytojob.com/apply/jobs/"],
    ["jobvite", "https://jobs.jobvite.com/acme/"],
  ] as const)("detects %s only from an actual hosted URL", async (type, url) => {
    fetch.mockImplementation(async input => response(`<a href="${url}">Careers</a>`, String(input)));
    expect(await detectAtsResult("acme.com")).toMatchObject({ status: "detected", board: { type, token: "acme" } });
  });
  it("deduplicates JazzHR details links without following another tenant or form endpoints", () => {
    const jobs = parseHostedListings('<a href="/apply/jobs/details/AbCdEf1234?x=1&">Controller</a><a href="/apply/jobs/details/AbCdEf1234">Controller</a><a href="https://foreign.applytojob.com/apply/jobs/details/Other12345">Wrong account</a><a href="/apply/jobs/">Jobs</a>', "jazzhr", "acme");
    expect(jobs).toEqual([{ id: "AbCdEf1234", title: "Controller", url: "https://acme.applytojob.com/apply/jobs/details/AbCdEf1234", description: "", location: "", date: null }]);
  });
  it("binds a single JobPosting description to the exact listing title and preserves unknown dates", () => {
    const job = { title: "Controller", url: "https://acme.applytojob.com/apply/jobs/details/AbCdEf1234", description: "", location: "", date: null };
    const schema = { "@type": "JobPosting", title: "Controller", description: "<p>Own recurring billing and our ERP implementation.</p>", datePosted: "invalid", jobLocation: { address: { addressLocality: "Denver", addressRegion: "CO" } } };
    expect(hostedJobDetail(`<script type="application/ld+json">${JSON.stringify(schema)}</script>`, job)).toMatchObject({ date: null, location: "Denver, CO", description: "Own recurring billing and our ERP implementation." });
    expect(hostedJobDetail(`<script type="application/ld+json">${JSON.stringify({ ...schema, title: "Unrelated job" })}</script>`, job)).toBeNull();
  });
  it("resumes stable full-board listings and refuses to call an unknown page an empty board", async () => {
    fetch.mockImplementation(async url => response('<a href="/acme/job/one">Designer</a><a href="/acme/job/two">Editor</a><a href="/acme/job/three">Writer</a>', String(url)));
    const first = await fetchAtsJobsBatch("jobvite", "acme", { maxJobs: 2 });
    expect(first).toMatchObject({ status: "partial", nextOffset: 2, expectedTotal: 3 });
    const final = await fetchAtsJobsBatch("jobvite", "acme", { offset: 2, maxJobs: 2 });
    expect(final).toMatchObject({ status: "complete", nextOffset: null, expectedTotal: 3, snapshotKey: first.snapshotKey });
    fetch.mockImplementation(async url => response('<h1>Service temporarily unavailable</h1>', String(url)));
    expect(await fetchAtsJobsBatch("jobvite", "acme")).toMatchObject({ status: "unavailable", complete: false });
  });
  it("reads bounded descriptions, but unknown pagination cannot expire the rest of the board", async () => {
    fetch.mockImplementation(async url => response(String(url).includes("/job/")
      ? '<script type="application/ld+json">{"@type":"JobPosting","title":"Controller","description":"Manage our billing operations.","datePosted":"2026-09-18"}</script>'
      : '<a href="/acme/job/one">Controller</a><a rel="next" href="?page=2">Next</a>', String(url)));
    expect(await fetchAtsJobsBatch("jobvite", "acme")).toMatchObject({ status: "partial", complete: false, coverageKind: "hosted_board_pagination_unresolved", descriptionsFetched: 1,
      jobs: [expect.objectContaining({ description: "Manage our billing operations.", date: "2026-09-18T00:00:00.000Z" })] });
  });
});
