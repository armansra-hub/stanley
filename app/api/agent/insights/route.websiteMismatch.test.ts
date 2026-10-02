import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: vi.fn(), fetch: vi.fn(), identity: vi.fn(), log: vi.fn(), trigger: vi.fn(), priority: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: m.auth, callerAgent: () => "test", unauthorized: () => new Response("denied", { status: 401 }) }));
vi.mock("@/lib/companyIdentity", () => ({ loadCompanyIdentityContext: m.identity }));
vi.mock("@/lib/db/events", () => ({ logEvent: m.log }));
vi.mock("@/lib/db/triggers", () => ({ recordTrigger: m.trigger, recomputePriority: m.priority }));
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: m.fetch }));
import { parseRegistryFinding } from "@/lib/agent/registryProfiles";
import { registryWebsiteEvidenceHash } from "@/lib/agent/registryWebsite";
import { POST } from "./route";

const sha = (x: string) => createHash("sha256").update(x).digest("hex"), companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const quote = "Acme Inc 123 Main St Austin TX 78701", html = `<footer>${quote}</footer>`;
function finding(id = "777", url = "https://acme.com/") {
  const identity = { legalName: "Acme Inc", addressLine1: "123 Main St", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const }, sourceRow = { ...identity, usdot_number: id }, evidence = JSON.stringify(sourceRow);
  const item = { internalId: "123", companyId, source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: id, sourceAsOf: null, observedAt: "2026-09-01T00:00:00Z", identity, facts: [{ field: "usdot_number", value: id }], provenance: { rowSha256: "a".repeat(64), sourceRow, quote: evidence } } };
  const { legalName, ...address } = identity, proof = { sourceUrl: url, quote, quoteSha256: sha(quote), normalizedVisibleTextSha256: sha(quote), subject: legalName, address }, evidenceSha256 = registryWebsiteEvidenceHash(parseRegistryFinding(item), proof), reviewedAt = new Date().toISOString();
  return { ...item, officialWebsiteCorroboration: { ...proof, reader: { taskId: "/test/reader", reviewedAt, evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt, evidenceSha256 } } };
}
const post = (body: unknown) => POST(new Request("https://example.test/api/agent/insights", { method: "POST", headers: { Authorization: "Bearer SECRET_REQUEST_HEADER" }, body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks(); m.auth.mockReturnValue(true);
  m.identity.mockResolvedValue({ aliases: [], addresses: [], context: "PRIVATE CRM CONTEXT" });
  m.from.mockImplementation((table: string) => {
    const data = table === "companies" ? [{ id: companyId, netsuite_internal_id: "123", name: "Acme Inc", domain: "acme.com", lists: [] }] : [];
    const q = { select: () => q, in: () => q, eq: () => q, then: (resolve: (x: unknown) => void) => resolve({ data, error: null }) }; return q;
  });
  m.fetch.mockImplementation(async (url: string) => ({ status: 200, finalUrl: url, body: html + " changed", contentType: "text/html" }));
});
describe("authenticated website mismatch response without publication", () => {
  it.each([true, false])("returns the exact failed server snapshot while dryRun=%s writes nothing", async dryRun => {
    const response = await post({ findings: [finding()], dryRun }), body = await response.json();
    expect(response.status).toBe(422); expect(body).toMatchObject({ internalId: "123", profileKey: "registry:fmcsa:777", error: "registry website changed or exact reviewed quote missing", websiteMismatch: { quotePresent: true, snapshot: { complete: true, rawHtml: html + " changed", normalizedText: quote + " changed" } } });
    expect(m.fetch).toHaveBeenCalledTimes(1); expect(m.rpc).not.toHaveBeenCalled(); expect(m.trigger).not.toHaveBeenCalled(); expect(m.priority).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("SECRET_REQUEST_HEADER"); expect(JSON.stringify(body)).not.toContain("PRIVATE CRM CONTEXT");
  });
  it("still performs no batch write if a later profile fails after the first verifies", async () => {
    m.fetch.mockResolvedValueOnce({ status: 200, finalUrl: "https://acme.com/one", body: html, contentType: "text/html" });
    const response = await post({ findings: [finding("777", "https://acme.com/one"), finding("778", "https://acme.com/two")] });
    expect(response.status).toBe(422); expect((await response.json()).profileKey).toBe("registry:fmcsa:778");
    expect(m.fetch).toHaveBeenCalledTimes(2); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated callers before database/fetch and returns no source evidence", async () => {
    m.auth.mockReturnValue(false); const response = await post({ findings: [finding()] });
    expect(response.status).toBe(401); expect(await response.text()).toBe("denied"); expect(m.fetch).not.toHaveBeenCalled(); expect(m.from).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("ignores caller-supplied diagnostics and does not serialize generic transport error properties", async () => {
    m.fetch.mockRejectedValueOnce(Object.assign(new Error("private transport message"), { diagnostic: { rawHtml: "FORGED" } }));
    const response = await post({ findings: [finding()], websiteMismatch: { rawHtml: "FORGED" } }), body = await response.json();
    expect(response.status).toBe(422); expect(body).toMatchObject({ error: "registry website source unavailable", internalId: "123", profileKey: "registry:fmcsa:777", websiteAvailability: { errorClass: "transport_error", finalUrl: null, status: null, contentType: null } }); expect(JSON.stringify(body)).not.toMatch(/FORGED|private transport message|SECRET_REQUEST_HEADER|PRIVATE CRM CONTEXT/); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("leaves a matching dryrun response unchanged", async () => {
    m.fetch.mockResolvedValueOnce({ status: 200, finalUrl: "https://acme.com/", body: html, contentType: "text/html" });
    const response = await post({ findings: [finding()], dryRun: true }), body = await response.json();
    expect(response.status).toBe(200); expect(body.wouldWriteInsights).toBe(1); expect(body).not.toHaveProperty("websiteMismatch"); expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("authenticated availability rejection metadata", () => {
  it.each([true, false])("returns sanitized HTTP metadata and never writes with dryRun=%s", async dryRun => {
    m.fetch.mockResolvedValueOnce({ status: 403, finalUrl: "https://acme.com/access?token=SECRET", contentType: "text/html; private=SECRET", body: "PRIVATE body" });
    const response = await post({ findings: [finding()], dryRun }), body = await response.json();
    expect(response.status).toBe(422);
    expect(body).toEqual({ error: "registry website full HTML unavailable", internalId: "123", profileKey: "registry:fmcsa:777", websiteAvailability: { schema: "registry_website_availability_v1", sourceUrl: "https://acme.com/", finalUrl: "https://acme.com/access", status: 403, contentType: "text/html", errorClass: "http_status" } });
    expect(m.rpc).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled(); expect(m.trigger).not.toHaveBeenCalled(); expect(m.priority).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|SECRET|snapshot/); expect(m.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects the whole batch if the second exact page is unavailable", async () => {
    m.fetch.mockResolvedValueOnce({ status: 200, finalUrl: "https://acme.com/one", body: html, contentType: "text/html" });
    m.fetch.mockResolvedValueOnce({ status: 200, finalUrl: "https://acme.com/two", body: "PRIVATE JSON", contentType: "application/json" });
    const response = await post({ findings: [finding("777", "https://acme.com/one"), finding("778", "https://acme.com/two")] });
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ profileKey: "registry:fmcsa:778", websiteAvailability: { status: 200, errorClass: "content_type", contentType: "application/json" } });
    expect(m.fetch).toHaveBeenCalledTimes(2); expect(m.rpc).not.toHaveBeenCalled();
  });
});
