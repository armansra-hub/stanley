import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triggers/urlSafety", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpText: fetch }));
import { parseRegistryFinding } from "./registryProfiles";
import { registryWebsiteText } from "./registryWebsiteText";
import { RegistryWebsiteMismatchError, RegistryWebsiteAvailabilityError, registryWebsiteEvidenceHash, registryWebsiteVerifier, type RegistryWebsiteCorroboration } from "./registryWebsite";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const now = new Date("2026-10-01T00:00:00Z");
const identity = { legalName: "Acme Inc", addressLine1: "123 Main Street", addressLine2: "Suite 4", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" as const };
const company = { name: "Acme Inc", domain: "acme.com" }, context = { aliases: [], addresses: [], context: "PRIVATE CRM CONTEXT" };
const good = "<footer>Acme Inc 123 Main Street Suite 4 Austin TX 78701</footer>";
function item() {
  const sourceRow = { ...identity, usdot_number: "12345" }, evidence = JSON.stringify(sourceRow);
  return parseRegistryFinding({ internalId: "123", companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "registry", kind: "ops_profile", sourceUrl: "https://data.transportation.gov/resource/public.json", evidence,
    registryProfile: { version: 1, dataset: "fmcsa", recordId: "12345", sourceAsOf: null, observedAt: now.toISOString(), identity, facts: [{ field: "usdot_number", value: "12345" }], provenance: { rowSha256: "a".repeat(64), sourceRow, quote: evidence } } }, now);
}
function proof(overrides: Partial<RegistryWebsiteCorroboration> = {}) {
  const { legalName, ...address } = identity, quote = registryWebsiteText(good);
  const data = { sourceUrl: "https://acme.com/", quote, quoteSha256: sha(quote), normalizedVisibleTextSha256: sha(quote), subject: legalName, address, ...overrides };
  const evidenceSha256 = registryWebsiteEvidenceHash(item(), data);
  return { ...data, reader: { taskId: "/test/reader", reviewedAt: now.toISOString(), evidenceSha256 }, reviewer: { taskId: "/test/reviewer", reviewedAt: now.toISOString(), evidenceSha256 } };
}
const page = (body: string, finalUrl = "https://acme.com/") => ({ status: 200, body, finalUrl, contentType: "text/html" });
async function failure(html: string, p = proof()) {
  fetch.mockResolvedValueOnce(page(html));
  const error = await registryWebsiteVerifier()(item(), p, company, context, now).catch(x => x);
  expect(error).toBeInstanceOf(RegistryWebsiteMismatchError);
  return error as RegistryWebsiteMismatchError;
}
beforeEach(() => { fetch.mockReset(); vi.unstubAllEnvs(); });

describe("exact failed website response evidence", () => {
  it("retains the actual complete HTML and normalized text when unrelated visible text changes", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    const html = good + "<p>New announcement &amp; café</p>", p = proof(), error = await failure(html, p), d = error.diagnostic;
    expect(error.message).toBe("registry website changed or exact reviewed quote missing");
    expect(d).toMatchObject({ schema: "registry_website_mismatch_v1", sourceUrl: p.sourceUrl, finalUrl: p.sourceUrl, normalization: "legacy_html_to_visible_text", deploymentCommit: "a".repeat(40), expectedNormalizedVisibleTextSha256: p.normalizedVisibleTextSha256, observedNormalizedVisibleTextSha256: sha(registryWebsiteText(html)), htmlSha256: sha(html), htmlUtf8Bytes: Buffer.byteLength(html), normalizedCharacters: registryWebsiteText(html).length, quotePresent: true, quoteStart: 0, snapshot: { complete: true, rawHtml: html, normalizedText: registryWebsiteText(html) } });
    expect(Number.isFinite(Date.parse(d.fetchedAt))).toBe(true);
    expect(JSON.stringify(d)).not.toContain("PRIVATE CRM CONTEXT");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(p.sourceUrl, expect.objectContaining({ maxBytes: 2_000_000, maxRedirects: 2 }));
  });
  it.each(["123 Main Street", "Suite 4", "Acme Inc"])("still rejects changed identity content: %s", async token => {
    const error = await failure(good.replace(token, "Different value"));
    expect(error.diagnostic.quotePresent).toBe(false); expect(error.diagnostic.quoteStart).toBe(-1);
    expect(error.diagnostic.snapshot.complete).toBe(true);
  });
  it("distinguishes an absent quote even when the expected full-page hash equals the observed hash", async () => {
    const html = good.replace("Suite 4", "Suite 5"), error = await failure(html, proof({ normalizedVisibleTextSha256: sha(registryWebsiteText(html)) }));
    expect(error.diagnostic.expectedNormalizedVisibleTextSha256).toBe(error.diagnostic.observedNormalizedVisibleTextSha256);
    expect(error.diagnostic.quotePresent).toBe(false);
  });
  it.each(["gravity_forms_honeypot_v1", "gravity_forms_honeypot_v2"] as const)("records the actual attested normalizer without changing it: %s", async normalization => {
    const error = await failure(good + " changed", proof({ normalization }));
    expect(error.diagnostic.normalization).toBe(normalization);
    expect(error.diagnostic.observedNormalizedVisibleTextSha256).toBe(sha(registryWebsiteText(good + " changed", normalization)));
  });
  it("caps serialized UTF-8 evidence, including escaped characters, and never supplies a partial body", async () => {
    const html = good + "\\".repeat(550_000); // Each body is below the existing fetch cap; JSON escaping doubles it.
    const d = (await failure(html)).diagnostic;
    expect(d.htmlUtf8Bytes).toBeLessThan(2_000_000);
    expect(d.snapshot).toEqual({ complete: false, omittedReason: "serialized_diagnostic_exceeds_byte_cap" });
    expect(d.htmlSha256).toBe(sha(html)); expect(d.normalizedCharacters).toBe(registryWebsiteText(html).length);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(d.diagnosticByteCap);
  });
  it("does not expose invalid deployment environment values", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "not-a-commit-or-safe-metadata");
    expect((await failure(good + " changed")).diagnostic.deploymentCommit).toBeNull();
  });
  it("keeps exact matching evidence on the unchanged success path", async () => {
    fetch.mockResolvedValueOnce(page(good));
    const result = await registryWebsiteVerifier()(item(), proof(), company, context, now);
    expect(result.method).toBe("official_website_corroboration"); expect(result).not.toHaveProperty("diagnostic");
  });
  it("does not attach a public snapshot when domain safety or fetching fails", async () => {
    fetch.mockResolvedValueOnce(page("unrelated body", "https://other.com/"));
    const wrongHost = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(wrongHost).not.toBeInstanceOf(RegistryWebsiteMismatchError);
    fetch.mockRejectedValueOnce(new Error("transport private error"));
    const unavailable = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(unavailable.message).toBe("registry website source unavailable"); expect(unavailable).toBeInstanceOf(RegistryWebsiteAvailabilityError); expect(unavailable.diagnostic).not.toHaveProperty("snapshot");
  });
});

describe("bounded public fetch availability diagnostics", () => {
  it.each([
    [403, "text/html; charset=utf-8", "http_status", "text/html"],
    [503, null, "http_status", null],
    [302, "text/html", "http_status", "text/html"],
    [200, "application/json; private=SECRET", "content_type", "application/json"],
    [200, "arbitrary PRIVATE value\r\nCookie: SECRET", "content_type", null],
    [200, "text/plain private=SECRET", "content_type", null],
    [200, "text/plain=SECRET", "content_type", null],
    [200, "text plain/json", "content_type", null],
  ])("records response metadata and still rejects status %s with MIME %s", async (status, contentType, errorClass, mime) => {
    fetch.mockResolvedValueOnce({ status, contentType, finalUrl: "https://acme.com/blocked?token=SECRET#PRIVATE", body: "PRIVATE response body" });
    const error = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(error).toBeInstanceOf(RegistryWebsiteAvailabilityError);
    expect(error.message).toBe("registry website full HTML unavailable");
    expect(error.diagnostic).toEqual({ schema: "registry_website_availability_v1", sourceUrl: "https://acme.com/", finalUrl: "https://acme.com/blocked", status, contentType: mime, errorClass });
    expect(JSON.stringify(error.diagnostic)).not.toMatch(/SECRET|PRIVATE|snapshot|headers|body/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://acme.com/", { timeoutMs: 8000, maxBytes: 2_000_000, maxRedirects: 2, accept: "text/html,application/xhtml+xml" });
  });
  it.each([
    [new Error("HTTP fetch timed out"), "timeout"],
    [new Error("HTTP response exceeded size limit"), "size_limit"],
    [new Error("HTTP decoded response exceeded size limit"), "size_limit"],
    [new Error("Unsupported HTTP content encoding"), "content_decoding"],
    [Object.assign(new Error("PRIVATE DNS hostname 10.0.0.1"), { code: "EAI_AGAIN" }), "dns_error"],
    [Object.assign(new Error("PRIVATE certificate"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls_error"],
    [Object.assign(new Error("PRIVATE socket address"), { code: "ECONNRESET" }), "connection_error"],
    [Object.assign(new Error("PRIVATE unsafe host"), { name: "UnsafeHttpTargetError" }), "unsafe_target"],
    [Object.assign(new Error("PRIVATE unknown failure"), { code: "SECRET", diagnostic: { body: "FORGED" } }), "transport_error"],
    ["PRIVATE non-error rejection", "transport_error"],
  ])("classifies a rejected transport without reflecting the error: %s", async (cause, errorClass) => {
    fetch.mockRejectedValueOnce(cause);
    const error = await registryWebsiteVerifier()(item(), proof(), company, context, now).catch(x => x);
    expect(error).toBeInstanceOf(RegistryWebsiteAvailabilityError);
    expect(error.message).toBe("registry website source unavailable");
    expect(error.diagnostic).toEqual({ schema: "registry_website_availability_v1", sourceUrl: "https://acme.com/", finalUrl: null, status: null, contentType: null, errorClass });
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|SECRET|FORGED|10\.0\.0\.1/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["https://user:SECRET@acme.com/", "http://127.0.0.1/private", "file:///private", "https://acme.com/" + "x".repeat(2001)])("omits unsafe or overlong diagnostic URLs: %s", url => {
    const error = new RegistryWebsiteAvailabilityError(url, { page: { ...page("PRIVATE"), status: 403, finalUrl: url } });
    expect(error.diagnostic.sourceUrl).toBeNull(); expect(error.diagnostic.finalUrl).toBeNull();
  });
  it("preserves request-local rejected-page caching without retries", async () => {
    fetch.mockRejectedValueOnce(new Error("HTTP fetch timed out"));
    const verify = registryWebsiteVerifier();
    await expect(verify(item(), proof(), company, context, now)).rejects.toBeInstanceOf(RegistryWebsiteAvailabilityError);
    await expect(verify(item(), proof(), company, context, now)).rejects.toBeInstanceOf(RegistryWebsiteAvailabilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
