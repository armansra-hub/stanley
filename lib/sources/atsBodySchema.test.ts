import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validatedAtsBody } from "./atsBodySchema";
import { fetchAtsJobsBatch } from "./ats";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: vi.fn() }));
const fixtures: [string, Record<string, unknown>, string][] = [
  ["greenhouse", { id: 1, title: "Controller", absolute_url: "https://example.com/job", content: "<p>Full duties</p>" }, "content"],
  ["ashby", { id: "1", title: "Controller", jobUrl: "https://example.com/job", descriptionHtml: "<p>Full duties</p>" }, "descriptionHtml"],
  ["recruitee", { id: "1", title: "Controller", careers_url: "https://example.com/job", description: "Full duties" }, "description"],
  ["workable", { shortcode: "1", title: "Controller", url: "https://example.com/job", description: "Full duties" }, "description"],
  ["lever", { id: "1", text: "Controller", hostedUrl: "https://example.com/job", descriptionPlain: "Full duties", lists: [{ text: "Required", content: "Accounting" }] }, "descriptionPlain"],
  ["smartrecruiters", { id: "1", name: "Controller", jobAd: { sections: { jobDescription: { text: "Full duties" } } } }, "jobAd"],
];
describe("ATS original-body schema provenance", () => {
  it.each(fixtures)("validates original %s strings before normalization", (type, row) => {
    expect(validatedAtsBody(type, row)).toMatchObject({ bodySchemaValidated: true });
    expect(validatedAtsBody(type, row).description).toContain("Full duties");
  });
  it.each(fixtures)("rejects malformed and missing %s body fields", (type, row, key) => {
    for (const value of [{ malformed: true }, ["text"], 42, true, null, undefined]) {
      expect(validatedAtsBody(type, { ...row, [key]: value })).toEqual({ description: "", bodySchemaValidated: false });
    }
  });
  it("rejects malformed Lever list sections and optional additional text", () => {
    const row = fixtures[4][1];
    for (const lists of [{ text: "bad" }, [{ text: {}, content: "good" }], [{ text: "good", content: ["bad"] }]])
      expect(validatedAtsBody("lever", { ...row, lists }).bodySchemaValidated).toBe(false);
    expect(validatedAtsBody("lever", { ...row, additionalPlain: {} }).bodySchemaValidated).toBe(false);
  });
  it("rejects malformed SmartRecruiters nested sections and identity primitives", () => {
    expect(validatedAtsBody("smartrecruiters", { ...fixtures[5][1], jobAd: { sections: { one: { text: {} } } } }).bodySchemaValidated).toBe(false);
    for (const changes of [{ title: {} }, { absolute_url: {} }, { id: {} }])
      expect(validatedAtsBody("greenhouse", { ...fixtures[0][1], ...changes }).bodySchemaValidated).toBe(false);
  });
  it("does not launder object content through the actual Greenhouse adapter", async () => {
    vi.mocked(fetchPublicHttpText).mockResolvedValue({ body: JSON.stringify({ jobs: [{ ...fixtures[0][1], content: { malformed: true } }] }),
      status: 200, finalUrl: "https://boards-api.greenhouse.io/v1/boards/example/jobs", contentType: "application/json" });
    const batch = await fetchAtsJobsBatch("greenhouse", "example");
    expect(batch.jobs[0]).toMatchObject({ description: "", bodySchemaValidated: false });
    expect(JSON.stringify(batch)).not.toContain("[object Object]");
  });
  it("requires matching provenance in the SQL publication gate without changing default news selection", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/0143_codex_source_review.sql", import.meta.url), "utf8");
    expect(sql).toContain("o.metadata->'bodySchemaValidated' is distinct from 'true'::jsonb");
    expect(sql).toContain("o.metadata->>'bodySchemaVersion' is distinct from 'ats-body-schema-v1'");
    expect(sql).toContain("coalesce(p_payload->>'sourceKind','news')");
  });
  it("keeps validated SmartRecruiters detail identity together with its body", async () => {
    vi.mocked(fetchPublicHttpText).mockImplementation(async url => ({
      body: JSON.stringify(String(url).includes("/postings/1")
        ? { id: "1", name: "Senior Controller", location: { city: "Novi" }, releasedDate: "2026-10-06", jobAd: { sections: { jobDescription: { text: "Full duties" } } } }
        : { totalFound: 1, content: [{ id: "1", name: "Controller", location: { city: { malformed: true } }, releasedDate: ["2026-10-01"] }] }),
      status: 200, finalUrl: String(url), contentType: "application/json",
    }));
    const batch = await fetchAtsJobsBatch("smartrecruiters", "example");
    expect(batch.jobs[0]).toMatchObject({ title: "Senior Controller", description: "Full duties", location: "Novi", date: "2026-10-06T00:00:00.000Z", bodySchemaValidated: true });
  });
  it("does not upgrade a malformed SmartRecruiters listing title and leaves malformed provenance unknown", async () => {
    vi.mocked(fetchPublicHttpText).mockResolvedValue({
      body: JSON.stringify({ totalFound: 2, content: [{ id: "1", name: { malformed: true } }, { id: "2", name: "Cook", location: { city: ["Novi"] }, releasedDate: ["2026-10-01"] }] }),
      status: 200, finalUrl: "https://api.smartrecruiters.com/v1/companies/example/postings", contentType: "application/json",
    });
    const batch = await fetchAtsJobsBatch("smartrecruiters", "example");
    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]).toMatchObject({ id: "2", title: "Cook", description: "", location: "", date: null, bodySchemaValidated: false });
    expect(JSON.stringify(batch)).not.toContain("[object Object]");
  });
});
